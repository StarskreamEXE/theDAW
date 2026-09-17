/**
 * A piece of the page as it is drawn, taken out of the app.
 *
 * The annotated lyric sheet is DOM text with an SVG wire layer over it, so no
 * single <svg> holds the picture and nothing in the app can serialise it the
 * way the rhyme web serialises itself. This takes a snapshot instead: the
 * subtree is cloned, every element's computed style is written onto it as an
 * inline style, the fonts the app declares are embedded as data URIs, and the
 * result is wrapped either as a standalone HTML page or as an SVG whose
 * <foreignObject> holds the markup. The SVG form is what the PNG is drawn
 * from: Chromium renders a self-contained foreignObject into a canvas.
 *
 * Interactive state is kept, static: hover titles on the wires stay as
 * <title> elements, the selected finding keeps its highlight, and a marked
 * word keeps its mark. Buttons are left as buttons so their text is drawn
 * where it was; nothing in the file runs.
 */

/** The properties copied onto each element. Layout properties are copied as
 *  their used values, so the snapshot is the page at the width it was taken. */
const COPIED = [
  'display',
  'position',
  'top',
  'left',
  'right',
  'bottom',
  'inset',
  'z-index',
  'box-sizing',
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'margin',
  'padding',
  'border',
  'border-radius',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'outline',
  'outline-offset',
  'background',
  'background-color',
  'background-image',
  'background-clip',
  'color',
  'opacity',
  'visibility',
  'overflow',
  'overflow-wrap',
  'white-space',
  'word-break',
  'font',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-variant-numeric',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-transform',
  'text-decoration',
  'text-shadow',
  'text-overflow',
  'vertical-align',
  'flex',
  'flex-direction',
  'flex-wrap',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'align-items',
  'align-self',
  'justify-content',
  'gap',
  'grid-template-columns',
  'grid-template-rows',
  'grid-column',
  'grid-row',
  'transform',
  'transform-origin',
  'cursor',
  'pointer-events',
  'list-style',
  '-webkit-text-fill-color',
  '-webkit-background-clip',
  'container-type',
] as const;

/** Presentation properties that matter on SVG content; SVG attributes on the
 *  elements themselves are copied by the clone. */
const SVG_COPIED = ['fill', 'stroke', 'stroke-width', 'stroke-opacity', 'fill-opacity', 'opacity', 'stroke-dasharray', 'stroke-linecap', 'pointer-events', 'overflow'] as const;

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO']);

const isSvg = (el: Element): boolean => el.namespaceURI === 'http://www.w3.org/2000/svg';

/** Walk the source and its clone in step, writing the source's computed style
 *  onto the clone. `--*` custom properties are not enumerated by
 *  getComputedStyle, so the ones the sheet reads are resolved into the used
 *  values of the properties that consume them. */
const inlineStyles = (source: Element, clone: Element): void => {
  const cs = getComputedStyle(source);
  const style = (clone as HTMLElement | SVGElement).style;
  if (!style) return;
  const props = isSvg(source) ? SVG_COPIED : COPIED;
  for (const p of props) {
    const v = cs.getPropertyValue(p);
    if (v) style.setProperty(p, v);
  }
  if (!isSvg(source)) {
    // ::before and ::after are drawn from CSS the file will not carry; the
    // sheet uses them for the rhyme-lane brackets, so they become real nodes.
    for (const pseudo of ['::before', '::after'] as const) {
      const ps = getComputedStyle(source, pseudo);
      const content = ps.getPropertyValue('content');
      if (!content || content === 'none' || content === 'normal') continue;
      const node = document.createElement('span');
      node.setAttribute('data-pseudo', pseudo.slice(2));
      const text = content.replace(/^["']|["']$/g, '');
      if (text && text !== 'counter' && !text.startsWith('url(')) node.textContent = text;
      for (const p of COPIED) {
        const v = ps.getPropertyValue(p);
        if (v) node.style.setProperty(p, v);
      }
      if (pseudo === '::before') clone.insertBefore(node, clone.firstChild);
      else clone.appendChild(node);
    }
  }
  const sourceKids = Array.from(source.children);
  const cloneKids = Array.from(clone.children).filter((c) => !(c as HTMLElement).dataset?.pseudo);
  for (let i = 0; i < sourceKids.length && i < cloneKids.length; i += 1) {
    inlineStyles(sourceKids[i], cloneKids[i]);
  }
};

const stripLive = (root: Element): void => {
  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (SKIP_TAGS.has(el.tagName)) {
      el.remove();
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith('on') || attr.name === 'tabindex' || attr.name === 'contenteditable') {
        el.removeAttribute(attr.name);
      }
    }
    if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) el.disabled = true;
  }
};

