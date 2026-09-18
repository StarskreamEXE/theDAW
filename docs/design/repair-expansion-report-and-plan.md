# theDAW — Repair & Expansion: report on the 2026-09-18 handoff pack, and plan

Written 2026-09-18. Sources read in full:

- `deprecated/temp plans/START_HERE.md`
- `deprecated/temp plans/IMPLEMENTATION_GUIDE.md` (837 lines)
- `deprecated/temp plans/theDAW_Implementation_Guide.html`
- `deprecated/temp plans/theDAW_Repair_and_Expansion_Guide.html`

Checked against this checkout (`feat/dj-performance-sets` @ `a3351c7`) and the
fork (`personal/main` @ `721ea5b`). No code was changed.

---

## 1. What the four files are

These are **two versions of one handoff pack**. Both cover the same 25
requests, F01–F25. They differ in which codebase they audited and in which
helper code they ship.

| | "Implementation Guide" (MD + HTML) | "Repair and Expansion Guide" (HTML) |
|---|---|---|
| Audited code | Public `gantasmo/theDAW` @ `851f6a0` only | Public `851f6a0` **plus** private `StarskreamEXE/theDAW` @ `721ea5b`, plus SunoHarvester @ `dd52bc6` |
| Knows about the fork's renderer, render queue, routing/buses, PDC, takes | No. It proposes building them. | Yes. It says to extend `renderCore.ts` / `renderJobs.ts` and not rebuild them. |
| Helper code (original, not vendored) | `timelineCore`, `gestureMachine`, `stemSets`, `libraryCounts`, `clipReferences`, `normalizationCommand`, `renderRequest` (TS); `cache_ingest.py`, `provenance.py`, `vst_probe.py` | `selection`, `timelineGeometry`, `trackTree`, `stemSet`, `libraryCounts`, `assistantReferences`, `renderManifest` (TS); `cache_stage.py`, `lineage_store.py`, `vst_probe.py`; `sql/lineage.sql` |
| Tests reported by the author | 72 TS + 29 Py = 101 | 37 TS + 19 Py = 56 |
| Extra | Repo integration map, parallel-agent boundaries, 18 "related gaps" | 20 adjacent items (A01–A20), 5 work packages A–E, required regression fixture |

- `START_HERE.md` is the execution prompt for the **Implementation Guide**
  version.
- `theDAW_Implementation_Guide.html` is the same text as
  `IMPLEMENTATION_GUIDE.md`, plus a source index (R01–R15, E01–E16), a
  validation section, and the full helper source.

### Files the pack mentions that are not in the folder

`SOURCE_INDEX.md`, `VALIDATION.md`, `validation/*.txt`, the `code/` and `tests/`
directories, `tsconfig.json`, `ACCEPTANCE_MATRIX.csv`, and the ZIP. The helper
source exists **only embedded inside the two HTML files**. The helper tests are
not included in either version, so the 101 and 56 test counts can't be
re-checked from what we have.

### Which version to follow

For work on the fork, follow **the Repair guide**. Its private audit commit
`721ea5b` is exactly the current `personal/main`. The Implementation Guide is
still useful for extra detail on selection, zoom, clip chrome, the render
center, and provenance. Where it proposes a new queue, renderer, bus system or
latency compensation, it is out of date for the fork.

---

## 2. What was checked against the code

| Claim in the pack | This checkout (`a3351c7`) | Fork (`personal/main` `721ea5b`) |
|---|---|---|
| `scripts/ingest_suno_cache.py` dedupes by title, `--limit` 5000, `pip install ijson` at runtime, `duration: 0.0`, `Path(os.environ.get(..., ""))` fallback bug | **Confirmed**: lines 3, 32, 51, 61–80, 125, 160, 173 | Same script present |
| Empty-timeline click calls `clearInpaintSelection()` | **Confirmed**: 4 call sites in `WaveformEditor.tsx` (1599, 2254, 2925, 3355). Which ones are "incidental" still needs reading. | `WaveformEditor.tsx` is 6298 lines there, not 5403 |
| Store has only a single `selectedClipId` (Implementation Guide) | **Out of date**: `selectedClipIds[]` multi-selection already exists (`editorStore.ts:256`) | Present |
| No persistent time selection, no edit cursor, no track hierarchy | Confirmed: no `timeSelection`, `editCursor`, `parentTrackId`, or track-reorder action | Confirmed: only `reorderTrackEffect`, no track reorder |
| Assistant action marked `executed` in sync dispatch | Status union is `pending/approved/rejected/executed` (`assistantBridgeStore.ts:13`). No running/failed states. | — |
| No library summary/counts endpoint | None found in `backend/modules/library/router.py` | Not checked |
| `renderCore.ts` / `renderJobs.ts` exist (Repair guide) | **Missing from this branch** | Present (batches 8–10) |
| All other referenced files (`liveMixer`, `libraryIndex`, `win_embed.py`, `editor_sidecar.py`, `StemsRunModal`, `EffectGuiStage`, `DAWCenterPanel`, `build_api_compatible_cache.py`) | Present | — |
| Public snapshot `851f6a0` | Not in the local object store (needs a fetch of `origin` to inspect) | — |

