/**
 * SAVE for the annotated lyric sheet: the device map as it is on screen, with
 * its marks, its wires and the open finding, as HTML, SVG, PNG or PDF.
 *
 * The sheet is DOM text under an SVG wire layer, so no <svg> holds the whole
 * picture; the file is a snapshot of the sheet's element (domSnapshot): every
 * computed style written inline, the app's fonts embedded, the wire layer
 * carried as it is. HTML is that snapshot on a page of its own (the hover
 * titles on the wires still answer); SVG wraps it in a <foreignObject>; PNG
 * rasterises the SVG at 2x; PDF is the PNG on a page cut to it.
 *
 * Findings hidden by the family filters or the confidence floor are not in
 * the picture, the same as on screen: set the sheet the way it should read,
 * then save.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Download, Loader2 } from 'lucide-react';
import { saveFile } from '../../../lib/saveFile';
import { snapshotElement, snapshotSvg } from '../../../lib/domSnapshot';
import { fileStem, pngToPdf, standaloneHtml, svgToPng } from '../../../lib/exportPicture';
import { logError, logInfo } from '../../../state/logStore';

type Format = 'html' | 'svg' | 'png' | 'pdf';

const ITEMS: Array<{ format: Format; label: string; words: string }> = [
  { format: 'html', label: 'HTML', words: 'The sheet as a page of its own; hover a wire for its words' },
  { format: 'svg', label: 'SVG', words: 'The sheet as one SVG, text and wires together' },
  { format: 'png', label: 'PNG', words: 'The sheet as a 2x image' },
  { format: 'pdf', label: 'PDF', words: 'The sheet as a one-page PDF' },
];

export const SheetSaveMenu: React.FC<{
  sheetRef: React.RefObject<HTMLDivElement | null>;
  title: string;
  /** Class names for the key, so it matches the bar it sits in. */
  className?: string;
  /** The pane has no sheet to save (no analysis, or the lyric is empty). */
  disabled?: boolean;
}> = ({ sheetRef, title, className, disabled }) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Format | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const keyRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      keyRef.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const save = useCallback(
    async (format: Format) => {
      setOpen(false);
      const host = sheetRef.current;
      if (!host || busy) return;
      setBusy(format);
      const stem = `${fileStem(title, 'lyric')}-device-map`;
      try {
        const snap = await snapshotElement(host);
        if (format === 'html') {
          const html = standaloneHtml({
            title: `${title} — device map`,
            body: snap.markup,
            css: snap.fontCss,
            background: snap.background,
            maxWidth: snap.width,
          });
          await saveFile({ blob: new Blob([html], { type: 'text/html;charset=utf-8' }), suggestedName: `${stem}.html`, kind: 'lyric-map' });
          return;
        }
        const svg = snapshotSvg(snap);
        if (format === 'svg') {
          await saveFile({ blob: new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), suggestedName: `${stem}.svg`, kind: 'image' });
          return;
        }
        const png = await svgToPng(svg, snap.width, snap.height, { background: snap.background });
        if (format === 'png') {
          await saveFile({ blob: png, suggestedName: `${stem}.png`, kind: 'image' });
          return;
        }
        const pdf = await pngToPdf(png, snap.width, snap.height, { title: `${title} — device map` });
        await saveFile({ blob: pdf, suggestedName: `${stem}.pdf`, kind: 'score' });
        logInfo('lyrics', `Saved the device map of ${title || 'the lyric'} as PDF`);
      } catch (e) {
        logError('lyrics', `Could not save the device map as ${format.toUpperCase()}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(null);
      }
    },
    [busy, sheetRef, title],
  );

  const menuId = 'la-sheet-save-menu';
  return (
    <span ref={rootRef} className="relative flex shrink-0 items-center">
      <button
        ref={keyRef}
        type="button"
        className={className ?? 'rounded px-1.5 py-0.5 text-zinc-300 hover:bg-white/10 hover:text-zinc-100 disabled:opacity-30'}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled || !!busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title="Save the sheet as it is drawn: the words, the marks, the wires and the open finding, as HTML, SVG, PNG or PDF"
      >
        <span className="flex items-center gap-1">
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />} SAVE
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        </span>
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Save the device map as"
          className="et-opaque absolute left-0 top-full z-30 mt-1 flex w-72 flex-col rounded-md border border-white/10 bg-[#0a080f] p-1 shadow-[0_8px_24px_rgba(0,0,0,0.6)]"
        >
          {ITEMS.map((it) => (
            <button
              key={it.format}
              type="button"
              role="menuitem"
              onClick={() => void save(it.format)}
              className="flex items-baseline gap-2 rounded px-2 py-1 text-left hover:bg-white/10"
              title={it.words}
            >
              <span className="w-12 shrink-0 font-display text-xs font-bold text-zinc-100">{it.label}</span>
              <span className="text-xs font-bold text-zinc-400">{it.words}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
};
