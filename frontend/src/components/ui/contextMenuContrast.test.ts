// Run with: npx tsx src/components/ui/contextMenuContrast.test.ts
/**
 * The shared ContextMenu's non-interactive text reads on every theme.
 *
 * The title row ("TIMELINE · 00:05.00"), a header row ("ADD TO MIRACLE MILE")
 * and the right-aligned hint ("nothing copied", "new track") are 8px text, so
 * WCAG 2.1 AA asks 4.5:1 against the menu surface. They were `text-zinc-600`
 * in a menu portaled to <body>, outside every `.edit-theme-scope`, so no theme
 * reached them: #52525c on #0a080f is 2.58:1 in all 28 themes, and the hint on
 * a disabled row, dimmed with the whole row, was 1.32:1.
 *
 * The menu is rendered in jsdom once per theme. Each row's colour is resolved
 * the way the stylesheet resolves it: index.css's `et-ink-*` utilities and its
 * scoped remaps apply inside a `.edit-theme-scope` and read that scope's inline
 * `--et-*` values; outside one, a palette class is Tailwind's own colour. The
 * colour is composited through every opacity on the way up to the menu and
 * measured against the menu surface. A translucent popup is measured over black
 * and over white, the two extremes of whatever sits under the menu.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import type { ContextMenuItem } from './ContextMenu.tsx';

const frontendDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// ── DOM globals, before React DOM loads ────────────────────────────────────
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const win = dom.window;
const setGlobal = (name: string, value: unknown) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
setGlobal('window', win);
setGlobal('document', win.document);
setGlobal('navigator', win.navigator);
setGlobal('localStorage', win.localStorage);
setGlobal('HTMLElement', win.HTMLElement);
setGlobal('Element', win.Element);
setGlobal('Node', win.Node);
setGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { ContextMenu } = await import('./ContextMenu.tsx');
const { EDIT_THEMES, CUSTOM_IMAGE_ID } = await import('../../lib/editThemes.ts');
const { useEditThemeStore } = await import('../../state/editThemeStore.ts');

// ── colour maths (WCAG 2.1, as frontend/_audit_contrast.mjs) ────────────────
type RGBA = [number, number, number, number];
const BLACK: RGBA = [0, 0, 0, 1];
const WHITE: RGBA = [255, 255, 255, 1];

const oklchToRgb = (L: number, C: number, H: number): RGBA => {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const enc = (v: number) => {
    const c = Math.min(1, Math.max(0, v));
    return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  };
  return [
    enc(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    enc(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    enc(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    1,
  ];
};

const parseColour = (raw: string): RGBA => {
  const s = raw.trim();
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (m) return [+m[1], +m[2], +m[3], m[4] == null ? 1 : +m[4]];
  m = /^([\d.]+)\s+([\d.]+)\s+([\d.]+)$/.exec(s);
  if (m) return [+m[1], +m[2], +m[3], 1];
  throw new Error(`cannot parse colour "${raw}"`);
};

const over = (fg: RGBA, bg: RGBA): RGBA => {
  const a = fg[3];
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
};
const luminance = (c: RGBA) => {
  const f = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const contrast = (a: RGBA, b: RGBA) => {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

// ── the stylesheet's colour rules ──────────────────────────────────────────
const indexCss = readFileSync(join(frontendDir, 'src', 'index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const tailwindTheme = readFileSync(join(frontendDir, 'node_modules', 'tailwindcss', 'theme.css'), 'utf8');

/** `text-zinc-600` → Tailwind's own colour, for text outside any theme scope. */
const PALETTE = new Map<string, RGBA>();
for (const m of tailwindTheme.matchAll(/--color-([a-z]+-\d+):\s*oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\);/g)) {
  PALETTE.set(m[1], oklchToRgb(+m[2] / 100, +m[3], +m[4]));
}

/** `@utility et-ink-2 { color: rgb(var(--et-ink-2)); }` → et-ink-2 ⇒ --et-ink-2. */
const INK_UTILITY = new Map<string, string>();
for (const m of indexCss.matchAll(/@utility\s+([\w-]+)\s*\{\s*color:\s*rgb\(var\((--et-[\w-]+)\)\);\s*\}/g)) {
  INK_UTILITY.set(m[1], m[2]);
}

/** Split a selector list on commas that are not inside `:is(...)`. */
const splitSelectors = (list: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '(') depth++;
    else if (list[i] === ')') depth--;
    else if (list[i] === ',' && depth === 0) {
      out.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(list.slice(start).trim());
  return out;
};
const className = (escaped: string) => escaped.trim().replace(/^\./, '').replace(/\\/g, '');

