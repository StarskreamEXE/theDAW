# EDIT tab - feature gap: StarskreamEXE (batches 1-9) vs danieljtrujillo

What the StarskreamEXE fork added to the EDIT tab that danieljtrujillo/main did not have, and the reverse. Compared at the split point b387d30 -> StarskreamEXE 5a68890 vs danieljtrujillo 38f23c5 (2026-09-17). 'Where' names the module that owns it; batches are the docs/runs/P-20260915-batchN.md run records.

## Only in StarskreamEXE - 35 EDIT-tab features

### Transport & timing

| Feature | Landed | Where |
|---|---|---|
| Metronome click + count-in (0/1/2/4 bars) | batch 4 | `lib/metronome.ts, state/metronomeStore.ts, PlayerFooter` |
| One tempo + meter module; beatClock is the single tempo owner (fixes four different BPM clamps) | batch 3 | `lib/tempo*, beatClock.ts` |
| Playhead cursor compensated for output latency during playback | batch 8 | `liveMixer.outputLatencySec` |

### Clip editing

| Feature | Landed | Where |
|---|---|---|
| Slip (Alt-drag), stretch-to-fit (Shift-drag edge), crossfade between neighbours, per-fade Linear / Exponential / Equal-power curves | batch 4 | `WaveformEditor gestures, lib/{clipFade,clipDragMath,crossfade,audioWarp}.ts` |
| Non-destructive stretch / warp at schedule time; one shared fade envelope so preview == export | batch 4 | `liveMixer.ts` |
| Split re-clamps fades per half (was copying both fades onto both halves) | batch 4 | `editorStore.splitClipAt` |
| Undo step opened at clip / fade pointer-down | batch 4 | `editorStore.beginUndoStep` |
| Semantic undo coalescing (coalesceKey) instead of a 300 ms timer; master-VST rack edits undoable | batch 9 | `editorStore history` |

### Automation

| Feature | Landed | Where |
|---|---|---|
| Touch / Latch / Write modes with punch-out on gesture end / stop; per-point curve handles on the lane | batch 5 | `lib/automationModes.ts, AutomationLane.tsx` |
| Curved envelopes applied live and offline | batch 5 | `liveMixer, renderCore` |
| Every fader, knob, XY pad and bespoke pad reports a real gesture boundary (no window listeners) | batches 6, 7, 9 | `SlideTrack, EffectKnob, EffectXYPad, OwlPad, SpatializerPad` |
| Pan / in-chain automation lead-compensated live, mirrored offline | batch 9 | `liveMixer.laneEnvelopeEvents, renderCore.scheduleParamLane` |

### Routing & mixing

| Feature | Landed | Where |
|---|---|---|
| Routing graph: buses, sends with gain, cycle refusal, topological wiring; malformed-graph fallback | batches 5, 6 | `state/routingGraph.ts, editorStore routing/buses, liveMixer` |
| Mixer-strips drawer: per-track / bus output select, sends, bus strips, master strip, add / remove bus | batch 7 | `components/audio/MixerStrips.tsx` |
| Per-strip meters (post-comp analysers) | batch 9 | `state/stripMeters.ts` |
| Routing saved and loaded in .tasmo (output_routing, send_amounts, buses) | batch 8 | `tasmo_project.py, lib/projectImport.ts` |

### Latency (PDC)

| Feature | Landed | Where |
|---|---|---|
| Latency declared per effect; chain and summing latency computed | batch 5 | `lib/rackEffects.ts` |
| Per-track compensation DelayNode after the panner (Tracktion summing rule); DJ delay-comp on the same maths | batch 6 | `liveMixer.syncTrackLatency, djEngine` |
| Offline per-track compensation delays; bounce trimmed by the max comp | batches 8, 9 | `renderCore` |

### Rendering

| Feature | Landed | Where |
|---|---|---|
| One offline render core replaces the four copy-pasted renderers; A/B-proven within 1e-4 | batches 5, 6 | `lib/renderCore.ts, scripts/ab-bounce` |
| Render job queue with staged progress and cancel; MIXDOWN / freeze / stem are jobs; R shortcut; progress pill | batch 7 | `state/renderJobs.ts` |
| Bounce wires the routing graph offline (buses, sends); stems render pre-routing | batch 8 | `renderCore.wireRoutingGraph` |

### Recording

