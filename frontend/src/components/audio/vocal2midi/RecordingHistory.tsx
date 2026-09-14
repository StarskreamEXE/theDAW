import React, { useState } from 'react';
import { Trash2, Download, Upload, Clock, Music, FolderOpen } from 'lucide-react';
import type { RecordingEntry, ScaleType } from './types';
import { NOTE_NAMES } from './constants';
import { KnownFilesMenu } from '../../ui/KnownFilesMenu';

interface RecordingHistoryProps {
  recordings: RecordingEntry[];
  onLoad: (recording: RecordingEntry) => void;
  onDelete: (id: string) => void;
  onClearAll: () => void;
  onExportAll: () => void;
  onImport: (recordings: RecordingEntry[]) => void;
}

/** Hover lift for the small icon actions (a fill, never `hover:bg-*`, which the
 *  theme scope's background remaps outrank). */
const ICON_ACTION = 'p-1.5 rounded-xs et-ink-3 transition-[color,box-shadow] hover:shadow-[inset_0_0_0_100px_rgba(255,255,255,0.08)]';

const RECENT_ID = 'vocal2midi-history-recent';
const RECENT_EXTS = ['.json'];
// Vocal2MidiPanel saves its recordings export under this kind, so the list
// offers those files and no other JSON the app saved.
const RECENT_KINDS = ['v2m-recordings'];

/** Saved Vocal2MIDI takes. Ink is the theme's; the one accent marks the count
 *  and each take's glyph; destructive actions go red on hover. */
export const RecordingHistory: React.FC<RecordingHistoryProps> = ({
  recordings,
  onLoad,
  onDelete,
  onClearAll,
  onExportAll,
  onImport
}) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const getKeyName = (rootNote: number, scale: ScaleType) => {
    return `${NOTE_NAMES[rootNote % 12]} ${scale}`;
  };

  // Shared by the file dialog and the Recent menu, which hands over a file the
  // app saved earlier.
  const importFiles = async (files: File[]) => {
    const file = files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      // Validate it's an array of recordings
      if (Array.isArray(data) && data.every(r => r.id && r.notes && r.timestamp)) {
        onImport(data);
      } else if (data.id && data.notes && data.timestamp) {
        // Single recording
        onImport([data]);
      } else {
        alert('Invalid recording file format');
      }
    } catch {
      alert('Failed to parse recording file');
    }
  };

  const handleImportClick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
      void importFiles(Array.from((e.target as HTMLInputElement).files ?? []));
    };
    input.click();
  };

  if (recordings.length === 0 && !isExpanded) {
    return (
      <div className="bg-zinc-900 border border-white/10 rounded-xs p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock aria-hidden="true" size={14} className="et-ink-3" />
            <span className="text-xs font-semibold et-ink-2">Recording History</span>
          </div>
          <div className="flex items-center gap-2">
            <KnownFilesMenu id={RECENT_ID} exts={RECENT_EXTS} kinds={RECENT_KINDS} size="flyout" onFiles={(files) => void importFiles(files)} />
            <button
              type="button"
              onClick={handleImportClick}
              className="text-[12px] font-semibold et-ink-3 hover:et-ink transition-colors flex items-center gap-1"
            >
              <Upload aria-hidden="true" size={10} /> Import
            </button>
          </div>
        </div>
        <p className="text-[12px] font-semibold et-ink-3 mt-2">No recordings saved yet</p>
      </div>
    );
  }

  return (
    <div className="bg-zinc-900 border border-white/10 rounded-xs p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          aria-expanded={isExpanded}
          className="flex items-center gap-2 et-ink-2 hover:et-ink transition-colors"
        >
          <Clock aria-hidden="true" size={14} />
          <span className="text-xs font-semibold">Recording History</span>
          <span className="text-[12px] font-bold tabular-nums text-[rgb(var(--et-accent))] bg-white/10 px-1.5 py-0.5 rounded-xs">
            {recordings.length}
          </span>
        </button>

        <div className="flex items-center gap-2">
          <KnownFilesMenu id={RECENT_ID} exts={RECENT_EXTS} kinds={RECENT_KINDS} size="flyout" onFiles={(files) => void importFiles(files)} />
          <button
            type="button"
            onClick={handleImportClick}
            className={`${ICON_ACTION} hover:et-ink`}
            aria-label="Import recordings"
            title="Import recordings"
          >
            <Upload aria-hidden="true" size={12} />
          </button>
          {recordings.length > 0 && (
            <>
              <button
                type="button"
                onClick={onExportAll}
                className={`${ICON_ACTION} hover:et-ink`}
                aria-label="Export all recordings"
                title="Export all recordings"
              >
                <Download aria-hidden="true" size={12} />
              </button>
              <button
                type="button"
                onClick={onClearAll}
                className={`${ICON_ACTION} hover:text-red-400`}
                aria-label="Clear all recordings"
                title="Clear all recordings"
              >
                <Trash2 aria-hidden="true" size={12} />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Recording List */}
      {isExpanded && (
        <div className="space-y-2 max-h-48 overflow-y-auto">
          {recordings.map((recording) => (
            <div
              key={recording.id}
              className="bg-black/30 border border-white/10 rounded-xs p-2 transition-shadow hover:shadow-[inset_0_0_0_100px_rgba(255,255,255,0.04)] group"
            >
              <div className="flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <Music aria-hidden="true" size={10} className="text-[rgb(var(--et-accent))] shrink-0" />
                    <span className="text-xs font-semibold et-ink truncate">{recording.name}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 mt-1 text-[12px] font-semibold et-ink-3">
                    <span>{formatDate(recording.timestamp)}</span>
                    <span>|</span>
                    <span>{recording.notes.length} notes</span>
                    <span>|</span>
                    <span>{recording.bpm} BPM</span>
                    <span>|</span>
                    <span>{getKeyName(recording.rootNote, recording.scale)}</span>
                  </div>
                </div>

                {/* Shown on hover, and whenever a keyboard user is on them. */}
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                  <button
                    type="button"
                    onClick={() => onLoad(recording)}
                    className={`${ICON_ACTION} hover:et-ink`}
                    aria-label={`Load ${recording.name}`}
                    title="Load recording"
                  >
                    <FolderOpen aria-hidden="true" size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(recording.id)}
                    className={`${ICON_ACTION} hover:text-red-400`}
                    aria-label={`Delete ${recording.name}`}
                    title="Delete recording"
                  >
                    <Trash2 aria-hidden="true" size={12} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {!isExpanded && recordings.length > 0 && (
        <button
          type="button"
          onClick={() => setIsExpanded(true)}
          className="text-[12px] font-semibold et-ink-3 hover:et-ink transition-colors"
        >
          Click to expand ({recordings.length} recordings)
        </button>
      )}
    </div>
  );
};
