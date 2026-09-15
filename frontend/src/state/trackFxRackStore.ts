/**
 * EDIT's track FX rack: which lane's rack is open, and the click it opened at.
 *
 * One rack at a time. The rack belongs to its lane: the moment the lane leaves
 * the arrangement (removed, or replaced by a project load) the rack closes. An
 * undo that brings the lane back therefore brings it back with its rack closed.
 * Kept as component state, the rack held the removed lane's id, rendered nothing
 * while the lane was gone, and reopened by itself when undo restored the lane.
 */
import { create } from 'zustand';
import { useEditorStore } from './editorStore';

export interface TrackFxRackAnchor {
  trackId: string;
  /** Viewport px of the click that opened the rack. Both undefined opens the
   *  rack at its fixed fallback spot. */
  x?: number;
  y?: number;
}

interface TrackFxRackState {
  rack: TrackFxRackAnchor | null;
  /** Open the rack of a lane in the arrangement; an unknown lane is ignored. */
  open: (anchor: TrackFxRackAnchor) => void;
  /** Close the rack when it is open on the anchor's lane, else open it there. */
  toggle: (anchor: TrackFxRackAnchor) => void;
  close: () => void;
}

const laneExists = (trackId: string): boolean =>
  useEditorStore.getState().tracks.some((t) => t.id === trackId);

export const useTrackFxRackStore = create<TrackFxRackState>((set, get) => ({
  rack: null,
  open: (anchor) => {
    if (!laneExists(anchor.trackId)) return;
    set({ rack: anchor });
  },
  toggle: (anchor) => {
    if (get().rack?.trackId === anchor.trackId) set({ rack: null });
    else get().open(anchor);
  },
  close: () => {
    if (get().rack) set({ rack: null });
  },
}));

// Runs inside the same store write that drops the lane, so no render, effect or
// undo can see an open rack on a lane that is gone.
useEditorStore.subscribe((state, prev) => {
  if (state.tracks === prev.tracks) return;
  const { rack, close } = useTrackFxRackStore.getState();
  if (rack && !state.tracks.some((t) => t.id === rack.trackId)) close();
});
