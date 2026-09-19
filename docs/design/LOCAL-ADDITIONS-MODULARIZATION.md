# Local additions: modularization and regression repair

## Active contract (2026-09-13)

Baseline: `04a2a62c7863ba073e9a9557661e363e2e7d613d`, branch `feat/dj-performance-sets`.
The user requests a team to fix defects in local additions and make those additions modular and additive down to file boundaries. Preserve current features and unrelated local assets. No commits, pushes, branch changes, live provider requests, runtime-data reads, export regeneration, or service restarts.

Interpretation: feature-owned modules hold behavior, UI and tests; existing upstream files retain small explicit imports, calls or extension points. Do not duplicate whole upstream files or replace useful host implementations with wrappers solely to hide a diff. Existing paths should remain compatible where practical. New files belong to coherent feature directories.

Routing: native agents inherit the current model as required by the runtime. Spark is not advertised. Named Spark/Sol/Terra defaults are not silently asserted as actual execution.

## Ownership

All paths below are relative to `VST-Foundry-UI/VST-UI-FOUNDRY` unless prefixed with repository root.

1. Provider worker: `server/extract.ts`, `server/providers.ts`, `server/routes.ts`, `server/sd.ts`, new `server/features/openrouter/**`, texture-generation modal/form/builder/types and new `src/features/openrouter-textures/**`, new provider tests, `docs/texture-generation.md`.
2. Extractor worker: `src/components/extractor/**`, `src/hooks/useKeyboardShortcuts.ts`, new `src/features/extractor/**`, new extractor tests, `docs/component-extractor.md`.
3. Plugin worker: `src/lib/vst3Export.ts`, `src/lib/vst3ExportUi.ts`, `src/lib/vst3ExportCustomCode.test.ts`, new `src/features/custom-code-export/**`, `scripts/export-powermode.mts`, `scripts/shims/file-saver.ts`, `scripts/tsconfig.export.json`, new `scripts/power-mode/**`; repository-root `frontend/src/lib/powerModeBridge.ts`, `frontend/src/views/MixView.tsx`, new `frontend/src/features/power-mode/**`.
4. Editor/inpainting worker: `src/App.tsx`, existing untracked `src/components/PropertiesPanel.tsx` and `AlignmentPanel.tsx`, new `src/features/editor-properties/**`, `src/lib/inpaint/lamaOnnx.ts`, new inpainting helpers/tests. Also owns the small App integration for keyboard isolation described below.
5. Lead: this coordination record, boundary decisions, source/diff audits, dispatch and acceptance. Final validation runs are assigned after writes settle.

Workers may read relevant code outside their write set. Shared-file changes are serialized. No worker may edit another worker's files or spawn children.

## Integration contracts

- Extractor worker adds optional `enabled?: boolean` (default true) to `useKeyboardShortcuts`. Editor worker adds `enabled: !isExtractorOpen` to its App call. The extractor Delete listener must have a scoped/tested keyboard boundary rather than relying on preventDefault alone.
- Provider worker keeps extractor HTTP contracts (`provider`, `apiKey`, `model`, normalized image and sensitivity) stable; extractor worker owns frontend provider selection and its modules.
- Feature-related tests use synthetic inputs and local dependency doubles, never real API keys or remote inference.
- Generated POWER MODE bundles, sessions, textures, `_backup`, `_deprecated`, `300mb` and metadata are preserved. Review/export tooling may be improved but must not read live session contents or regenerate artifacts.

## Acceptance gates

- Regression tests cover extractor versus canvas Delete isolation, storage-independent WASM retry, and OpenRouter count/size fallback semantics.
- Additional defects discovered in owned local features are repaired with focused tests.
- Feature implementation moves into additive modules; final host-file diff and file map are independently audited.
- Foundry complete tests and TypeScript checks; relevant frontend POWER MODE tests and typecheck/build checks as feasible. Heavy checks run sequentially and final exit codes are recorded.
- No credentials/live provider calls; no unrelated user work lost. Report precise limits rather than claiming universal safety.

## Status

- Baseline review: Foundry 172 tests passed; TypeScript passed; three independent synthetic reproductions confirmed the review defects.
- Source backup: `.git/local-additions-backups/20260913-024834` (original local patch, source copies and status).
- Implementation: four native inherited-model workers dispatched successfully: Dalton (providers), Curie (extractor), Plato (plugin/export), Jason (editor/inpainting).
- Final validation and lead acceptance: pending.
- Editor/inpainting implementation frozen: 28 focused tests passed (exit 0), worker language-service diagnostics clean. Source independent review dispatched. GPU/browser pixels remain untested.
- Provider implementation frozen: 32 focused tests passed in four files (exit 0); no paid calls. 404/405 now stops explicitly rather than generating with dropped count/size; key isolation, count mismatches, cancellation and redaction are tested.
- Plugin/export implementation frozen: 27 toggle tests, eight explicit-input exporter tests and five bridge tests passed (exit 0); scoped TypeScript passed. Lead follow-up fixed missing required textures: CLI now stops before building or writing and documents explicit input/shim usage. Existing exported artifacts were not regenerated.
- Extractor implementation frozen: 28 focused tests in six files, scoped TypeScript and diff checks passed (exit 0). Tests cover the actual modal plus canvas keyboard hook, editable exclusions, provider races, grouping and selection lifecycle.
- Dedicated validation worker dispatched for sequential complete tests, typechecks and isolated build outputs under `.git/validation`; no source writes.
- Independent editor audit requested revision: locked-center alignment drift and missing 2px group child-origin inset. Lead verified the renderer geometry and sent a narrow correction to the editor owner. Foundry gates before that correction are interim; unaffected frontend/script validation may continue.
- Interim combined Foundry suite: 272 tests passed. Full typecheck caught four invalid test query options; owner corrected them and the focused test/type checks pass. Foundry final gates remain pending alignment correction.
- Final frontend gates after its freeze: 53 discovered test suites passed, TypeScript passed, production build passed (exit 0 for all).
- The first Foundry build check used Vite's nondefault runner loader and failed on the existing `__dirname` config; a temporary-preloader retry is not the acceptance gate. Lead requested a normal default-loader build with isolated output and permitted tool-managed cache files.
- Alignment correction frozen: 34 panel/layout tests passed and strict diagnostics clean. Locked reference anchors and per-group border insets are implemented with nested rotation/flip tests. Independent reviewer and validator notified to perform final acceptance checks.
- Independent re-review: PASS. Both alignment findings resolved; reviewer reran 28 relevant geometry tests plus scoped TypeScript (exit 0) and found no remaining blocker in those paths. Earlier audit also verified preservation of all 37 panel controls.
- Final reviewed source manifest saved at `.git/local-additions-backups/20260913-024834/final-source-manifest.json` (84 source/test/documentation files, excluding this evolving coordination record).