**Consequence:** the current branch is 1 commit ahead of and **191 behind**
`personal/main`. This work has to be based on `personal/main`, in a worktree,
following the existing fork workflow. It can't go on the dirty local checkout.

---

## 3. The 25 requests, merged

The **Pri** column shows Implementation / Repair priorities where they
disagree.

| ID | Request | Pri | Core of the fix | Existing code to extend |
|---|---|---|---|---|
| F01 | Drag-reorder tracks | P0 | Header drag handle, insertion line, subtree-safe move, one undo step, keyboard move | `editorStore` (no reorder action yet), `trackTree`/`moveTrackSubtrees` helper |
| F02 | 4-stem fix; truthful 11/12 | P1 / **P0** | Provider capability manifest; files vs. mix parts vs. aggregates are counted separately; a valid 11-role result is success, a missing 12th role is partial | `StemsRunModal.tsx`, `backend/modules/stems`, `stemSet(s)` helper |
| F03 | Highlight survives blur/click-away | P0 | Dedicated `timeSelection` separate from inpaint mask, loop, and clip selection; only explicit commands clear it | `WaveformEditor` clear sites, `selection` helper |
| F04 | Range-aware right-click menu | P0 | Target snapshot at right-click; priority: control, then range, then clip/group, then track, then empty lane | existing `ContextMenu` |
| F05 | Adjustable grid contrast | P0 / P1 | Bar/beat/subdivision/divider tokens and a strength slider, persisted as a preference, using the existing tempo/meter map | fork's tempo/meter work |
| F06 | Separate playback cursor and edit cursor | P0 | Click-vs-drag resolved on pointer-up; clip click moves the edit cursor without stopping playback; real engine seek | transport/seek |
| F07 | Zoom centered on the marker | P0 | One zoom command for wheel, toolbar, keys, and slider, anchored on the edit cursor; scale and scroll applied together | `setZoom` call sites, `effectiveZoom` utils |
| F08 | Wheel = zoom, Ctrl-wheel = horizontal sizing | P0 | Non-passive listener on the timeline only; `deltaMode` normalized; configurable profile. **The two versions disagree on bindings (see §5).** | native wheel handler |
| F09 | Clip title/actions stay visible | P0 / P1 | Overlay header positioned at the visible part of the clip; degrades to title + More | `visibleClipChrome` / `visibleClipHeader` |
| F10 | Ozone native UI + presets | P1 / **P0** | Diagnose first with `vst_probe.py` (floating vs. embedded); instance/session-keyed state; floating-mode fallback; plugin's own name instead of "Pedalboard" | `win_embed.py`, `editor_sidecar.py`, `vstEditorStore` |
| F11 | Centered library inspector on double-click | P1 | One asset-details dialog keyed by stable ID; tabs Overview / Stems / Lineage / Used in / Raw | existing library details |
| F12 | Ingest the entire Suno cache | P0 | Replace title dedupe; key on (provider, external ID); stream; stage, then promote through `LibraryStore`; resumable; reconciled report | `ingest_suno_cache.py`, `cache_ingest.py`/`cache_stage.py` |
| F13 | Suno-Labs-style workflows | P2 / P1 | Shared input ref → params → job → candidates → accept → lineage pattern; one provider capability registry | existing generators/jobs |
| F14 | Parent-linked stems everywhere | P1 / **P0** | A stem set is a run; each stem is its own asset; insert one or all (folder + mute parent in one undo step) | `stem_of` relations |
| F15 | Empty-space marquee multi-select | P0 | Baseline captured at pointer-down; combine with current hits; model-space hit testing; autoscroll | `gestureMachine` / `selection` helper |
| F16 | Edit clip in MIX, reflected in EDIT | P1 | `MixTarget` binding (project, clip, revision, scope); live params in place; offline-only FX show a "printed preview" badge | `liveMixer`, `MixView`, `renderJobs` |
| F17 | Clip reference chips for gantasmob0t | P1 | Chip carries IDs and revision, never bytes or title; stale-reference refusal; tools run real commands; add running/succeeded/failed statuses | `assistantBridgeStore` |
| F18 | Double-click MIDI to edit | P0 | Fix dispatch/hydration; empty MIDI stays editable; bind to the clip instance | existing piano-roll opener |
| F19 | Double-click audio → drawer editor | P1 | Clip-bound bottom drawer; non-destructive trim/fade/gain; "render as new source" | `bottomPanelStore`, WaveSurfer v7 |
| F20 | Library counts load at boot | P0 | Aggregate summary endpoint with a revision; subscribed from the app shell; invalidated on commit | `libraryIndex.ts` (keep picker caches) |
| F21 | Folders / groups / collapse | P1 | `parentTrackId`; folder vs. edit-group vs. bus kept distinct; a shared row-layout index replaces `index * trackHeight` | fork's bus/routing graph |
| F22 | Pinned master track at top | P1 / **P0** | Pinned view over the **existing** master node and FX; no second sum | `masterFxChain`, `masterVstChain` |
| F23 | Bidirectional project/render lineage | P1 | Contribution trace emitted by the render plan (not a mute filter); DB reverse index; `.lineage.json` sidecar; no self-referential hash | `renderCore`, `lineage_store.py`, `lineage.sql` |
| F24 | Export a time range | P1 / **P0** | Extend the full-mix render request with frame bounds; preroll policy; not the "selection-to-init" path | `renderCore` scopes |
| F25 | Full render/export dialog | P1 | Five-question first screen; every enabled control changes the request; preflight; queue snapshots | `renderJobs` |

