import { create } from 'zustand';
import { ApiError } from '../lib/apiJson';
import { vstApi, type Vst3PluginInfo } from '../lib/vstClient';
import { logError, logInfo } from './logStore';
import { useStatusBarStore } from './statusBarStore';

/** True when the backend refused the scan because VST hosting only exists in
 *  the desktop shell — a 403, or any other 4xx that says so in its own words.
 *
 *  This is not a failure. `/api/vst/scan` is gated (backend/lib/cross_site.py)
 *  and a plain browser tab is *supposed* to be turned away; treating that as an
 *  error put "VST SCAN FAILED: This request must come from theDAW's desktop
 *  shell." in the log and the status bar on every browser launch. */
export const isDesktopOnlyRefusal = (e: unknown): boolean => {
  if (!(e instanceof ApiError)) return false;
  if (e.status === 403) return true;
  return e.status >= 400 && e.status < 500 && /desktop shell|desktop app/i.test(e.message);
};

/** The quiet notice is shown once per session, not once per scan: MIX and the
 *  editor both call `scan()`, and the browser's answer will not change. */
let desktopOnlyNoticeShown = false;

/** Tests only — the notice is a process-lifetime latch by design. */
export const resetDesktopOnlyNotice = (): void => {
  desktopOnlyNoticeShown = false;
};

// Holds the scanned VST3 plugin list for the MIX effects browser. Plugins are
// added to the effect chain as 'vst3' nodes (see effectChainStore.addVst) and
// processed per-stage by studioStore via /api/vst/process-file.
interface VstState {
  plugins: Vst3PluginInfo[];
  scanning: boolean;
  scanned: boolean;
  error: string | null;
  /** Why there are no plugins *here*, in the backend's own words, when the
   *  scan was refused rather than failed. Null whenever `error` is the answer
   *  (a real failure) or the scan worked. */
  unavailableReason: string | null;
  scan: (refresh?: boolean) => Promise<void>;
}

export const useVstStore = create<VstState>()((set) => ({
  plugins: [],
  scanning: false,
  scanned: false,
  error: null,
  unavailableReason: null,

  scan: async (refresh = false) => {
    set({ scanning: true, error: null });
    try {
      logInfo('vst', `GET /api/vst/scan refresh=${refresh}`);
      const res = await vstApi.scan(refresh);
      set({ plugins: res.plugins, scanning: false, scanned: true, unavailableReason: null });
      if (refresh) {
        useStatusBarStore.getState().setText(`VST SCAN: ${res.plugins.length} plugin(s)`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'VST scan failed.';
      if (isDesktopOnlyRefusal(e)) {
        // Scanned, and the answer is "none here". `scanned` is set so nothing
        // asks again in a loop, and no logError: this is the documented shape
        // of the browser build, not a fault the user can act on.
        set({ scanning: false, scanned: true, plugins: [], error: null, unavailableReason: msg });
        if (!desktopOnlyNoticeShown) {
          desktopOnlyNoticeShown = true;
          useStatusBarStore.getState().setText('VST: desktop app only');
        }
        return;
      }
      set({ scanning: false, error: msg, unavailableReason: null });
      useStatusBarStore.getState().setText(`VST SCAN FAILED: ${msg}`);
      logError('vst', msg);
    }
  },
}));