/** Unlayered `.edit-theme-scope .x` / `.edit-theme-scope :is(.x, .y)` rules. */
const SCOPED_TEXT = new Map<string, string>();
const SCOPED_SURFACE = new Map<string, string>();
let SCOPE_TEXT: string | null = null;
for (const chunk of indexCss.split('}')) {
  const open = chunk.lastIndexOf('{');
  if (open < 0) continue;
  const head = chunk.slice(0, open);
  const selectorList = head.slice(head.lastIndexOf('{') + 1).replace(/^[\s\S]*;/, '');
  const body = chunk.slice(open + 1);
  const text = /^\s*color:\s*rgb\(var\((--et-[\w-]+)\)\);\s*$/.exec(body)?.[1];
  const surface = /^\s*background-color:\s*var\((--et-[\w-]+)\);\s*$/.exec(body)?.[1];
  for (const selector of splitSelectors(selectorList)) {
    if (selector === '.edit-theme-scope') {
      SCOPE_TEXT = /(?:^|;)\s*color:\s*rgb\(var\((--et-[\w-]+)\)\)/.exec(body)?.[1] ?? SCOPE_TEXT;
      continue;
    }
    const list = /^\.edit-theme-scope\s+:is\(([^)]*)\)$/.exec(selector)?.[1];
    const single = /^\.edit-theme-scope\s+(\.[^\s:]+)$/.exec(selector)?.[1];
    const classes = list ? splitSelectors(list).map(className) : single ? [className(single)] : [];
    for (const cls of classes) {
      if (text) SCOPED_TEXT.set(cls, text);
      if (surface) SCOPED_SURFACE.set(cls, surface);
    }
  }
}
assert.equal(INK_UTILITY.get('et-ink-2'), '--et-ink-2', 'index.css defines the et-ink-2 utility');
assert.equal(SCOPED_SURFACE.get('bg-[#0a080f]'), '--et-popup', 'index.css themes the popup surface');

// ── resolving a rendered element ───────────────────────────────────────────
const describe = (el: Element) => `<${el.tagName.toLowerCase()}> "${el.textContent}"`;
const scopeOf = (el: Element) => el.closest<HTMLElement>('.edit-theme-scope');

const tokenColour = (el: Element, token: string, what: string): RGBA => {
  const value = scopeOf(el)?.style.getPropertyValue(token).trim();
  assert.ok(value, `${what} paints with ${token}, but no .edit-theme-scope above it defines ${token}`);
  return parseColour(value);
};

interface Paint {
  rgba: RGBA;
  via: string;
}

const textPaint = (el: Element): Paint => {
  const scoped = scopeOf(el) !== null;
  for (let n: Element | null = el; n; n = n.parentElement) {
    const classes = Array.from(n.classList);
    for (const cls of classes) {
      const token = INK_UTILITY.get(cls) ?? (scoped ? SCOPED_TEXT.get(cls) : undefined);
      if (token) return { rgba: tokenColour(n, token, describe(el)), via: token };
    }
    for (const cls of classes) {
      const step = /^text-([a-z]+-\d+)$/.exec(cls)?.[1];
      const colour = step ? PALETTE.get(step) : undefined;
      if (colour) return { rgba: colour, via: cls };
    }
    if (n.classList.contains('edit-theme-scope') && SCOPE_TEXT) {
      return { rgba: tokenColour(n, SCOPE_TEXT, describe(el)), via: SCOPE_TEXT };
    }
  }
  throw new Error(`${describe(el)} has no text colour this test can resolve`);
};