## Final acceptance

All requested implementation lanes and bounded corrections are complete. Lead inspected final source boundaries, decisive failure handling and actual gate logs; the independent panel review passed. No known review blocker remains in the changed features. This is source/test/build acceptance, not a guarantee of live cloud/GPU behavior.

Final results (all exit 0):

| Gate | Result |
| --- | --- |
| Complete Foundry Vitest run, one worker | 289 tests passed in 33 files |
| Complete Foundry TypeScript | Passed |
| Foundry production frontend build, normal Vite loader | Passed |
| Foundry esbuild server bundle | Passed |
| Explicit-input exporter tests | 8 passed |
| Export-tool TypeScript project | Passed |
| Complete main frontend discovered test run | 53 suites passed, including POWER MODE |
| Complete main frontend TypeScript | Passed |
| Main frontend production build | Passed |
| Final source fingerprint and diff check | 84 reviewed files unchanged since freeze; diff check passed |

Commands use installed local tools: Foundry `node node_modules/vitest/vitest.mjs run --maxWorkers=1`, `node node_modules/typescript/bin/tsc --noEmit`, `node node_modules/vite/bin/vite.js build --outDir <fresh-output>`, and esbuild for `server.ts`. Export tests use `node node_modules/tsx/dist/cli.mjs --test scripts/power-mode/prepare.test.mts scripts/power-mode/cli.test.mts` followed by `tsc --noEmit --project scripts/tsconfig.export.json`. Main frontend uses `npm test`, `tsc --noEmit` and `vite build` from its own directory.

Exact commands, final exit codes and build outputs are under `.git/validation/mechanical-2026-09-13T10-09-45-497Z-a70ce653`. Interim failed gates are retained as history; final Foundry gates are numbered 09–13. Build outputs are isolated from application `dist` directories. Package manifests and lockfiles remain unchanged.

Known limits: no paid inference, real GPU inference, live image persistence, native VST host integration, real session export or application restart was performed. Existing exports and runtime data remain untouched. Changes remain uncommitted; no merge or push was performed.

## Feature acceptance matrix

| Addition | Required additive boundary | Behavioral evidence |
| --- | --- | --- |
| OpenRouter extraction | Feature client/schema helpers; shared extraction handler delegates | Provider switching preserves matching model/key, validation and existing Gemini routes |
| OpenRouter textures | Separate generator/catalog route modules and frontend hook/fields | Success and 404/405 fallback preserve requested semantics; fail clearly otherwise |
| Extractor multi-select | Selection/keyboard hook and geometry helpers | Box click, marquee, additive selection and Delete/Backspace scoped to the modal |
| Extractor module cards | Feature-owned module presentation | Group placement and loose-piece behavior retained |
| Editor properties/alignment | Feature directory with responsibility-based components | Empty/single/multi selection, locks and coordinate contracts |
| LaMa fallback | Session policy separated from image/canvas processing | Blocked storage, failed GPU retry, release and concurrent callers |
| Custom toggle export | Manifest and standalone-renderer helpers | Defaults, both parameter directions, serialization and numeric compatibility |
| POWER MODE | Feature bridge/lifecycle boundary and explicit export tools | Relay contract, finite values, cleanup, effect mapping and side-effect-free tooling imports |

Completion requires inspecting the final additions AND the remaining changes against origin/main. Green tests alone are insufficient; the prior review reproduced defects despite 172 passing tests.

## Module map and future staging

Feature code lives in `server/features/openrouter`, `src/features/openrouter-textures`, `src/features/extractor`, `src/features/editor-properties`, `src/features/inpainting`, `src/features/custom-code-export`, and `scripts/power-mode` inside Foundry. The main frontend addition lives in repository-root `frontend/src/features/power-mode`.

Remaining upstream-file edits are explicit provider dispatch, feature component/hook wiring, the keyboard enable contract, and extraction of existing custom-code rendering into its dedicated module. They are necessary integration points, so this is not a zero-diff change to the host. The existing component/bridge import paths remain compatibility exports.

Source, tests and the related documentation form the reviewable patch. Existing `exports`, `_backup`, `_deprecated`, `300mb`, metadata and runtime configuration are retained local artifacts, not new feature implementation to stage blindly. No commit or merge is part of this task.

POWER MODE export now requires explicit `--session`, `--textures`, and `--out` inputs. See `../../VST-Foundry-UI/VST-UI-FOUNDRY/scripts/power-mode/README.md`. Missing required texture files stop the command before output is built or written. Actual user sessions were not used for validation.
