# theDAW — feature-gap plan

Derived from the 70-feature source audit (`reports/theDAW_70_feature_audit_with_OSS_references.html`),
re-adjudicated against seven open-source DAWs read line-by-line in `oss-refs/`
(`reports/theDAW_70_theirs_vs_ours.html`).

Baseline for this plan: `04a2a62` (local `feat/dj-performance-sets`), with
`danieljtrujillo/main` **104 commits ahead**.

---

## 0. Where we actually stand

| | audit said | our tree @ `04a2a62` | after catching up to daniel |
|---|---|---|---|
| Covered | 29 | 33 | **35** |
| Partial | 14 | 22 | **20** |
| Absent | 27 | 15 | **15** |

The audit was accurate — it audited `danieljtrujillo/main`, which is where
`PianoNote.lane`, `RollMeter{meterMap,pickupSteps,lanes}` and the pitch-bend
lanes live. Our tree simply predates them.

**Catching up to daniel closes #36 and #37 outright and upgrades #05 and #42
for free. It closes none of the 15 genuinely-absent features.**

### Status (fork `personal/main`)
| when | commit | done |
|---|---|---|
| 2026-09-15 | `919d295` | §1 caught up to `danieljtrujillo/main` (56 commits merged; one conflict, `EffectWindows.tsx`, resolved to daniel's `chainInState`) |
| 2026-09-15 | `ab5fae5` | **D1** `pitch_shift` → rubberband pitch, **D4** split fades, **D7** master-VST undo, **D9** autosave `beforeunload`/`pagehide` flush; `editorStore.test.ts` |
| 2026-09-15 | `4ae431c` | **D8** piano-roll undo/redo, **D3** bypass keeps the instance, **D2** inert VST entries reported via `ChainHandle.inertIds()`; `virtuosoTransform.test.ts` green (lazy `?url`); suite 103/0. Run record `docs/runs/P-20260915-batch2.md` |
| in flight | batch 3 | §3.13 decode-cache unification (T04), §3.2 tempo+meter module (T05) |

Remaining from §2: D5 (fade envelope 4×, folds into §3.3), D6 (four renderers,
folds into §3.5), D10, D11, D12 (→ T05), D13–D19.

---

## 1. Catch up to `danieljtrujillo/main` — do this first

Nothing else should be built until this lands. Daniel's 57 non-merge commits
include the whole MIDI meter/polymeter/pitch-bend subsystem
(`lib/meterMap.ts`, `lib/pitchBend.ts`, `lib/bendLane.ts`,
`lib/pitchBendVoice.ts`, `lib/rollMidi.ts`, `lib/rollClip.ts`,
`lib/rollLoom.ts`, `lib/syncopation.ts`, `lib/rhythmSeed.ts`,
`lib/virtuosoTransform.ts`, `lib/meterFace.ts`), a file-access security pass,
notation/tempo fixes, the SWAY cockpit rebuild, and the footer/transport
rework — plus `state/trackFxRackStore.ts`, which is the nearest thing we have
to a per-track FX rack and is relevant to §4's bus work.

### Hazard

The working tree holds **90 dirty/untracked files** belonging to ~11 other
concurrent workstreams (per `docs/design/LOCAL-ADDITIONS-MODULARIZATION.md`,
which mandates *no commits, pushes or branch changes*). **18 of those files
collide with files daniel also changed:**

```
.gitignore
backend/assistant_routes.py          backend/modules/library/router.py
backend/modules/midi/engine.py       backend/modules/notation/engine.py
backend/modules/notation/router.py   backend/modules/questmidi/bridge.py
backend/modules/stems/sidecar.py     backend/modules/vocal/transcription/sidecar.py
frontend/src/components/audio/EffectWindows.tsx
frontend/src/components/audio/WaveformEditor.tsx
frontend/src/components/layout/DetailsView.tsx
frontend/src/components/layout/ScoreView.tsx
frontend/src/components/layout/SettingsModal.tsx
frontend/src/lib/backendLocalProvider.ts
frontend/src/views/DJView.tsx        frontend/src/views/LibraryView.tsx
frontend/src/views/MixView.tsx
```

A merge or rebase in this checkout would put those 18 files into conflict with
work that has never been committed anywhere. **Do not merge in the dirty
checkout.**

### Procedure

1. **Back up the dirty tree** — `_backup/pre-daniel-catchup-<ts>/`
   (`dirty-tree.tar.gz` + `tracked.diff` + `status.txt` + `base-commit.txt`).
   Done.
2. **Catch the fork up in an isolated worktree**, never the working checkout:
   ```
   git worktree add -b catchup/daniel <path> personal/main
   cd <path> && git merge danieljtrujillo/main
   # resolve; our 5 DJ/orb commits are additive and touch
   # DJView.tsx + EffectWindows.tsx, which daniel also edits
   git push personal HEAD:main
   git worktree remove <path>
   ```
   The working checkout is untouched throughout; the other workstreams keep
   their uncommitted state.
3. **Only after each other workstream commits its own files** should the local
   checkout be moved onto the new base. Those 18 collisions are theirs to
   resolve, not ours to resolve for them.

### Our 5 commits vs daniel

`personal/main` is 5 ahead / 56 behind. Our commits are additive
(`chatHistory.ts`, `chatHistory.test.ts` are new files; `AssistantPanel.tsx`
daniel does not touch). Expect conflicts only in **`DJView.tsx`** and
**`EffectWindows.tsx`** — both of which daniel edits
(`4c3859b fix(edit): a lane with no FX chain keeps one stable empty chain`
touches the same `EMPTY_CHAIN` area as our `ffc22d1`; take daniel's structure
and re-apply our `Object.freeze` + the one-click Auto-DJ row).

---

## 2. Defects to fix (found by the comparison, ranked)

These are bugs in shipped code, independent of any new feature.

| # | Defect | Where | Fix |
|---|---|---|---|
| D1 | `pitch_shift` is a **frequency shifter**, not pitch; UI labels it "cents" | `backend/modules/effects/router.py:285` (`afreqshift`) | one-line → `rubberband=pitch=` |
| D2 | **Every `vst3` chain entry is silently dropped** from the live graph | `frontend/src/lib/rackEffects.ts:2164` | second resolver for plugin-backed entries (see §3.1) |
| D3 | **Bypass disposes the instance** — reverb tails / delay buffers lost | `rackEffects.ts:2169` | route around, don't dispose (see §3.1) |
| D4 | Split copies fades onto **both** halves | `editorStore.ts:658-666` | re-clamp per half |
| D5 | Fade envelope hand-written **4×**; must stay byte-identical for export==preview | `liveMixer.ts:376-395`, `WaveformEditor.tsx:1821,:2450,:2770` | one shared module (§3.3) |
| D6 | **Four** copy-pasted OfflineAudioContext renderers; only one registers the chop worklet | `WaveformEditor.tsx:1788,:2367,:2727`, `StepSequencer.tsx:316` | unify behind one request type (§3.5) |
| D7 | Master-VST rack edits **not undoable** (track VST is) | `masterVstChain` missing from `EditorHistorySnapshot` `editorStore.ts:394` | add the slice |
| D8 | Piano roll has **zero** undo history | `pianoRollStore.ts:103-122` | give it a history |
| D9 | No `beforeunload` flush — up to 2 s of work lost on clean close | `lib/editorAutosave.ts` | port ACE `projectStore.ts:2376` |
| D10 | **`Track.armed` is a dead affordance** — nothing records into it | `editorStore.ts:125`, button `WaveformEditor.tsx:4456` | §3.7 |
| D11 | Explicit save preserves **less** than autosave | `projectImport.ts:410-472` omits masterFx/masterVst/automation/markers/loop | extend `captureEditorSession` |
| D12 | Tempo in ≥4 places, different clamps (40–240 vs 20–300) | editor / pianoRoll / beatClock / DJ | §3.2 |
| D13 | Recorders use `performance.now()`/`Date.now()` while playback is on AudioContext time | `MidiPanel.tsx:246`, `MicRecorder.tsx:146` | anchor to transport |
| D14 | FX automation on `setInterval(25)` — throttled in background tabs | `liveMixer.ts:564` | — |
| D15 | `automationTouchNative` comment claims "latch"; there is no latch | `liveMixer.ts:578-580` | fix with §3.9 |
| D16 | Peaks normalized per clip — two clips at different levels look identical | `editorStore.ts:1041` | store raw (§3.12) |
| D17 | Autosave manifest written in place (torn-write); no multi-tab lock | `editorAutosave.ts` | temp-then-rename |
| D18 | `commitEdit` forces a browser download, no opt-out | `WaveformEditor.tsx:2588-2593` | — |
| D19 | Session-grid launch anchor captures tempo in a closure | `DawSessionGrid.tsx:428-443` | §3.10 |

---

## 3. Port plan, in dependency order

Every "from" below is a file that exists in `oss-refs/` and was read
line-by-line. `oss-refs/` is gitignored; nothing is vendored without an
explicit decision.

### 3.1 Plugin engine — resolver, reconnect-bypass, live plugin routing
**From** `ACE-Step-DAW/src/engine/PluginEngine.ts` (305 lines, TypeScript).
Fixes **D2 + D3** and opens #29 in one abstraction: plugin-backed entries
resolve through a second registry the effect table never sees
(`:93-100`); bypass disconnects `prev→node` and connects `prev→next`
without disposing (`:137-171`); four accessors make the rest of the chain
respect the flag (`:177-194`). *Highest value single port in the survey.*

### 3.2 Shared tempo+meter module; `beatClock.ts` becomes the sole owner
**From** `ACE-Step-DAW/src/utils/tempoMap.ts`; lift our own
`notechart.ts:321-347`. Closes **#02 #04 #05**, fixes **D12**, unblocks §3.4.
Every reference DAW has exactly one tempo owner and exposes only conversion
functions, never a bare `bpm`. Keep it as **pure functions over an array**, not
a store — a `tempoMapStore` would recreate the multi-owner problem.
**Do not create `MusicalClock.ts` or `tempoMapStore.ts` from the audit
snippets**; both duplicate better code we already have.
*Sequence after §1* — daniel's `lib/meterMap.ts` is the meter half.

### 3.3 Clip editing utilities
**From** `ACE-Step-DAW/src/utils/{clipFade,dragMath,crossfade,audioWarp}.ts`
and `types/project.ts:1055-1104,:1171-1177`. All pure, zero-dep, near-verbatim.
Closes **#13 #17 #18**, upgrades **#16 #19**, fixes **D4 + D5**.
Order: clip fields → pure modules → `liveMixer` scheduling → `WaveformEditor`.
Note `liveMixer.scheduleClips` must go from one BufferSource per clip to one
per warp segment (`AudioEngine.ts:1070-1092` is the template).

### 3.4 Metronome + count-in — #08
**From** `ACE/src/engine/AudioEngine.ts:1213-1290` and
`RecordingEngine.ts:430-450`; mute policy from Tracktion
`ClickNode.cpp:201-216`. Cheapest real production win once §3.2 lands.
Design choice: pre-schedule on play (ACE) vs per-block cursor walk
(Tracktion) — decide by whether EDIT will allow tempo edits *during*
playback.

### 3.5 Render job queue + BounceRequest — #70, #54
**From** `tracktion_engine/model/export/tracktion_Renderer.h:36,:133-204`.
Fixes **D6**: the four existing renderers become jobs.
Hard constraint the audit ignores — `OfflineAudioContext.startRendering()`
exposes **no progress and no cancel**, so this needs chunked rendering
(N seconds per context, concatenated) or binary per-job progress.

### 3.6 Routing adjacency map + bus registry — #25 #23 #24 #64
**From** `stargate/src/sglib/models/daw/routing/graph.py` (~170 lines, pure
model, master is just node 0); bus contract from
`ardour/libs/ardour/internal_return.cc`; send node from
`tracktion_AuxSendNode.cpp`.
One adjacency map subsumes buses, sends and sidechain (`conn_type` 0/1/2).
**Feedback refusal and topological order are mandatory** — a WebAudio cycle
without a DelayNode silences the graph. Our `muteGain` sits before the fx
chain, so a pre-fader tap bypasses mute; decide that explicitly.

### 3.7 Recording chain — #43 → #07 → #40 → #45 → #46
**From** `ACE/src/engine/RecordingEngine.ts` (per-track takes anchored to
transport time, count-in, live take waveform); punch gate from
`ardour/session.cc:1797-1807` (`record_enabled && location && (in||out)` —
we only have the `armed` term); punch plumbing from `ACE/hooks/useRecording.ts`;
takes/comp model from Tracktion `WaveAudioClip.cpp` + `TrackCompManager.h`
(takes hang off the **clip**, not a parallel lane — simpler for us, our clips
already carry blobs).
Strict dependency chain. Fixes **D10 + D13**. #69 needs this to exist before a
round-trip calibration has a consumer.

### 3.8 Latency declaration, then PDC — #27
**From** `tracktion_graph/nodes/tracktion_SummingNode.h:70-113,:266-310` and
`PluginNode.cpp:96`.
**A PDC ticket that does not first add latency declaration to
`rackEffects.ts` cannot succeed** — nothing currently declares latency, so
there is nothing to accumulate. Our DJ `delayComp` is already Tracktion's
formula hand-rolled for two inputs; generalize it.
Compensation must also feed automation reads, meters and render trim.

### 3.9 Automation touch/latch + per-point curve — #34, #32
**From** `tracktion_AutomationRecordManager.cpp:330-390` (the only file that
encodes the mode differences as behavior: touch punches out on gesture end,
latch on stop, write demotes itself to latch) and
`tracktion_AutomationCurve.h:56` (`float value = 0, curve = 0` per point).
`automationTargetKey()` is already the per-param identity this needs.
Fixes **D15**.

### 3.10 Beat-quantized launch → follow actions — #60 → #61
**From** `tracktion_LaunchHandle.h` (whole queue state machine in one header;
`advance(SyncRange)` splits the block at the queued beat) then
`tracktion_FollowActions.h/.cpp` (group-relative selectors + chance weighting,
richer than the audit's 4-variant enum).
Replaces our seconds-vs-anchor quantization with monotonic beats. Fixes **D19**.

### 3.11 Modulation source + assignment abstraction — #62 #63
**From** `tracktion_MacroParameter.h` + `AutomatableParameter.cpp:344`
(a macro *is* an automatable parameter; assignment carries depth+offset);
WebAudio wiring from `soundscape/packages/engine/src/audio/VoiceSynthesizer.ts:110-135`.
#62 and #63 are the same missing abstraction. Generalize `nodefiLive.ts`'s
control-mod ticker rather than rewriting it.

### 3.12 Small wins (each ≤30 lines)
- `soundscape/apps/editor/src/state/history.ts:32-45` — semantic `coalesceKey`
  instead of our 300 ms temporal coalescing (**#47**); plus **D7**, **D8**.
- `soundscape/.../NoteEditor.tsx:113-131` — note copy/paste (**#49**).
- `ACE/src/store/projectStore.ts:2376` — `beforeunload` flush (**D9**).
- `ACE/src/engine/TrackNode.ts:66-84,:217` — per-channel metering in the graph
  (**#22**).
- `ACE/src/utils/waveformPeaks.ts:11-53` — raw stereo min/max peaks (**D16**);
  `waveformMipmapService.ts` for zoom levels (**#21**).

### 3.13 Memory: unify the decode caches — do this before any streaming work
Every audio path decodes a whole file to an in-RAM `AudioBuffer`. The cost is
fixed by the format, not the player: 44.1 kHz stereo float32 is ~0.35 MB per
second decoded, so a 4-minute track is ~85 MB and a 20-track project is
~1.7 GB resident. On top of that we keep **three independent decode caches**
(`liveMixer.ts:70` WeakMap, `:74` analysisCache, `DawSessionGrid.tsx:477-482`)
and every bounce builds a **fresh local cache** (`WaveformEditor.tsx:2370`,
`:2730`), so rendering a project that is already loaded roughly doubles peak
memory. Invisible on a 128 GB workstation; a large project will OOM the
renderer process in the packaged app on a 16 GB laptop.
**Fix:** one shared decode cache the renderers read from. Small, and it buys
the headroom that makes §3.14 a "when needed", not a "now".

### 3.14 Disk streaming — #66 — deferred, but Electron makes it real
theDAW ships as `thedaw-desktop` (Electron 42, `electron-ui/`), so "browser
buffering" is not the constraint. Two things Electron gives us that a web page
does not:
- **A real filesystem thread.** The main process has `fs`; that is Ardour's
  butler thread (`disk_reader.cc:307` drains a per-channel ring on the RT
  side, a butler refills it, invalidation is an atomic reason bitmask
  `:71,:595,:657-659`). The renderer is `sandbox: true`
  (`electron-ui/main/index.ts:585`), so the stream comes through the preload
  bridge or a stream/Range handler on the `app://` protocol — not direct `fs`.
- **SharedArrayBuffer.** `protocol.handle('app', …)` at `main/index.ts:718`
  is ours, so the packaged build can send
  `Cross-Origin-Opener-Policy: same-origin` +
  `Cross-Origin-Embedder-Policy: require-corp` and get SAB; in dev it is a
  two-line `server.headers` in `frontend/vite.config`. The ring buffer is then
  an AudioWorklet reading a SAB the main process fills.
Build it when project size forces it, after §3.13. The same SAB unlock is what
**#29 live VST3** needs (ACE's `VST3PluginAdapter.ts:103-118` SAB ring +
worklet) — the "COOP/COEP unverified" risk noted in §3.1 is not a risk; we own
the protocol handler.

### Deferred
- **#67 resampling** — Tracktion `ResamplingQuality`
  (`utilities/tracktion_AudioUtilities.h:17`). Backend is the right home
  (soxr / libsamplerate); the lock rule in `CLAUDE.md` applies to the new dep.
- **#42 MPE** — blocked on #36 gaining per-note expression data. Daniel's
  pitch-bend lanes are the prerequisite half.

---

## 4. Sequencing

```
§1 catch up to daniel          ← nothing else starts first
 ├─ §3.1 plugin engine         (independent; fixes D2, D3)
 ├─ §3.2 tempo+meter module ──→ §3.4 metronome
 ├─ §3.3 clip utilities        (fixes D4, D5)
 ├─ §3.5 render queue          (fixes D6)
 ├─ §3.6 routing map ─────────→ buses, sends, sidechain
 ├─ §3.7 recording ───────────→ punch → MIDI capture → takes → comping
 ├─ §3.8 latency decl ────────→ PDC
 ├─ §3.9 touch/latch + curves
 ├─ §3.10 launch handle ──────→ follow actions
 ├─ §3.11 modulation
 └─ §3.12 small wins           (any time)
```

## 5. Rules for anyone executing this

- `oss-refs/` is **reference only** and gitignored. Nothing is copied in
  without noting the source file and its licence in the commit.
- Do not write the audit's proposed snippets for **#04, #06, #15, #17, #27,
  #34, #47, #52, #60, #61, #66, #67** — each is either weaker than code we
  already ship or inadequate against the real implementation. #69's
  `LatencyCalibration` interface is the one snippet better than what we have.
- Never cite `backend/modules/chimera/`, `backend/modules/dawimport/`,
  `VST-Foundry-UI/`, `frontend/src/suno/` or any venv as coverage for a DAW
  feature. Parsing another DAW's warp/take data on import is not implementing
  warp or takes.
- Respect `docs/design/LOCAL-ADDITIONS-MODULARIZATION.md` while it is in force.
