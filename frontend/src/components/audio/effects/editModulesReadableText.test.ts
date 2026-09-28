/**
 * Readable text and notice placement on the two Edit Tool Stack pages this
 * round edited (frontend/public/edit-modules/tool.html and enhance.html).
 *
 *   - Every font declaration in the page (its <style>, inline styles and the
 *     canvas placeholder's ctx.font) is 12 px or larger and in the sans face:
 *     no text under 12 px, no mono labels. The pages had 7-11 px IBM Plex
 *     Mono pills, labels, values and footer buttons beside the 12 px notices.
 *   - The swr notice (#noteBar) sits above the controls on both pages:
 *     tool.html above the monitor and the controls, enhance.html under the
 *     tool pills and above the spectrogram and the control strip. On
 *     enhance.html it used to come after the control strip, above the footer.
 *   - Every button on enhance.html has an accessible name, and the MIX slider
 *     has a real <label for>.
 *
 * Run with:  npx tsx src/components/audio/effects/editModulesReadableText.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const MODULES_DIR = join(here, '..', '..', '..', '..', 'public', 'edit-modules');
const read = (file: string) => readFileSync(join(MODULES_DIR, file), 'utf8');

const MIN_PX = 12;

/** Every `font:` / `font-size:` declaration value in the file, CSS or inline. */
function fontDeclarations(src: string): string[] {
  return [...src.matchAll(/font(?:-size)?\s*:\s*([^;"'}]+)/g)].map((m) => m[1].trim());
}

/** Every `ctx.font = '...'` the page's canvas code assigns. */
function canvasFonts(src: string): string[] {
  return [...src.matchAll(/\.font\s*=\s*(['"`])((?:(?!\1).)+)\1/g)].map((m) => m[2]);
}

function assertReadable(value: string, where: string): void {
  const px = /(\d+(?:\.\d+)?)px/.exec(value);
  assert.ok(px, `${where}: a font with no px size (${value})`);
  assert.ok(Number(px[1]) >= MIN_PX, `${where}: ${px[1]} px is under ${MIN_PX} px (${value})`);
  assert.ok(!/mono/i.test(value), `${where}: a mono face (${value})`);
}

for (const file of ['tool.html', 'enhance.html']) {
  const src = read(file);
  const decls = fontDeclarations(src);
  assert.ok(decls.length > 10, `${file}: the font declarations were found (${decls.length})`);
  for (const value of decls) assertReadable(value, file);
  const canvas = canvasFonts(src);
  assert.ok(canvas.length > 0, `${file}: the canvas placeholder's font was found`);
  for (const value of canvas) assertReadable(value, `${file} canvas`);
}

/** Whether `a` comes before `b` in document order. */
function before(doc: Document, a: string, b: string): boolean {
  const ea = doc.getElementById(a);
  const eb = doc.getElementById(b);
  assert.ok(ea && eb, `#${a} and #${b} exist`);
  return (ea.compareDocumentPosition(eb) & 4) !== 0; // DOCUMENT_POSITION_FOLLOWING
}

/* ── tool.html: the notice above the monitor and the controls ────────────── */
{
  const { document } = new JSDOM(read('tool.html')).window;
  assert.ok(before(document, 'naBar', 'noteBar'), 'tool.html: the unavailable bar, then the notice');
  assert.ok(before(document, 'noteBar', 'vizZone'), 'tool.html: the notice is above the monitor');
  assert.ok(before(document, 'noteBar', 'controls'), 'tool.html: the notice is above the controls');
}

/* ── enhance.html: the notice under the tool pills, above everything else ── */
{
  const { document } = new JSDOM(read('enhance.html')).window;
  const modeBar = document.querySelector('.mode-bar');
  assert.ok(modeBar, 'enhance.html: the tool pills');
  modeBar.id = modeBar.id || 'test-mode-bar';
  assert.ok(before(document, modeBar.id, 'noteBar'), 'enhance.html: the notice comes after the tool pills');
  assert.ok(before(document, 'noteBar', 'spectArea'), 'enhance.html: the notice is above the spectrogram');
  assert.ok(before(document, 'noteBar', 'ctrlStrip'), 'enhance.html: the notice is above the controls');
  assert.equal(document.getElementById('noteBar')?.getAttribute('role'), 'status', 'the notice is a status');

  for (const button of document.querySelectorAll('button')) {
    const name = (button.getAttribute('aria-label') ?? '').trim() || (button.textContent ?? '').trim();
    assert.ok(name && !/^[◀-◿]$/.test(name), `enhance.html: a button with no accessible name (${button.outerHTML.slice(0, 80)})`);
  }
  const mix = document.getElementById('mixSlider');
  assert.ok(mix, 'the MIX slider');
  assert.ok(document.querySelector('label[for="mixSlider"]'), 'the MIX slider has a real label');
}

console.log('edit-modules readable text and notice placement: all assertions passed');
