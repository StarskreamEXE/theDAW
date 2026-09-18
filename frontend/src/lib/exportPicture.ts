/**
 * A drawing on screen, as a file: SVG, PNG, PDF or a standalone HTML page.
 *
 * Every chart in the app that is drawn as SVG (the rhyme web, the meter map)
 * exports the same way, so the recipes live here once. A PNG is the SVG
 * rasterised through an <img> onto a canvas; a PDF is the SVG drawn as
 * vectors by svg2pdf.js onto a jsPDF page cut to the drawing's size, so text
 * stays text; the HTML page wraps the SVG with a title and a background so it
 * opens in a browser on its own.
 *
 * jspdf and svg2pdf.js are imported when first used, to stay out of the
 * initial bundle, the way ScoreView loads them.
 */

import type React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

/** Pixels to PDF points: CSS px are 96 to the inch, points 72. */
const PT_PER_PX = 72 / 96;

/** The SVG text as an <svg> element in the document, for the libraries that
 *  need a live node. Appended off screen and removed by the returned function. */
const mountSvg = (svgText: string): { node: SVGSVGElement; unmount: () => void } => {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const node = document.importNode(doc.documentElement, true) as unknown as SVGSVGElement;
  const holder = document.createElement('div');
  holder.style.position = 'fixed';
  holder.style.left = '-100000px';
  holder.style.top = '0';
  holder.style.width = '0';
  holder.style.height = '0';
  holder.style.overflow = 'hidden';
  holder.setAttribute('aria-hidden', 'true');
  holder.appendChild(node);
  document.body.appendChild(holder);
  return { node, unmount: () => holder.remove() };
};

/** The SVG rasterised at `scale` over `background`. */
export const svgToPng = (
  svgText: string,
  width: number,
  height: number,
  { scale = 2, background = '#07050a' }: { scale?: number; background?: string } = {},
): Promise<Blob> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' }));
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('No 2D canvas.');
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(url);
          if (blob) resolve(blob);
          else reject(new Error('The canvas gave no PNG.'));
        }, 'image/png');
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('The picture could not be drawn as an image.'));
    };
    img.src = url;
  });

/** The SVG as a one-page PDF, the page cut to the drawing, drawn as vectors. */
export const svgToPdf = async (
  svgText: string,
  width: number,
  height: number,
  { title, background = '#07050a' }: { title?: string; background?: string } = {},
): Promise<Blob> => {
  const [{ jsPDF }, { svg2pdf }] = await Promise.all([import('jspdf'), import('svg2pdf.js')]);
  const w = width * PT_PER_PX;
  const h = height * PT_PER_PX;
  const doc = new jsPDF({ orientation: w >= h ? 'landscape' : 'portrait', unit: 'pt', format: [w, h] });
  if (title) doc.setProperties({ title });
  doc.setFillColor(background);
  doc.rect(0, 0, w, h, 'F');
  const { node, unmount } = mountSvg(svgText);
  try {
    await svg2pdf(node, doc, { x: 0, y: 0, width: w, height: h });
  } finally {
    unmount();
  }
  return doc.output('blob');
};

/** A PNG as a one-page PDF, the page cut to the image. For pictures that are
 *  not pure SVG (a DOM snapshot), where vectors are not on offer. */
export const pngToPdf = async (
  png: Blob,
  width: number,
  height: number,
  { title }: { title?: string } = {},
): Promise<Blob> => {
  const { jsPDF } = await import('jspdf');
  const w = width * PT_PER_PX;
  const h = height * PT_PER_PX;
  const doc = new jsPDF({ orientation: w >= h ? 'landscape' : 'portrait', unit: 'pt', format: [w, h] });
  if (title) doc.setProperties({ title });
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('The PNG could not be read.'));
    r.readAsDataURL(png);
  });
  doc.addImage(dataUrl, 'PNG', 0, 0, w, h);
  return doc.output('blob');
};

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A page of its own around a piece of markup: dark background, the title in
 *  the tab, the body centred, and any CSS the body needs. */
export const standaloneHtml = ({
  title,
  body,
  css = '',
  background = '#07050a',
  maxWidth,
}: {
  title: string;
  body: string;
  css?: string;
  background?: string;
  /** Width the body is held to, in px; unset lets it fill the window. */
  maxWidth?: number;
}): string =>
  `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
html, body { margin: 0; background: ${background}; color: #e4e4e7; }
body { font-family: "IBM Plex Sans", "Segoe UI", system-ui, sans-serif; }
main { margin: 0 auto; padding: 24px 16px 48px; ${maxWidth ? `max-width: ${maxWidth}px;` : ''} }
svg { display: block; max-width: 100%; height: auto; }
${css}
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;

/** `title` as a file stem: lowercase, words joined by dashes. */
export const fileStem = (title: string, fallback = 'picture'): string =>
  (title || fallback).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || fallback;

/**
 * A React SVG tree as a string, rendered by the browser rather than by
 * `react-dom/server`.
 *
 * The server renderer is a second copy of React's whole rendering path, and
 * pulling it into a browser bundle for one export button costs a dependency
 * re-optimization and a full page reload every time the dev server notices it.
 * Rendering into a detached node and serialising what the DOM actually built is
 * smaller, and it is also more faithful: what lands in the file is what the
 * browser would have drawn.
 */
export const renderSvgToString = (element: React.ReactElement): string => {
  const holder = document.createElement('div');
  holder.style.position = 'fixed';
  holder.style.left = '-100000px';
  holder.style.top = '0';
  holder.setAttribute('aria-hidden', 'true');
  document.body.appendChild(holder);
  const root = createRoot(holder);
  try {
    // Synchronous, because the caller wants the markup on the next line.
    flushSync(() => root.render(element));
    const svg = holder.firstElementChild;
    return svg ? new XMLSerializer().serializeToString(svg) : '';
  } finally {
    root.unmount();
    holder.remove();
  }
};