const surfacePaint = (menu: HTMLElement): Paint => {
  const classes = Array.from(menu.classList);
  if (scopeOf(menu)) {
    for (const cls of classes) {
      const token = SCOPED_SURFACE.get(cls);
      if (token) return { rgba: tokenColour(menu, token, 'the menu surface'), via: token };
    }
  }
  for (const cls of classes) {
    const hex = /^bg-\[(#[0-9a-f]{6})\]$/i.exec(cls)?.[1];
    if (hex) return { rgba: parseColour(hex), via: cls };
  }
  throw new Error('the menu has no surface colour this test can resolve');
};

/** Product of every `opacity-N` (and `disabled:opacity-N` on a disabled node) up to the menu. */
const opacityOf = (el: Element, menu: Element): number => {
  let alpha = 1;
  for (let n: Element | null = el; n; n = n.parentElement) {
    for (const cls of Array.from(n.classList)) {
      const plain = /^opacity-(\d+)$/.exec(cls)?.[1];
      const whenDisabled = /^disabled:opacity-(\d+)$/.exec(cls)?.[1];
      if (plain) alpha *= +plain / 100;
      if (whenDisabled && n.matches(':disabled')) alpha *= +whenDisabled / 100;
    }
    if (n === menu) break;
  }
  return alpha;
};

interface Measured {
  ratio: number;
  via: string;
  surface: string;
}

const measure = (el: Element, menu: HTMLElement): Measured => {
  const text = textPaint(el);
  const surface = surfacePaint(menu);
  const alpha = text.rgba[3] * opacityOf(el, menu);
  const grounds = surface.rgba[3] < 1 ? [over(surface.rgba, BLACK), over(surface.rgba, WHITE)] : [surface.rgba];
  const ratio = Math.min(
    ...grounds.map((ground) => contrast(over([text.rgba[0], text.rgba[1], text.rgba[2], alpha], ground), ground)),
  );
  return { ratio, via: text.via, surface: surface.via };
};

// ── render the EDIT lane's add menu, once per theme ────────────────────────
const TITLE = 'Timeline · 00:05.00';
const HEADER = 'Add to Miracle Mile';
const ENABLED_HINT = 'new track';
const DISABLED_LABEL = 'Paste clip here';
const DISABLED_HINT = 'nothing copied';
const items: ContextMenuItem[] = [
  { type: 'header', label: HEADER },
  { type: 'item', label: 'Audio from Library…', hint: ENABLED_HINT, onSelect: () => {} },
  { type: 'separator' },
  { type: 'item', label: DISABLED_LABEL, hint: DISABLED_HINT, disabled: true, onSelect: () => {} },
];

const host = win.document.createElement('div');
win.document.body.appendChild(host);
const root = createRoot(host);
await React.act(async () => {
  root.render(
    React.createElement(ContextMenu, { position: { x: 40, y: 40 }, onClose: () => {}, title: TITLE, items }),
  );
});

const leafWithText = (menu: Element, text: string): HTMLElement => {
  const hit = Array.from(menu.querySelectorAll<HTMLElement>('*')).find(
    (e) => e.childElementCount === 0 && e.textContent === text,
  );
  assert.ok(hit, `the menu renders "${text}"`);
  return hit;
};

const cases: { name: string; apply: () => void }[] = [
  ...EDIT_THEMES.map((t) => ({
    name: t.id,
    apply: () => useEditThemeStore.setState({ themeId: t.id, customImage: null }),
  })),
  {
    name: CUSTOM_IMAGE_ID,
    apply: () => useEditThemeStore.getState().setCustomImage('data:image/png;base64,iVBORw0KGgo='),
  },
];
assert.equal(EDIT_THEMES.length, 28, 'every theme in editThemes.ts is measured');

const MIN = 4.5;
const failures: string[] = [];
const table: string[] = [];
for (const c of cases) {
  await React.act(async () => c.apply());
  const menu = win.document.querySelector<HTMLElement>('[role="menu"]');
  assert.ok(menu, `${c.name}: the menu is open`);
  const rows = {
    title: measure(leafWithText(menu, TITLE), menu),
    header: measure(leafWithText(menu, HEADER), menu),
    hint: measure(leafWithText(menu, ENABLED_HINT), menu),
    'disabled hint': measure(leafWithText(menu, DISABLED_HINT), menu),
  };
  table.push(
    `  ${c.name.padEnd(16)} ` +
      Object.entries(rows)
        .map(([row, m]) => `${row} ${m.ratio.toFixed(2)}`)
        .join('  '),
  );
  for (const [row, m] of Object.entries(rows)) {
    if (m.ratio < MIN) {
      failures.push(`${c.name} ${row}: ${m.ratio.toFixed(2)}:1 (${m.via} on ${m.surface})`);
    }
    if (m.via !== '--et-ink-2') {
      failures.push(`${c.name} ${row}: paints with ${m.via}, not the theme's secondary ink --et-ink-2`);
    }
  }
  // A disabled row still reads as disabled: its label stays dimmed.
  const label = leafWithText(menu, DISABLED_LABEL);
  if (opacityOf(label, menu) >= 1) failures.push(`${c.name}: the disabled row's label is not dimmed`);
}

console.log(table.join('\n'));
assert.deepEqual(failures, [], `ContextMenu text below WCAG AA ${MIN}:1 or off the secondary ink:\n  ${failures.join('\n  ')}`);

await React.act(async () => root.unmount());
win.close();
console.log('contextMenuContrast: all assertions passed');
