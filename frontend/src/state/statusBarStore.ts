import { create } from 'zustand';
import { logError, logInfo, logWarn } from './logStore';
import { postStatus, type PostStatusOptions, type StatusLevel } from './statusNoticeStore';

interface StatusBarStoreState {
  text: string;
  healthy: boolean | null;
  isBackendReady: boolean;
  /** Post a one-line status. It is kept as `text`, written to the LOG and shown
   *  in the orb's speech bubble (statusNoticeStore.postStatus). `options` sets
   *  the LOG source or level, or `logged: true` when the caller wrote the LOG
   *  line for this event itself. */
  setText: (text: string, options?: PostStatusOptions) => void;
  refreshHealth: () => Promise<void>;
}

/** The health line the last poll produced, so a heartbeat that reads the same
 *  posts nothing. */
let lastHealthText: string | null = null;
/** Whether any poll has read a healthy API. Until one has, a good reading is the
 *  launch reaching a backend that is still binding, and it is not a recovery. */
let everHealthy = false;

/** A health reading that changed goes to the bubble. `logged` is true when the
 *  health check wrote its own LOG line for the change. */
function reportHealth(text: string, level: StatusLevel, logged: boolean): void {
  postStatus(text, { source: 'health', level, logged });
}

export const useStatusBarStore = create<StatusBarStoreState>()((set, get) => ({
  text: 'READY',
  healthy: null,
  isBackendReady: false,

  setText: (text, options) => {
    set({ text });
    postStatus(text, options);
  },

  refreshHealth: async () => {
    const previousHealthy = get().healthy;
    const previousText = lastHealthText;
    try {
      const response = await fetch('/api/health');
      // Backend port is bound — mark ready regardless of health status
      set({ isBackendReady: true });

      if (!response.ok) {
        const text = `HEALTH FAIL (${response.status})`;
        if (previousHealthy !== false) {
          logError('health', `API responded ${response.status}`);
          // Before the API has ever answered, a 502 is the dev proxy reporting a
          // backend that has not bound yet: the LOG keeps it, the bubble does not.
          if (everHealthy || response.status !== 502) reportHealth(text, 'error', true);
        }
        lastHealthText = text;
        set({ healthy: false, text });
        return;
      }

      const payload = (await response.json()) as { status?: string; model_loaded?: boolean };
      const healthy = payload.status === 'ok';
      // model_loaded is false whenever no model is in memory, loading or not.
      const text = healthy
        ? payload.model_loaded
          ? 'API HEALTHY // MODEL LOADED'
          : 'API HEALTHY // NO MODEL LOADED'
        : 'API UNHEALTHY';
      if (healthy) {
        if (!everHealthy) {
          // The first good reading, on the first poll or after the backend took
          // a few polls to bind: a LOG line, and the greeting keeps the bubble.
          logInfo('health', payload.model_loaded ? 'API healthy, model loaded' : 'API healthy, no model loaded');
        } else if (previousHealthy !== true) {
          logInfo('health', payload.model_loaded ? 'API recovered (model loaded)' : 'API recovered (no model loaded)');
          reportHealth(text, 'info', true);
        } else if (text !== previousText) {
          // A model loaded or unloaded: the health check writes no line for it.
          reportHealth(text, 'info', false);
        }
        everHealthy = true;
      } else if (previousHealthy !== false || text !== previousText) {
        // The API answers but is not healthy: on the first reading, after a
        // healthy one, or after a failed or unreachable one.
        logWarn('health', previousHealthy === true ? 'API now reporting unhealthy' : 'API responded but not healthy');
        reportHealth(text, 'warn', true);
      }
      lastHealthText = text;
      set({ healthy, text });
    } catch {
      const text = 'API UNREACHABLE';
      // Only log if we previously had a working connection and just lost it.
      // Swallow startup ECONNREFUSED silently — the backoff poller handles retries.
      if (previousHealthy === true) {
        logError('health', 'API unreachable');
        reportHealth(text, 'error', true);
      }
      lastHealthText = text;
      set({ healthy: false, text });
    }
  },
}));
