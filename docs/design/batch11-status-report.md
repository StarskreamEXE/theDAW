# Batch 11 — full status report

Written 2026-09-18, after all agents were stopped. Every number in section 2 comes from checks
run for this report after the stop, not from agent claims.

## 1. Bottom line

- A large amount of code is written and passes its automated tests.
- **None of it is committed or pushed.**
- **None of it has been run in the real app**, by an agent or by me.
- Three tickets were stopped half-done: joining the native VST host, the second live-VST
  frontend ticket, and promoting the Suno stage into the library.
- Five backend tests fail right now. All five come from those stopped tickets.
- One requirement was built backwards because the guides had it backwards (F03). It has since been
  corrected in code.

## 2. Verified state right now

| Check | Result |
|---|---|
| Frontend type check (`tsc --noEmit`) | exit 0 |
| Frontend tests (`npm test`) | **212 suites passed, 0 failed** (baseline was 169) |
| Python lint (`ruff check .`, `ruff format --check .`) | both clean, 415 files |
| Native host self-test (`thedaw-vst-host --selftest`) | 214 checks, 0 failures; the exe reports `vst3: true` |
| Backend tests for everything this batch touched | **428 passed, 4 failed, 6 skipped** |

- The 6 skipped tests only run when a real plugin is named in an environment variable.
- The 4 failures:
  1. `test_suno_promote::test_an_old_entry_with_no_db_row_is_updated_not_overwritten`. This covers
     the hazard the Suno-promotion agent was fixing when it was stopped.
  2. Three tests in `test_vst_live_host` that assert "host binary missing → 503". They were written
     before the host exe existed. The exe exists now, so the code returns 502, not the 503 they
     expect. The tests need isolating from the real exe. The backend code is not shown to be wrong.
- A fifth test file, `tests/test_vst_render_host.py`, was never created. It was part of the stopped
  host ticket.

## 3. Where everything is

