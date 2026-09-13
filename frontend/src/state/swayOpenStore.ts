// A request for the SWAY tab to boot the embedded cockpit into one project.
//
// The cockpit only reads its boot project from its URL (`?autoplay=`), so
// opening a scene means reloading the iframe. SwayView watches `request` and
// reloads on every change; `nonce` makes a second request for the same target
// a change too.

import { create } from 'zustand';

export interface SwayOpenRequest {
  target: string;
  nonce: number;
}

interface SwayOpenState {
  request: SwayOpenRequest | null;
  openTarget: (target: string) => void;
}

export const useSwayOpenStore = create<SwayOpenState>()((set, get) => ({
  request: null,
  openTarget: (target) => {
    set({ request: { target, nonce: (get().request?.nonce ?? 0) + 1 } });
  },
}));
