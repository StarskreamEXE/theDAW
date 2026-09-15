# ab-bounce — offline-render A/B harness

Renders one synthetic project twice — through the three inline bodies
`WaveformEditor.tsx` carried before ticket T11b (`legacyBodies.ts`, a verbatim
transcription of this repo's own code) and through `src/lib/renderCore.ts` —
then reports max |Δ| and RMS Δ per channel, for the rendered buffer and for the
encoded WAV. A case fails if either domain exceeds 1e-4 **or** the two sides are
not the same length and channel count.

Two cases are no longer a plain legacy-vs-core diff, and both say so up front:

- Since T14 a bounce is shifted forward by the latency its chains declare, so
  every case whose rack holds the compressor states `expectTrimSec: 0.006` and
  the legacy side is shifted by the same amount before the diff. The case still
  asserts identical audio — it just says where. A trim of the wrong size goes
  straight over the gate.
- Case **D** is the routing graph, which the legacy bodies predate entirely.
  Its reference is the core's own routing-less render of the same project times
  the gain the live graph is specified to apply (a send taps the same output as
  the main path, and a bus fader is one gain), so it asserts the routed render
  against a number written out by hand rather than against the renderer.

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
