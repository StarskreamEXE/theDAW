// Reports every Tailwind class in frontend/src that has a canonical spelling,
// the same check tailwindcss-intellisense runs as `suggestCanonicalClasses`
// (each hit is a VS Code Problems entry). It uses the project's OWN
// tailwindcss, so the answer matches the editor's.
//
//   node scripts/check-canonical-classes.mjs          report, exit 1 on any hit
//   node scripts/check-canonical-classes.mjs --fix    rewrite the files in place
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const tw = require('tailwindcss');
const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'src');
const fix = process.argv.includes('--fix');

const css = readFileSync(require.resolve('tailwindcss/index.css'), 'utf8');
const ds = await tw.__unstable__loadDesignSystem('@import "tailwindcss";', {
  loadStylesheet: async () => ({ content: css, base: here }),
});
// The editor's default root font size, so w-[300px] maps to w-75 as it does there.
const OPTS = { rem: 16 };

// Files whose strings are CSS property names, not classes ('flex-grow' there is
// the property a computed-style snapshot copies).
const NOT_CLASSES = new Set(['lib/domSnapshot.ts']);

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx|ts|jsx|js)$/.test(name) && !NOT_CLASSES.has(relative(src, p).split('\\').join('/'))) files.push(p);
  }
};
walk(src);

// A class token: what can appear inside a className string.
const TOKEN = /[!\w\-:[\]/.%#(),'>*&@=+]+/g;
// Only look inside string literals and template text.
const STRING = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;

const cache = new Map();
const canonical = (tok) => {
  if (cache.has(tok)) return cache.get(tok);
  let out = tok;
  try {
    // Only real utilities: a token that compiles to nothing is not a class.
    if (ds.candidatesToCss([tok])[0]) out = ds.canonicalizeCandidates([tok], OPTS)[0] ?? tok;
  } catch {
    out = tok;
  }
  cache.set(tok, out);
  return out;
};

let hits = 0;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  let changed = false;
  const lines = text.split('\n');
  const next = lines.map((line, i) =>
    line.replace(STRING, (whole, q, body) => {
      const newBody = body.replace(TOKEN, (tok) => {
        const c = canonical(tok);
        if (c === tok) return tok;
        hits += 1;
        console.log(`${relative(join(here, '..'), file)}:${i + 1}  ${tok}  ->  ${c}`);
        changed = true;
        return c;
      });
      return q + newBody + q;
    }),
  );
  if (fix && changed) writeFileSync(file, next.join('\n'));
}
console.log(hits === 0 ? 'canonical classes: ok' : `${hits} non-canonical class(es)${fix ? ' rewritten' : ''}`);
if (hits && !fix) process.exit(1);