| Thing | Location |
|---|---|
| All code changes | Worktree `C:\Users\skream\projects\_thedaw-batch11`, branch `feat/batch-11`, on top of `personal/main` `721ea5b`. 76 tracked files modified (+11,339 / −1,785 lines) and about 90 new files or folders. Uncommitted. |
| Native host exe and probe | `native/vst-host/bin/thedaw-vst-host.exe` (630 KB) and `vst3_probe.exe`. Both are git-ignored. |
| Build trees, JUCE + VST3 SDK reference copies (reading only), separate frontend `node_modules` | `E:\thedaw-build\` |
| Leftover synthetic benchmark data | `D:\tmp\t47-bench` (not your data) |
| Tickets, contract backups, moved leftovers | `%TEMP%\thedaw-batch11-tickets\` and `E:\thedaw-build\_scratch-from-C\` |
| Task tracking | beans, initialized in the main checkout (`.beans/`, `.beans.yml`) and kept out of git through `.git/info/exclude` |
| My memory notes | Three added or updated: licensing is your call; the guides are second-hand and inverted F03; the fork exists to be merged into public main |

### What I touched in your main checkout (`C:\Users\skream\projects\theDAW`)
- I wrote `docs/design/repair-expansion-report-and-plan.md` there at the start, before the worktree
  existed.
  - Someone else's commit swept that file up at 10:28: `d0adecd`, "docs: plain-English and callout
    user guides, feature-gap plan and reports…", on `feat/dj-performance-sets`.
  - That committed copy is the old version. It still has the wrong stems explanation and the
    inverted F03. The corrected copy is in the worktree.
- I ran `beans init`, which created two untracked entries and two lines in `.git/info/exclude`.
- I touched nothing else there.
- **Its `frontend/node_modules` is broken.**
  - A process that was not mine partly deleted it at 10:32:55. `.bin`, `@babel`, `@coderline` and
    everything else alphabetically before `@esbuild` is gone.
  - Your dev server keeps running from memory, but it will not restart.
  - `npm install` in `frontend` fixes it. I have not touched it.

## 4. What is done, by area

"Done" here means built and unit-tested, not tried in the app.

### Timeline (Edit view)
- **Track reorder (F01):**
  - You drag a grip on the track header to reorder tracks.
  - Alt+↑/↓ and the track menu do the same.
  - A reorder is one undo step.
  - Reordering no longer marks a frozen master as stale.
- **Highlight clears on click-away (F03, corrected):**
  - A left-click in the timeline outside the highlight clears it.
  - A click inside keeps it.
  - Escape clears it.
  - A right-click never clears it.
  - Only one highlight exists at a time.
  - This applies to both the ruler time range and the old clip highlight.
  - **Your confirmation of this exact rule is still pending.**
- **Range right-click menu (F04):** Play, Loop, Split at edges, Copy to inpaint, Zoom to selection,
  Send to gantasmob0t, Clear. Two rows are disabled with a reason (Render selection; stems).
- **Bar/beat grid (F05):**
  - It follows the same tempo as snap.
  - Contrast presets and sliders live in a new Timeline preferences panel.
  - Bar numbers show on the ruler.
- **Click behaviour (F06):**
  - There is a separate edit cursor.
  - A click on a lane or the ruler seeks without stopping playback.
  - A click on a clip while playing only moves the edit cursor.
  - Home and End really seek.
  - Three click profiles sit in preferences.
- **Zoom (F07):** every zoom control (wheel, buttons, keys, fit, zoom-to-selection) centres on the
  edit cursor.
- **Wheel (F08):**
  - Plain wheel zooms time.
  - Ctrl+wheel is a fine zoom.
  - Shift+wheel scrolls sideways.
  - Alt+wheel scrolls up and down.
  - Ctrl+Shift+wheel changes lane height.
  - A "REAPER default" profile is also included.
- **Clip title and buttons (F09):** they stay inside the visible part of a long clip.
- **Drag-select (F15):** drag in empty space selects clips across tracks. Shift, Ctrl and Alt add,
  toggle and remove. It auto-scrolls, and Escape restores the previous selection.
- **Double-click (F18/F19):**
  - A MIDI clip opens the piano roll.
  - An audio clip opens a new Audio Editor drawer with trim, slip, fades, gain and audition.
- **Flaky MIDI double-click, root cause found and fixed:**
  - The root cause was reproduced in Chrome. A 1-pixel wobble between clicks started a clip move
    that snapped the clip away from the mouse.
  - Drags now need 4 px of movement.
- Selection, time range and edit cursor now live in the store. They survive switching between Edit
  and Mix.

### Library (built for 200,000 songs)
- **Counts (F20):** category counts load at startup and stay current.
- **Details pop-up (F11):** double-clicking a row opens a centred pop-up with Overview, Stems,
  Lineage, Used in and Raw metadata.
- **Backend:**
  - The list is paged, sortable and full-text searchable.
  - Measured at 200,000 rows: pages 9–15 ms, search 6 ms, counts 10 ms, whole-library filter
    dropdowns under 77 ms.
- **Folder import:** a background job with progress and cancel.
- **Bulk delete:**
  - It deletes 50,000 entries in 9 s.
  - It never touches source audio.
  - It refuses paths outside the library.
  - Clear-all needs a typed count.
- **Frontend:**
  - The library loads in pages of 200.
  - Search runs on the server.
  - Lists render only what is on screen: Library, Catalogue, the DJ browser and the details pane.
  - Select-all and play-all work from ids.
  - The play queue survives page eviction.

### Suno import (F12)
- **Staging importer:**
  - Identity is by song id and never by title.
  - Every revision is kept.
  - Bad rows are quarantined.
  - Lineage hints are kept.
  - Audio is referenced in place.
  - It is resumable.
  - Ctrl+C is safe.
  - It shows progress and an ETA.
- **Measured at 200,000 synthetic songs:**
  - Your single-JSON format staged in 86 s using 109 MiB of RAM, with the `ijson` C parser.
  - JSONL staged in 104 s.
  - Both were on an NVMe drive.
  - On a hard disk it takes about 16 minutes, so stage on D:.
- The old script's five bugs are fixed.
- `ijson` was added properly: `uv lock` plus `check_lock.py` passes on Linux and Windows.
- **Promotion into the real library is about 70% done. See section 5.**

### Stems (F02, F14)
- **What "12 stems" really produces:**
  - It is 10 files.
  - The mode runs a 6-stem split.
  - Drums are replaced by 5 drum parts, and the drum mix is deleted.
- **Dialog labels:**
  - The dialog is relabelled "Detailed · 10 parts" with exact roles.
  - The quality hints are corrected.
- Each run writes a manifest: expected vs produced, parts vs aggregates, and whether the run was
  complete, partial or degraded.
- Timeline:
  - "Insert stem…" is in the clip menu.
  - Bulk insert skips aggregates.
  - The library path inserts at the edit cursor.

### Assistant (F17)
- "Reference in gantasmob0t" works on clips, tracks and time ranges. It adds a chip and never
  auto-sends.
- References carry ids, never audio or file paths. A missing target is flagged and never
  retargeted.
- Actions now report real succeeded or failed. Before, they always said "executed".
- Not done: new assistant tools such as normalize or set gain.

### VST
- **Old (pedalboard) editor path (F10):**
  - Window choice is smarter and writes a full diagnostic log.
  - The window title shows the plugin name, not "Pedalboard".
  - Restore failures are reported.
  - The correct sub-plugin is selected.
  - There is a Float-window toggle.
  - Real plugin names and vendors are shown.
  - There is a `scripts/vst_probe.py` diagnostic.
- **New: our own native live host**, written by us against the VST3 plugin interface, with JUCE's
  repo as reading material only.
  - **Engine:**
    - It has our own WebSocket server and a real-time audio thread.
    - It has a control plane and a null plugin for tests.
    - Loopback round trip is 0.12–0.15 ms per 512-sample block.
  - **VST3 layer:** loading, buses, processing, parameters, state, editor window.
  - **Proven headless on this machine** with 8 plugins from 4 vendors, **including Ozone 12**:
    - Ozone 12 took 1.3 s to load.
    - It has 873 parameters.
    - Processing took 0.026 ms per block.
    - There were no dialogs.
  - One editor window was opened and closed automatically (AIR Vocal Doubler).
  - The two halves are joined into one exe.
  - The offline `--render` mode works and is sample-exact through Vinyl's 364-sample latency.
- **Backend session manager** (`/api/vst/live/*`): spawn, track, reap, a cap of 24, log tails.
- **Frontend live node:**
  - The worklet bridge, socket client and session registry are in.
  - Latency feeds the existing compensation.
  - Master VST chain entries are wired into the live path.
  - Edit GUI opens the live instance.
  - The FX row shows LIVE status.
  - The Mix rack now lets VSTs through.

### Other
- The Update dialog shows a build ID and warns about a stale bundle.
- `tsx` was bumped from 4.22.1 to 4.23.13. A clean install would otherwise fail one existing test.
- Reference helper code from both guides is extracted to `docs/design/repair-pack/`.

## 5. What is half-done (the three stopped tickets)

**A. Native host integration (T40c)**
- Done: joined build; offline render mode with WAV codec; host-name and interface-logging options.
- State experiment, partly done:
  - Host name, capture point and sample rate are all ruled out as the cause of the state mismatch.
  - The agent then found what looks like a **bit-order bug in our own state encoding**.
  - It edited that code at 11:14. **That edit is unverified.**
  - Its last note: Ozone's own state bytes differ between captures even inside one host, so byte
    comparison is the wrong test for Ozone.
- Not done:
  - real-plugin tests **through the WebSocket** (only the direct probe and render were run on real
    plugins)
  - the backend `state_host=thedaw` render branch
  - the plugin-swap session fix
  - `tests/test_vst_render_host.py`
  - the README update
  - fixing the 3 test-isolation failures

**B. Live VST frontend part 2 (T45)**
- Done, type-checks, tests pass:
  - master VST parameter setter
  - one-undo-step stem separation
  - `state_host` marker on entries
  - state capture on save and autosave
  - bus latency warning
  - "LIVE · defaults" badge for old-editor states
  - render paths send `state_host`
  - Mix rack passes VSTs through
  - session grid and Perform decisions, written with reasons
- Not confirmed:
  - whether the remaining exclusion sites (Sway deck, routing map) are finished
  - nothing was tried against the real host

**C. Suno promotion (T47)**
- Exists:
  - the promotion module (1,516 lines)
  - an 849-line test file
  - CLI
  - benchmark script
  - router endpoints (unverified)
- Failing: 1 test. It covers the hazard the agent was fixing when it was stopped. The hazard: an
  entry folder on disk with no database row would be overwritten.
- Not done: the 200k promotion benchmark (staging had reached 64k of 200k) and the final report
  with API examples.

## 6. Not started (from the 25 requests)

| Item | Status |
|---|---|
| F13 Suno-Labs-style candidate/variation workflows | not started |
| F16 Send a clip to Mix as a linked edit target | not started (live VST groundwork exists) |
| F21 Track folders / groups / collapse | not started (move-subtree helper exists, unwired) |
| F22 Pinned master track row | not started |
| F23 Project/render lineage ("used in") | not started ("Used in" tab shows setlists only) |
| F24 Render a time range | not started (menu row disabled with reason) |
| F25 Full render/export dialog | not started |
| Import-Suno-archive wizard UI | not started (backend endpoints partly exist) |
| New assistant tools (normalize, gain…) | not started |
| Docs / RAG updates for all of the above | not started (approval-based by your rules) |

## 7. Things that went wrong, stated plainly

1. **F03 built backwards.**
   - Both guides say "highlight survives click-away". You wanted the opposite.
   - It has since been corrected in code.
   - The other guide items with a direction (click, zoom, wheel, marquee) are listed for you to
     confirm and are unconfirmed.
2. **Agents ran too long.**
   - My tickets were too big: 5–10 jobs each.
   - Agents loaded too many skills.
   - They ran full test suites and benchmarks inside agents.
   - I resumed them at the turn cap.
   - You stopped three of them.
3. **Only one ticket (T11) got an independent review.** It failed, and the two real bugs were
   fixed. Everything else is unreviewed beyond its own tests.
4. **Wrong stems explanation early on.** I told you "11 parts + drum bus". The code shows 10. The
   worktree copy of the plan is corrected, but the copy committed in the main checkout still has
   the wrong text.
5. **Licensing friction.**
   - I steered on JUCE licensing when it was your call.
   - The final decision is our own host code with JUCE as reading material only. That is how it
     is built.
6. **Your main checkout's `node_modules` was partly deleted at 10:32 by something else.** My
   builders broke too, because the worktree shared it. I moved the worktree to its own copy on E:.
7. **I deleted one scratch results file with `rm`.** Under your rule I should have moved it. The
   data is still in a log.
8. **`docs-mcp-server` never connected this session.** Agents fell back to GitMCP and DeepWiki.
9. **Serena had no Python language server.** Python navigation was done with grep.
10. **13 edited files show CRLF line-ending warnings.** That needs the usual NUL/BOM/CRLF check
    before any commit.

## 8. What is left, in order

1. **Your decisions:**
   - the highlight rule
   - the 7 behaviours I listed (click, zoom, wheel, drag-select, clip titles, track grip,
     double-click)
   - whether I run `npm install` in your main checkout
2. **Finish the three stopped tickets as small pieces:**
   - fix the 4 failing tests
   - verify or revert the state-encoding edit
   - real-plugin test through the socket
   - backend render branch
   - plugin-swap fix
   - Suno promotion hazard fix and 200k benchmark
3. **Integration pass:** line-ending check, full gates again, independent review of the risky
   areas (timeline wiring, live VST node, library delete, promotion).
4. **Try it in the real app and fix what breaks.**
   - Build the frontend against a backend started from the worktree.
   - Timeline gestures.
   - Library at scale.
   - A live VST in the Mix rack with its editor open.
5. **Commit and push to `personal`.**
6. **On your machine after the push:**
   - Ozone live and its editor through the new host.
   - Stage your real Suno cache on D: (about 1.5 minutes).
   - A dry-run promotion before the real one.
7. **The not-started items in section 6, one small ticket at a time.**
