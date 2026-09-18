/**
 * The menu a right-click on a SWAY track opens: audio from the library, from
 * a file on this computer, or from a link, the three sources EDIT's lanes
 * offer. The cockpit reports the click (sway/track-menu) and this host
 * resolves the choice to a library entry, then hands the cockpit a URL it can
 * fetch (sway/load-audio). A file or a link is imported to the library first,
 * so every source ends as a library entry and the app remembers it.
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { Download, FolderOpen, Link2, Loader2, Music } from 'lucide-react';
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
import { LibraryPicker, type LibraryPick } from '../audio/LibraryPicker';
import { importAudioFiles, type AudioImportOrigin } from '../../lib/importAudioFiles';
import { importUrlToLibrary } from '../../lib/onlineImport';
import { AUDIO_ACCEPT } from '../../lib/fileFilters';
import { logError, logInfo } from '../../state/logStore';

export interface SwayTrackMenuRequest {
  trackId: string;
  name: string;
  empty: boolean;
  /** Viewport px, already offset by the cockpit frame's position. */
  x: number;
  y: number;
}

export interface SwayTrackLoad {
  /** The track to place on; null lets the cockpit pick the first empty one. */
  trackId: string | null;
  /** A URL the cockpit can fetch from this origin. */
  url: string;
  name: string;
}

interface Props {
  request: SwayTrackMenuRequest | null;
  onClose: () => void;
  onLoad: (load: SwayTrackLoad) => void;
}

const SWAY_IMPORT_ORIGIN: AudioImportOrigin = {
  prompt: 'Added to a SWAY track',
  tags: ['imported', 'sway'],
};

type Stage =
  | { kind: 'menu' }
  | { kind: 'picker' }
  | { kind: 'link' };

export const SwayTrackMenu: React.FC<Props> = ({ request, onClose, onLoad }) => {
  const [stage, setStage] = useState<Stage>({ kind: 'menu' });
  const [linkUrl, setLinkUrl] = useState('');
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkErr, setLinkErr] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const fileInputId = `sway-track-audio-${uid}`;
  const linkInputId = `sway-track-link-${uid}`;

  // A new request starts at the menu.
  useEffect(() => {
    setStage({ kind: 'menu' });
    setLinkUrl('');
    setLinkErr(null);
  }, [request]);

  // A click into the cockpit never reaches this window: it blurs instead.
  useEffect(() => {
    if (!request || stage.kind !== 'menu') return;
    const onBlur = () => onClose();
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [request, stage.kind, onClose]);

  if (!request) return null;

  const finish = (loads: SwayTrackLoad[]) => {
    loads.forEach((load) => onLoad(load));
    onClose();
  };

  const onPick = (pick: LibraryPick) => {
    if (pick.kind === 'audio') {
      finish([{ trackId: request.trackId, url: pick.entry.audioUrl, name: pick.entry.title || pick.label }]);
    } else if (pick.kind === 'stem') {
      finish([{ trackId: request.trackId, url: pick.url, name: pick.label }]);
    }
  };

  const onFiles = async (files: File[]) => {
    if (files.length === 0) {
      onClose();
      return;
    }
    const { imported } = await importAudioFiles(files, SWAY_IMPORT_ORIGIN);
    // The first file lands on the clicked track; the cockpit gives each of
    // the rest an empty or new track of its own.
    finish(
      imported.map((entry, i) => ({
        trackId: i === 0 ? request.trackId : null,
        url: entry.audioUrl,
        name: entry.title || entry.audioFilename,
      })),
    );
  };

  const runLink = async () => {
    const u = linkUrl.trim();
    if (!u || linkBusy) return;
    setLinkBusy(true);
    setLinkErr(null);
    try {
      const entry = await importUrlToLibrary(u);
      logInfo('sway', `Imported ${entry.title} from a link for ${request.name}`);
      finish([{ trackId: request.trackId, url: entry.audioUrl, name: entry.title }]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Import failed';
      setLinkErr(msg);
      logError('sway', `Link import failed: ${msg}`);
    } finally {
      setLinkBusy(false);
    }
  };

  const items: ContextMenuItem[] = [
    { type: 'header', label: `Add to ${request.name}` },
    {
      type: 'item',
      label: 'Audio from Library…',
      icon: <Music className="w-3 h-3" />,
      onSelect: () => setStage({ kind: 'picker' }),
    },
    {
      type: 'item',
      label: 'Audio from System…',
      icon: <FolderOpen className="w-3 h-3" />,
      // Synchronous: the picker opens only inside the click that chose this row.
      onSelect: () => fileInputRef.current?.click(),
    },
    {
      type: 'item',
      label: 'Audio from a link…',
      icon: <Link2 className="w-3 h-3" />,
      title: 'YouTube, SoundCloud, Bandcamp or a direct audio URL, downloaded into the library first',
      onSelect: () => setStage({ kind: 'link' }),
    },
  ];

  return (
    <>
      {stage.kind === 'menu' && (
        <ContextMenu position={{ x: request.x, y: request.y }} onClose={onClose} items={items} />
      )}
      <LibraryPicker
        open={stage.kind === 'picker'}
        title="Audio for a SWAY track"
        subtitle={request.name}
        anchor={{ x: request.x, y: request.y }}
        tabs={['audio', 'stems']}
        onClose={onClose}
        onPick={onPick}
      />
      {stage.kind === 'link' && (
        <div
          role="dialog"
          aria-label={`Audio from a link for ${request.name}`}
          className="fixed z-50 w-80 hardware-card bg-black/90 border border-purple-500/30 rounded-lg shadow-2xl shadow-purple-900/40 p-3 flex flex-col gap-2"
          style={{ left: Math.min(request.x, window.innerWidth - 336), top: Math.min(request.y, window.innerHeight - 140) }}
        >
          <label htmlFor={linkInputId} className="text-xs font-bold uppercase tracking-wider text-zinc-300">
            Audio from a link for {request.name}
          </label>
          <div className="flex items-center gap-1 bg-black/40 border border-white/10 rounded px-1.5">
            <Link2 className="w-3 h-3 text-zinc-500 shrink-0" />
            <input
              id={linkInputId}
              name={linkInputId}
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void runLink();
                if (e.key === 'Escape') onClose();
              }}
              placeholder="paste a link"
              disabled={linkBusy}
              autoFocus
              className="flex-1 min-w-0 bg-transparent text-xs font-bold text-zinc-100 py-1.5 focus:outline-none placeholder:text-zinc-500 disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => void runLink()}
              disabled={linkBusy || !linkUrl.trim()}
              className="shrink-0 text-purple-300 hover:text-purple-100 disabled:opacity-30"
              title="Download into the library, then onto the track"
              aria-label="Import the link"
            >
              {linkBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            </button>
          </div>
          {linkErr && (
            <span className="text-xs font-bold text-rose-400 truncate" title={linkErr}>
              {linkErr}
            </span>
          )}
          <span className="text-xs text-zinc-400">YouTube, SoundCloud, Bandcamp or a direct audio URL. Spotify is DRM-locked.</span>
        </div>
      )}
      <label htmlFor={fileInputId} className="sr-only">
        Audio files for the SWAY track
      </label>
      <input
        ref={fileInputRef}
        id={fileInputId}
        name={fileInputId}
        type="file"
        accept={AUDIO_ACCEPT}
        multiple
        tabIndex={-1}
        className="sr-only"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          void onFiles(files);
        }}
      />
    </>
  );
};
