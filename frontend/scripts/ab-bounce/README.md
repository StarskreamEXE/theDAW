# ab-bounce — offline-render A/B harness

Renders one synthetic project twice — through the three inline bodies
`WaveformEditor.tsx` carried before ticket T11b (`legacyBodies.ts`, a verbatim
transcription of this repo's own code) and through `src/lib/renderCore.ts` —
then reports max |Δ| and RMS Δ per channel, for the rendered buffer and for the
encoded WAV. A case fails if either domain exceeds 1e-4 **or** the two sides are
not the same length and channel count.

Run from `frontend/`: `node scripts/ab-bounce/run.mjs` (exit 1 on any failure).
It starts Vite on an **OS-assigned free port** — never 3000 — and drives the
locally installed Playwright Chromium; nothing is downloaded and nothing leaves
the machine.

Typecheck it with `npm run lint:scripts` (`scripts/tsconfig.json`, which extends
the app config and includes `../src/*.d.ts` for the Vite ambient types). This
directory is outside the app's `tsconfig.json` `include` (`["src"]`) and outside
`scripts/run-tests.mjs`'s walk (`src/` only), so `npm run lint` and `npm test`
do **not** cover it — `lint:scripts` is what keeps it from rotting against the
modules it imports.