---

## 4. Findings that matter most

1. **The Suno importer loses data.** It keeps one song per title, caps at 5000,
   pip-installs at runtime, writes `duration: 0.0`, and its env-var fallback
   never fires because `Path("")` is truthy. Rewrite it before any bulk import.
   (Confirmed, §2.)
2. **Selection, cursor, and zoom are the foundation for everything else.**
   Range render, context menus, marquee, assistant range references, and
   zoom-to-selection all need a persistent `timeSelection` and an edit cursor
   that are separate from focus, the inpaint mask, and the playhead.
3. **Don't build things the fork already has.** The render queue, offline
   renderer, bus/routing graph, latency compensation, takes/comping, and
   tempo/meter all exist on `personal/main`. The Implementation Guide's
   "build a render planner / bus system" parts need to be translated into
   "extend `renderCore` / `renderJobs`."
4. **Known limitations in the fork's renderer** (per the Repair guide, R04):
   per-send latency compensation isn't resolved, master/send automation timing
   is open, the engine is stereo at 44.1 kHz, and an offline path falls back
   to the active take when a take is unavailable. These block honest range and
   stem exports (A02–A04).
5. **Native VST (F10) can't be diagnosed off-machine.** It needs `vst_probe.py`
   run against your Ozone install. Live native processing in Mix is a separate,
   large piece of work. The recommendation in both versions: repair the
   GUI/freeze workflow first and label offline-only FX honestly.
6. **Assistant status is too optimistic.** There's no running or failed state,
   so an async edit can't report failure truthfully (F17).
7. **`WaveformEditor.tsx` is 6298 lines on the fork.** Several slices touch it,
   so extract the gesture, viewport, and row-layout modules first and give
   each file a single owner per wave.

---

## 5. Where the two versions disagree

| Topic | Implementation Guide | Repair guide |
|---|---|---|
| Wheel profile | plain = time zoom; Ctrl = fine time zoom; **Ctrl+Shift = lane height**; Shift = h-pan; **Alt = v-pan** | plain = time zoom; Ctrl = fine time zoom; Shift = h-pan; **Alt = lane height** |
| Zoom scroll clamp | `max(0, cursor − w/2z)`; no upper clamp; optional leading gutter | Clamped to `[0, contentDur·z − w]` |
| Default import media policy | **Copy into managed storage** | **Leave cache untouched / reference in place**; copy only by explicit mode |
| Priorities | F02, F10, F14, F22, F24 = P1 | Those = P0 (and F05/F09 drop to P1) |
| Scope of renderer work | New render planner and graph | Extend the existing `renderCore` |

---

## 6. Plan