const toBase64 = (buf: ArrayBuffer): string => {
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
};

const fontMime = (url: string): string => {
  const u = url.toLowerCase().split('?')[0];
  if (u.endsWith('.woff2')) return 'font/woff2';
  if (u.endsWith('.woff')) return 'font/woff';
  if (u.endsWith('.otf')) return 'font/otf';
  return 'font/ttf';
};

let fontCssPromise: Promise<string> | null = null;

/** Every @font-face the app declares, with its files embedded as data URIs,
 *  so a snapshot draws in the app's faces wherever it is opened. Fetched once
 *  per session. A stylesheet or file that cannot be read is left out, and the
 *  snapshot falls back to the next family in the stack. */
export const embeddedFontCss = (): Promise<string> => {
  if (fontCssPromise) return fontCssPromise;
  fontCssPromise = (async () => {
    const out: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of Array.from(rules)) {
        if (!(rule instanceof CSSFontFaceRule)) continue;
        const src = rule.style.getPropertyValue('src');
        const m = /url\(["']?([^"')]+)["']?\)/.exec(src);
        if (!m) continue;
        try {
          const url = new URL(m[1], sheet.href ?? location.href).href;
          const res = await fetch(url);
          if (!res.ok) continue;
          const data = toBase64(await res.arrayBuffer());
          const text = rule.cssText.replace(
            /src:[^;]+;/,
            `src: url(data:${fontMime(url)};base64,${data});`,
          );
          out.push(text);
        } catch {
          /* left out */
        }
      }
    }
    return out.join('\n');
  })();
  return fontCssPromise;
};

export interface DomSnapshot {
  /** The subtree as XHTML with every style inline. */
  markup: string;
  width: number;
  height: number;
  /** The @font-face rules the markup relies on. */
  fontCss: string;
  background: string;
}

const nearestBackground = (el: Element): string => {
  let node: Element | null = el;
  while (node) {
    const bg = getComputedStyle(node).backgroundColor;
    if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
    node = node.parentElement;
  }
  return '#07050a';
};

/** Take the snapshot of `host` as it is drawn now. */
export const snapshotElement = async (host: HTMLElement): Promise<DomSnapshot> => {
  const clone = host.cloneNode(true) as HTMLElement;
  inlineStyles(host, clone);
  stripLive(clone);
  // The host is placed by the file's own page, so its own offset goes.
  clone.style.position = 'relative';
  clone.style.top = '0';
  clone.style.left = '0';
  clone.style.margin = '0';
  clone.style.transform = 'none';
  clone.style.width = `${host.clientWidth}px`;
  clone.style.height = `${host.scrollHeight}px`;
  clone.style.overflow = 'visible';
  const markup = new XMLSerializer().serializeToString(clone);
  return {
    markup,
    width: host.clientWidth,
    height: host.scrollHeight,
    fontCss: await embeddedFontCss(),
    background: nearestBackground(host),
  };
};

/** The snapshot as an SVG: the markup inside a <foreignObject>, the fonts in a
 *  <style>, the background painted first. Self-contained, so an <img> can
 *  draw it onto a canvas. */
export const snapshotSvg = (snap: DomSnapshot): string => {
  const { width, height } = snap;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<style>${snap.fontCss}</style>` +
    `<rect width="${width}" height="${height}" fill="${snap.background}"/>` +
    `<foreignObject x="0" y="0" width="${width}" height="${height}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px;height:${height}px;background:${snap.background}">${snap.markup}</div>` +
    `</foreignObject></svg>`
  );
};
