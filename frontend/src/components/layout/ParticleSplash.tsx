import React, { useEffect, useRef, useState } from 'react';
import { useBootStatusStore } from '../../state/bootStatusStore';

interface ParticleSplashProps {
  onSkip: () => void;
  onComplete?: () => void;
}

/** The loader page's own completion event (see public/splash/index.html). */
const COMPLETE_EVENT = 'thedaw:loader-complete';

/**
 * The boot screen: the particle sequence in `public/splash/index.html`. A
 * field of particles forms the face, the face becomes the theDAW wordmark,
 * and once the word has formed the page shows "by" and the animated GANTASMO
 * logo under it, then spins the whole thing out.
 *
 * The page is a self-contained bundle (its own three.js, its own WebGL
 * context, its own CSS), so it runs in an iframe: nothing of it leaks into
 * the app's styles, and removing the frame frees its GPU context in one go.
 * The host listens on the frame's window for the page's complete event and
 * reports it upward, exactly as the previous screens reported their
 * formation. The page falls back to a static wordmark on its own when WebGL
 * is unavailable, and still fires the same event, so the host never hangs.
 *
 * Everything the boot screen carried besides the picture stays here: the
 * first-run setup status and error lines, and the "continue without backend"
 * escape after a genuine wait. `data-boot-splash` is the stable hook the
 * capture harness and the tests wait on.
 */
export const ParticleSplash: React.FC<ParticleSplashProps> = ({ onSkip, onComplete }) => {
  const [elapsed, setElapsed] = useState(0);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const bootStatus = useBootStatusStore((s) => s.status);
  const bootLogs = useBootStatusStore((s) => s.logs);
  const bootError = useBootStatusStore((s) => s.error);

  useEffect(() => {
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // The event fires on the frame's window. The listener is attached once the
  // frame has loaded its document (before that there is no window to hear),
  // and re-attached if the frame ever reloads.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let target: Window | null = null;
    const done = () => onComplete?.();
    const attach = () => {
      const w = frame.contentWindow;
      if (!w || w === target) return;
      target?.removeEventListener(COMPLETE_EVENT, done);
      target = w;
      w.addEventListener(COMPLETE_EVENT, done);
    };
    frame.addEventListener('load', attach);
    attach();
    return () => {
      frame.removeEventListener('load', attach);
      target?.removeEventListener(COMPLETE_EVENT, done);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div data-boot-splash="" className="fixed inset-0 z-200 select-none overflow-hidden bg-[#050607]">
      <iframe
        ref={frameRef}
        src="/splash/index.html"
        title="theDAW boot sequence"
        className="absolute inset-0 block h-full w-full border-0 bg-[#050607]"
        allow="autoplay"
      />

      {/* First-run bootstrap status, so a slow or failed setup is visible
          instead of a silent hang. Low-key over the picture; errors stand out. */}
      {(bootError || ((bootStatus || bootLogs.length > 0) && elapsed >= 3)) && (
        <div className="pointer-events-none absolute inset-x-0 bottom-9 flex flex-col items-center gap-1 px-6 text-center">
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
          className="absolute bottom-2 right-3 text-[9px] font-mono text-zinc-700 underline transition-colors hover:text-zinc-400"
        >
          Continue without backend
        </button>
      )}
    </div>
  );
};