This follows the existing fork workflow. Each batch runs in its own worktree
off `personal/main` and is pushed only to `personal`. Tickets never share a
file within a wave. The gates are tsc, the four Tailwind greps, the NUL/BOM
sweep, and `npm test` exit code, plus root ruff for Python. The next batch
number is **11**.

### Phase 0: groundwork (small, do first)
- Extract the helper source from both HTMLs into a reference folder (for
  example `docs/design/repair-pack/`, not wired into the app). Record which
  version each file came from.
- **A01:** show frontend and backend build IDs in Help/diagnostics, so a "still
  broken" report can be told apart from a stale bundle.
- Reproduction ledger: for each F-item, reproduce in the running fork build
  and record defect / missing / works. Columns: `not started / implemented /
  unit-tested / integration-tested / manually verified / blocked`.

### Phase 1 (Batch 11): timeline interaction (Work package A)
F03 → F06 → F07 → F08 → F15 → F04 → F09 → F05, then F01 (flat reorder only).
First extract `timelineSelection`, `timelineViewport`, and `gesture` modules
out of `WaveformEditor.tsx`. Port `selection`/`timelineGeometry`/`timelineCore`
+ `gestureMachine` into them with plain-tsx tests.

### Phase 2 (Batch 12): identity, counts, import (Work package B)
- F20: summary endpoint + shell subscription (quick win).
- Additive identity fields on `AudioClip` (`assetId`, `assetVersionId`,
  `revision`) and a serializer migration.
- F12: new staging importer (`cache_stage.py`, which is the more careful of
  the two), a Harvester dialect adapter, promotion through `LibraryStore` in
  batches, and a reconciled report. Test with the ten-same-titles fixture. Take
  a DB backup before any production run.
- F11: centered inspector.

### Phase 3 (Batch 13): track hierarchy and master
F21 (folders, row-layout index, collapse; folder ≠ bus ≠ edit group) and F22
(pinned view over the existing master) and F01 (subtree moves).

### Phase 4 (Batch 14): clip editing and Mix binding (Work package C)
F18 (MIDI dispatch fix) → F19 (audio drawer) → engine lifetime independent of
the Edit/Mix mount → F16 (`MixTarget`, live vs. printed-preview badges).

### Phase 5 (Batch 15): stems
F02 (capability manifests, 11/12 status, diagnose the stuck job) and F14 (stem
sets as assets, parent tab, insert one/all with mute-parent in one undo step).

### Phase 6 (Batch 16): assistant references
F17: chips, resolver, typed tools, `running/succeeded/failed` statuses, command
receipts, and sample-peak normalize as the first real tool.

### Phase 7 (parallel, on your machine): native plugins (Work package E)
F10: run `vst_probe.py` on Ozone, compare floating vs. embedded, add an
HWND/DPI diagnostic dump, a floating fallback, and instance/session-keyed state
files. The code changes stay inside `backend/modules/vst` and `vstEditorStore`.

### Phase 8 (Batches 17–18): render and provenance (Work package D)
F24 (frame-bounded range on the full-mix request, preroll) → F25 (render
dialog, preflight, format capability from the shipped FFmpeg) → F23
(contribution trace from `renderCore`, `lineage.sql` merged into existing
migrations, sidecar, reverse "Used in"). Close A02–A04 here.

### Phase 9: later
F13 Labs-style candidate drawer, compound clips, native real-time VST engine,
region × track render matrix.

---

## 7. Decisions (made 2026-09-18 from research; the user delegated them)

