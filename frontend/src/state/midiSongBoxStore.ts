import { create } from 'zustand';

/**
 * A one-shot request from outside the MIDI dock to put a library entry in the
 * Vocal2MIDI song box. MidiPanel keeps the box as its own state, so a caller
 * elsewhere (the footer track menu) writes the request here and opens the MIDI
 * tab, and MidiPanel consumes it. A request made while the MIDI tab is closed
 * is consumed when the panel mounts.
 */
interface MidiSongBoxRequestState {
  pending: string | null;
  request: (entryId: string) => void;
  consume: () => void;
}

export const useMidiSongBoxRequest = create<MidiSongBoxRequestState>()((set) => ({
  pending: null,
  request: (entryId) => set({ pending: entryId }),
  consume: () => set({ pending: null }),
}));