| Feature | Landed | Where |
|---|---|---|
| Recording engine: transport-anchored takes, one stream for many armed tracks, level feed, typed errors | batch 6 | `lib/recordingEngine.ts` |
| Arm button live, take level meter in the track header; RECORD key in the footer + R | batch 7 | `state/recordingStore.ts, WaveformEditor, PlayerFooter` |
| Count-in before record; takes land as clips in one undo step; musical mic profile (no AGC / echo-cancel) | batch 7 | `recordingStore` |
| Punch in / out / in-out over the loop region; takes cropped at placement; window overlay; mode reachable at every width via the RECORD key's right-click menu | batches 8, 9 | `recordingStore.punch, PlayerFooter, ContextMenu` |
| MIDI capture into armed MIDI tracks (parse, note pairing, seconds -> steps) | batch 9 | `lib/midiCapture.ts` |

### Piano roll

| Feature | Landed | Where |
|---|---|---|
| Undo history for the piano roll | batch 2 | `pianoRollStore` |
| Copy / cut / paste / duplicate notes | batch 9 | `lib/noteClipboard.ts` |

### Session grid (PERFORM, EDIT-adjacent)

| Feature | Landed | Where |
|---|---|---|
| Beat-quantised launch queue on the one clock (replace-not-stack tickets, ClockGrid select, queued state) | batch 8 | `lib/launchQueue.ts, DawSessionGrid` |
| Follow actions, saved in .tasmo | batch 9 | `lib/followAction.ts` |

### Plugins & FX (EDIT racks)

| Feature | Landed | Where |
|---|---|---|
| VST3 chain entries resolve into the live graph (they were silently dropped); bypass keeps the instance (tails survive); inert entries stay visible | batch 2 | `lib/rackEffects.ts` |
| pitch_shift is real pitch shifting (was a frequency shifter) | batch 1 | `backend/modules/effects/router.py` |
| Modulation sources -> targets abstraction (control-rate + audio-rate); NodeF.I. delegates to it | batch 9 | `lib/modulation.ts` |

### Memory

| Feature | Landed | Where |
|---|---|---|
| One shared decode cache for the mixer, analysis and every bounce (was three caches + a fresh one per render) | batch 3 | `lib/decodeCache` |

## Only in danieljtrujillo - 6 EDIT-tab changes (all UI)

### EDIT tab UI

| Change | Commit | Where |
|---|---|---|
| MASTER FX, METAMORPH and the automation-lanes panel open under the key that asked for them (PopoverPortal), not pinned top-left | 8155f83 | `WaveformEditor.tsx` |
| Track FX rack opens under its key (fxRackUnder) instead of at the pointer pushed past the header column | 8155f83 | `WaveformEditor.tsx` |
| COMMIT EDIT renamed MIXDOWN / MIXING DOWN... | 8155f83 | `WaveformEditor.tsx` |
| Action keys are their word, the transport is its icons; IMPORT and Recent restyled | b7b664e | `PlayerFooter, header` |

### Footer (shared with EDIT)

| Change | Commit | Where |
|---|---|---|
| Symmetric footer: now-playing and Next share one width, state word (PLAYING / PAUSED / IDLE), Like and Share always shown and greyed while idle, key legends removed, w-9 keys | ae9ae36, 7982bcc | `PlayerFooter.tsx` |
| Orb bubble moved clear of the scrub strip; shown from 2xl | 7982bcc | `OrbTipBubble` |

### Outside EDIT (for reference)

| Change | Commit | Where |
|---|---|---|
| Meter map drawn in DETAILS, lyric device-map export, tempo rule for staircases, RHYTHM_VERSION 3 | rhythm / meter-map PRs | `DETAILS, backend rhythm` |
| Score notation maker, pinned STRIP part names, collapsible rail | cf4dcc7 | `SCORE` |
| v0.2.0 release, update feed ships with the installer, particle boot splash, Electron listener fix, no-glyph log, Magenta OOM retry, Pinokio guide | various | `release / boot / docs` |

## Notes

- Both trees already have Daniel's earlier piano-roll work (PianoNote.lane, RollMeter meterMap / pickupSteps / lanes, pitch-bend lanes): it predates the split at b387d30.
- Daniel's EDIT-tab commits touch only WaveformEditor.tsx and PlayerFooter.tsx (250 lines net). Nothing on his side adds an EDIT engine feature that ours lacks.
- As of 9662cc9 (StarskreamEXE main) both sides are merged: every item on both lists is now in the fork.
