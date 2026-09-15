import { create } from 'zustand';

/**
 * A one-shot request from outside EDIT to show the Metamorph panel. The panel's
 * open state is WaveformEditor's own, so a caller elsewhere (the footer track
 * menu, after loading Metamorph A or B) writes the request here and opens EDIT,
 * and WaveformEditor consumes it. A request made while EDIT is not mounted is
 * consumed when it mounts.
 */
interface MetamorphPanelRequestState {
  pending: boolean;
  request: () => void;
  consume: () => void;
}

export const useMetamorphPanelRequest = create<MetamorphPanelRequestState>()((set) => ({
  pending: false,
  request: () => set({ pending: true }),
  consume: () => set({ pending: false }),
}));
