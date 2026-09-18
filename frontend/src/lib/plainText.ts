/**
 * Fold a line of log text to plain ASCII.
 *
 * theDAW's console carries the backend, the Electron main process and the dev
 * server in one stream, and it is read to find out what broke. Unicode
 * glyphs do not belong in it. Vite writes "* new dependencies optimized" with a
 * sparkle; other tools draw box rules and arrows. None of it survives a copy
 * into an issue, and on Windows a console running a legacy code page raises
 * UnicodeEncodeError on an astral-plane character and can take the operation
 * down with it -- `backend/modules/midi/engine.py` already carries a workaround
 * for exactly that, where basic-pitch's emoji status lines killed conversions.
 *
 * THIS TRANSLITERATES, IT DOES NOT JUST DELETE. A glyph that carries meaning
 * becomes the ASCII that carries the same meaning, because a log line reading
 * "key of F#" is correct and one reading "key of F" is a lie. Sharp becomes #,
 * flat becomes b, an arrow becomes ->, minus-sign becomes -, infinity becomes
 * inf. Only decoration -- emoji, box rules, dingbats -- is removed outright.
 */

/** Glyphs that mean something, and the ASCII that means the same thing. */
const TRANSLITERATE: ReadonlyArray<readonly [RegExp, string]> = [
  // Musical notation. A DAW writes these and they must survive as text.
  [/♯/g, '#'],
  [/♭/g, 'b'],
  [/♮/g, 'n'],
  [/[♩♪♫♬]/g, ''],
  // Arrows, which this codebase uses to mean "becomes" or "goes to".
  [/[→⇒➡⮕]/g, '->'],
  [/[←⇐⬅]/g, '<-'],
  [/[↔⇔]/g, '<->'],
  [/[↑⬆]/g, '^'],
  [/[↓⬇]/g, 'v'],
  [/↗/g, '->'],
  // Mathematics.
  [/−/g, '-'],
  [/×/g, 'x'],
  [/÷/g, '/'],
  [/∞/g, 'inf'],
  [/≈/g, '~'],
  [/≠/g, '!='],
  [/≤/g, '<='],
  [/≥/g, '>='],
  [/∆|Δ/g, 'delta'],
  [/±/g, '+/-'],
  [/°/g, ' deg'],
  [/µ|μ/g, 'u'],
  // Punctuation and typography.
  [/[‐-―]/g, '-'],
  [/[‘’‛]/g, "'"],
  [/[“”‟]/g, '"'],
  [/…/g, '...'],
  [/ | | /g, ' '],
  [/·|•/g, '-'],
  [/✓|✔/g, 'ok'],
  [/✕|✖|✗|✘/g, 'x'],
  [/⚠/g, 'warning'],
  // Box drawing and block elements become their ASCII ancestors.
  [/[─━┄-┋═]/g, '-'],
  [/[│┃┆-┏║]/g, '|'],
  [/[┌-╏╒-╿]/g, '+'],
  [/[▀-▟]/g, '#'],
];

/**
 * Anything still outside printable ASCII after transliteration is decoration
 * and goes: emoji, dingbats, geometric shapes, braille, the rest.
 * Tab, newline and carriage return are kept so a multi-line log stays readable.
 */
const NON_ASCII = /[^\x09\x0A\x0D\x20-\x7E]/g;

/** `text` as plain ASCII, with meaning preserved where a glyph carried any. */
export function plainAscii(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [pattern, replacement] of TRANSLITERATE) out = out.replace(pattern, replacement);
  out = out.replace(NON_ASCII, '');
  // Tidy what removal left behind: runs of spaces collapse, and a line that
  // was only decoration comes back empty for the caller to drop.
  return out
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').replace(/^[ \t]+/, '').trimEnd())
    .join('\n');
}

/** True when `text` carries anything outside printable ASCII. */
export function hasNonAscii(text: string): boolean {
  NON_ASCII.lastIndex = 0;
  return NON_ASCII.test(text);
}
