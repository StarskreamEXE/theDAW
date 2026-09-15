import React, { useEffect, useState } from 'react';
import { useBootStatusStore } from '../../state/bootStatusStore';

interface ParticleSplashProps {
  onSkip: () => void;
  onComplete?: () => void;
}

/** The loader page's own completion event (see public/splash/index.html). */
const COMPLETE_EVENT = 'thedaw:loader-complete';

/**
 * The boot screen's React half: the setup status, the setup error, and the
 * "continue without backend" escape, drawn over the boot sequence.
 *
 * The sequence itself (public/splash/index.html: particles form the face, the
 * face becomes the theDAW wordmark, then "by" and the GANTASMO logo arrive and
 * the whole thing spins out) is an iframe in index.html, so the browser runs
 * it from the first byte instead of waiting for the app bundle and a React
 * commit. This component only adopts that frame: it listens on it for the
 * page's complete event and reports it upward. App.tsx fades and removes the
 * #boot-splash node once the backend is ready too.
 *
 * The page falls back to a static wordmark on its own when WebGL is
 * unavailable, and still fires the same event, so the host never hangs.
 * `data-boot-splash` is the stable hook the capture harness waits on.
 */
export const ParticleSplash: React.FC<ParticleSplashProps> = ({ onSkip, onComplete }) => {
  const [elapsed, setElapsed] = useState(0);
  const bootStatus = useBootStatusStore((s) => s.status);
  const bootLogs = useBootStatusStore((s) => s.logs);
  const bootError = useBootStatusStore((s) => s.error);

  useEffect(() => {
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // The event fires on the frame's own window, which does not exist until the
  // frame has a document — and the frame is already in the DOM before React
  // runs, so it may have loaded already. Poll briefly for the window, then
  // listen; if the sequence was stripped (?nocinematic) report at once.
  useEffect(() => {
    const frame = document.getElementById('boot-splash-frame') as HTMLIFrameElement | null;
    if (!frame) {
      onComplete?.();
      return;
    }
    let target: Window | null = null;
    const done = () => onComplete?.();
    const attach = () => {
      const w = frame.contentWindow;
      if (!w || w === target) return;
      target?.removeEventListener(COMPLETE_EVENT, done);
      target = w;
      w.addEventListener(COMPLETE_EVENT, done);
      // The page may have finished before this listener existed.
      if ((w as { theDAWLoader?: { isComplete?: boolean } }).theDAWLoader?.isComplete) done();
    };
    frame.addEventListener('load', attach);
    attach();
    const poll = setInterval(attach, 100);
    const stopPolling = setTimeout(() => clearInterval(poll), 10000);
    return () => {
      clearInterval(poll);
      clearTimeout(stopPolling);
      frame.removeEventListener('load', attach);
      target?.removeEventListener(COMPLETE_EVENT, done);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div data-boot-splash="" className="pointer-events-none fixed inset-0 z-200 select-none overflow-hidden">
      {/* First-run bootstrap status, so a slow or failed setup is visible
          instead of a silent hang. It sits clear of the sequence's own
          progress bar at the foot of the frame. */}
      {(bootError || ((bootStatus || bootLogs.length > 0) && elapsed >= 3)) && (
        <div className="absolute inset-x-0 bottom-20 flex flex-col items-center gap-1 px-6 text-center">
          {bootError ? (
            <div className="max-w-xl text-[11px] font-mono leading-relaxed text-red-300/90">
              Setup error: {bootError}
            </div>
          ) : (
            <>
              {bootStatus && (
                <div className="text-[11px] font-mono tracking-wide text-zinc-400">{bootStatus}</div>
              )}
              {bootLogs.length > 0 && (
                <div className="max-w-xl truncate text-[9px] font-mono text-zinc-600">
                  {bootLogs[bootLogs.length - 1]}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Real escape after a genuine wait, or immediately on a setup error. */}
      {(elapsed >= 40 || bootError) && (
        <button
          type="button"
          onClick={onSkip}
          className="pointer-events-auto absolute bottom-2 right-3 text-[9px] font-mono text-zinc-700 underline transition-colors hover:text-zinc-400"
        >
          Continue without backend
        </button>
      )}
    </div>
  );
};
