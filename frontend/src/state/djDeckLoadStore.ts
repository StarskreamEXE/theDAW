import { create } from 'zustand';

/**
 * A one-shot request from outside the DJ tab to put a library entry on a deck.
 * DJView keeps the deck track ids as its own state, so a caller elsewhere (the
 * footer track menu) cannot load a deck directly: it writes the request here
 * and switches to DJ, and DJView consumes it the way it consumes
 * useDjAutomix's pendingStart. A request made while DJ is closed is consumed
 * when the tab mounts.
 */
export type DjDeckSide = 'A' | 'B';

interface DjDeckLoadState {
  pending: { deck: DjDeckSide; entryId: string } | null;
  request: (deck: DjDeckSide, entryId: string) => void;
  consume: () => void;
}

export const useDjDeckLoad = create<DjDeckLoadState>()((set) => ({
  pending: null,
  request: (deck, entryId) => set({ pending: { deck, entryId } }),
  consume: () => set({ pending: null }),
}));