### D1 — Wheel bindings: the literal request is the default, with a REAPER preset
The request says ordinary wheel = zoom and Ctrl+wheel = horizontal sizing.
REAPER's shipped default is wheel = zoom, **Ctrl+wheel = track height**,
Alt+wheel = horizontal scroll, Ctrl+Alt+wheel = vertical scroll
([reapertips](https://www.reapertips.com/post/best-settings-for-reaper-7),
[Cockos forum](https://forum.cockos.com/archive/index.php/t-264008.html)).
The request and REAPER disagree on Ctrl, and the request wins. The default
profile is **"theDAW"**:

| Gesture | Action |
|---|---|
| wheel | time zoom, anchored on the edit cursor |
| Ctrl/Cmd + wheel | fine time zoom (what the request calls horizontal sizing) |
| Shift + wheel | horizontal scroll (also what Windows/browser trackpads send) |
| Alt + wheel | vertical scroll through tracks |
| Ctrl/Cmd + Shift + wheel | lane height |

A second, selectable profile **"REAPER default"** uses REAPER's own map for
muscle memory. Neither profile activates silently. Both are editable in
preferences.

Zoom scroll uses the Repair guide's clamp `[0, contentDur·zoom − viewport]`
with no leading gutter. Near 0 and near the end, the marker can't be centered,
which is documented and tested.

### D2 — Suno import: reference in place by default; copy is opt-in
C: is full, and the models already live on E: (see memory `sa3-model-locations`).
A 180k-song cache copied into managed storage would double its size. Default
mode: **reference in place, read-only**. Each file gets a content hash and an
availability state, and missing files can be relinked. **Copy into managed
storage** is an opt-in mode with a disk-space estimate up front, and the user
picks the destination drive. The cache itself is never written to. Staging uses
the Repair guide's `cache_stage.py`: it quarantines bad rows, refuses a
non-staging DB, and never copies media. Media copying from `cache_ingest.py` is
ported only into the opt-in copy mode.

### D3 — Target: `personal/main` only, one worktree per batch
Same as batches 1–10 (memory `thedaw-fork-worktree-workflow`). Nothing goes to
`origin`, and the dirty local checkout is never touched.

### D4 — Stems: keep the working pipeline and make it truthful; no new provider yet
This explains the "11/12" symptom. The fork's 12 option is `htdemucs_6s`
(6 parts). Swapping drums for LARSNET's 5 parts gives 10, and the optional
lead/backing vocal split gives 11. The 12th file is the **retained drum mix**,
which is an aggregate of the drum parts, not an independent part. The result
was right; the label "12 stems" was wrong.

- Relabel the option **"Detailed (up to 11 parts + drum bus)"**. Every run
  writes a manifest listing files produced, independent mix parts, and
  aggregates separately. "Insert all" excludes the drum bus unless the user
  ticks it.
- LARSNET's checkpoints are CC BY-NC 4.0. That's fine for this local personal
  use. The licence goes into the provider manifest and shows as a notice next
  to the option, so it's visible if the app is ever distributed.
- Also fix the known speed problem: `choose_demucs_config()` ignores the
  requested quality and forces `shifts=10`
  (memory `thedaw-stems-sidecar`). The quality selector has to actually apply.
- **Deferred to Phase 9:** a python-audio-separator provider for
  BS-RoFormer SW, a higher-quality 6-part model
  ([MVSEP](https://mvsep.com/algorithms/77)). Its README lists CUDA
  11.8/12.2 and `htdemucs_6s` but no drum-part models
  ([repo](https://github.com/nomadkaraoke/python-audio-separator)). Its
  environment has to be isolated from the working stem-separator-app venv
  (demucs 4.0.1 / torch 2.6 cu126), so it's its own work item, not a quick
  swap.

### D5 — Native VST in Mix: "printed preview" now, a real-time native engine later
The fork's documented VST path is offline render/freeze. A live native engine
needs audio-clock buffers, latency handling, and graph swaps. Per both guides,
that's a separate large slice, and bolting it onto Edit↔Mix binding would put
F16 at risk. For now: built-in Web Audio effects update live, and native VSTs
re-print after a debounce with a visible **"printed preview · stale/current"**
badge and revision guards. F10 (Ozone UI/presets/state) is still fixed
properly in Phase 7. The native real-time engine moves to Phase 9.

### D6 — Helper code: extract from the HTML; the Repair set is primary
The ZIP, `code/`, `tests/` and `ACCEPTANCE_MATRIX.csv` aren't anywhere on disk
(Everything search, 2026-09-18). Phase 0 extracts the helper source from both
HTMLs into `docs/design/repair-pack/` as reference only. The **Repair set**
(audited against the fork) comes first: `selection`, `timelineGeometry`,
`trackTree`, `stemSet`, `libraryCounts`, `assistantReferences`,
`renderManifest`, `cache_stage.py`, `lineage_store.py`, `lineage.sql`,
`vst_probe.py`. From the Implementation set, only what the Repair set lacks:
`gestureMachine` (marquee/pointer ownership), `normalizationCommand` (async
measure → revalidate → commit), and `renderRequest` (format/frame validation).
`provenance.py` is superseded by trace emission inside `renderCore` plus
`lineage_store.py`. The helper tests weren't shipped, so every ported function
gets new plain-tsx or pytest tests written against the app's own types.

### D7 — Priorities: the Repair guide's P0 set
F02, F10, F14, F22 and F24 are P0 (they're the user's visible breakages). F05
and F09 are P1. The phase order in §6 stands. F10 runs in parallel because it
needs the user's machine and Ozone.
