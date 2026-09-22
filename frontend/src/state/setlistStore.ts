/**
 * Setlist store — persistent named playlists of library track IDs.
 * Used by the new DJ tab (2-deck virtual mixer) and surfaced in the
 * VJ tab as a SET that can be imported into the VJ playlist.
 *
 * Persistence is via localStorage with the key 'thedaw.setlists.v1'.
 * Each setlist is fully resolved on read (entries that no longer
 * exist in the library are silently skipped) so a saved set survives
 * track deletes without orphaning rows.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { analyzeEntries } from './djAnalysisStore';
import { useLogStore } from './logStore';

export interface SetlistEntry {
  /** Library entry id, or null for an ad-hoc URL/label (e.g. VJ
   *  archive clip referenced into a SET). */
  entryId: string | null;
  /** Human label — copied from the entry at insert time so a set
   *  reads correctly even if the underlying entry's title changes. */
  label: string;
  /** Optional URL hint for non-library entries. */
  url?: string;
  /** 'audio' | 'video' | 'image' — what kind of media this slot
   *  expects. */
  kind?: 'audio' | 'video' | 'image';
  /** Optional prepared-performance data (imported from Z-AutoDJ sets).
   *  When present the DJ automix uses these instead of its fixed
   *  constants; absent = classic automix behavior. All in seconds. */
  perf?: {
    /** Where the incoming deck should start playing this track. */
    cueIn?: number;
    /** Track position at which the blend OUT of this track begins. */
    mixOut?: number;
    /** Crossfade length for the transition out of this track. */
    transitionSec?: number;
  };
}

export interface Setlist {
  id: string;
  name: string;
  /** Ordered entries in this set. */
  entries: SetlistEntry[];
  /** Creation timestamp, ms since epoch. */
  createdAt: number;
  /** Last-edit timestamp. */
  updatedAt: number;
  /** Free-form notes / set order intent / venue. */
  notes?: string;
}

interface SetlistState {
  setlists: Record<string, Setlist>;
  /** Currently-active setlist (used by the DJ deck loader). */
  activeId: string | null;
  /** Create a fresh empty setlist. Returns its id. */
  create: (name: string) => string;
  /** Rename a setlist. */
  rename: (id: string, name: string) => void;
  /** Delete a setlist. */
  remove: (id: string) => void;
  /** Replace the entries of a setlist atomically. */
  setEntries: (id: string, entries: SetlistEntry[]) => void;
  /** Append entries to a setlist. */
  append: (id: string, entries: SetlistEntry[]) => void;
  /** Mark a setlist as currently active. */
  setActive: (id: string | null) => void;
  /** Update freeform notes. */
  setNotes: (id: string, notes: string) => void;
  /** Merge starter sets shipped by the local backend into browser storage. */
  importBundled: () => Promise<void>;
  /** Register a bundled set's audio files as library entries — the write the
   *  listing above deliberately does not do. Called when the user opens the
   *  set; returns its entries with `entryId`s filled in (or null when there
   *  is no such bundled set, e.g. a locally-created list). */
  registerBundled: (id: string) => Promise<SetlistEntry[] | null>;
}

const STORAGE_KEY = 'thedaw.setlists.v1';

/** Backend-bundled sets are `zad-<slug>-<hash>`; locally-created ones `set-…`. */
const BUNDLED_ID_PREFIX = 'zad-';

/** A bundled track the read-only listing could not name yet: no entry id, and
 *  not one of the user's own ad-hoc/VJ rows (those carry a `url`). */
function isPendingBundled(entry: SetlistEntry): boolean {
  return entry.entryId === null && !entry.url && entry.kind === 'audio';
}

function nextId(): string {
  return `set-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

export const useSetlistStore = create<SetlistState>()(
  persist(
    (set, get) => ({
      setlists: {},
      activeId: null,
      create: (name) => {
        const id = nextId();
        const now = Date.now();
        set((s) => ({
          setlists: {
            ...s.setlists,
            [id]: { id, name, entries: [], createdAt: now, updatedAt: now },
          },
        }));
        return id;
      },
      rename: (id, name) => set((s) => {
        const cur = s.setlists[id];
        if (!cur) return s;
        return {
          setlists: { ...s.setlists, [id]: { ...cur, name, updatedAt: Date.now() } },
        };
      }),
      remove: (id) => set((s) => {
        const { [id]: _, ...rest } = s.setlists;
        return { setlists: rest, activeId: s.activeId === id ? null : s.activeId };
      }),
      setEntries: (id, entries) => {
        analyzeEntries(entries.map((e) => e.entryId)); // keep set tracks analyzed
        set((s) => {
          const cur = s.setlists[id];
          if (!cur) return s;
          return {
            setlists: {
              ...s.setlists,
              [id]: { ...cur, entries, updatedAt: Date.now() },
            },
          };
        });
      },
      append: (id, entries) => {
        analyzeEntries(entries.map((e) => e.entryId)); // analyze added tracks now
        set((s) => {
          const cur = s.setlists[id];
          if (!cur) return s;
          return {
            setlists: {
              ...s.setlists,
              [id]: { ...cur, entries: [...cur.entries, ...entries], updatedAt: Date.now() },
            },
          };
        });
      },
      setActive: (id) => set({ activeId: id }),
      setNotes: (id, notes) => set((s) => {
        const cur = s.setlists[id];
        if (!cur) return s;
        return {
          setlists: {
            ...s.setlists,
            [id]: { ...cur, notes, updatedAt: Date.now() },
          },
        };
      }),
      importBundled: async () => {
        try {
          const res = await fetch('/api/library/setlists');
          if (!res.ok) return;
          const body = (await res.json()) as { setlists?: Setlist[] };
          const incoming = Array.isArray(body.setlists) ? body.setlists : [];
          if (incoming.length === 0) return;
          set((s) => {
            const next = { ...s.setlists };
            let added = false;
            for (const raw of incoming) {
              if (!raw?.id || next[raw.id]) continue;
              next[raw.id] = {
                id: raw.id,
                name: raw.name || 'Imported Set',
                entries: Array.isArray(raw.entries) ? raw.entries : [],
                createdAt: Number(raw.createdAt) || Date.now(),
                updatedAt: Number(raw.updatedAt) || Date.now(),
                notes: raw.notes || '',
              };
              added = true;
            }
            if (!added) return s;
            const preferred = incoming.find((item) => item.id === 'set-infinite-glitch-performance')?.id;
            return {
              setlists: next,
              activeId: s.activeId ?? preferred ?? incoming[0]?.id ?? null,
            };
          });
        } catch {
          /* Starter sets are optional; ignore failures while the backend warms. */
        }
      },
      registerBundled: async (id) => {
        // Only a bundled set has anything to register: a locally-created list
        // (`set-…` id) has no folder behind it, so there is no request to make.
        const cur = get().setlists[id];
        if (!cur) return null;
        if (!id.startsWith(BUNDLED_ID_PREFIX)) return cur.entries;
        // A track the user added by hand carries a `url` or an id already;
        // only a bundled track the listing left unregistered is pending.
        const pending = cur.entries.filter(isPendingBundled).length;
        if (pending === 0) return cur.entries;
        try {
          const res = await fetch(`/api/library/setlists/${encodeURIComponent(id)}/register`, {
            method: 'POST',
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = (await res.json()) as { setlist?: { entries?: SetlistEntry[] } };
          const incoming = Array.isArray(body.setlist?.entries) ? body.setlist.entries : null;
          if (!incoming) throw new Error('no entries in the answer');
          // Patch ids INTO the set the user has; never replace the array. They
          // may have reordered it, removed a track, or dragged their own in
          // (DJView "Sets" editing), and none of that is the backend's to
          // overwrite. Matched by label, taken in order so two tracks sharing
          // a title still land on their own entry.
          const byLabel = new Map<string, string[]>();
          for (const entry of incoming) {
            if (!entry?.entryId) continue;
            const queue = byLabel.get(entry.label) ?? [];
            queue.push(entry.entryId);
            byLabel.set(entry.label, queue);
          }
          let patched: SetlistEntry[] = cur.entries;
          const filled: string[] = [];
          set((s) => {
            const live = s.setlists[id];
            if (!live) return s;
            patched = live.entries.map((e) => {
              if (!isPendingBundled(e)) return e;
              const got = byLabel.get(e.label)?.shift();
              if (!got) return e;
              filled.push(got);
              return { ...e, entryId: got };
            });
            return {
              setlists: {
                ...s.setlists,
                [id]: { ...live, entries: patched, updatedAt: Date.now() },
              },
            };
          });
          if (filled.length > 0) analyzeEntries(filled);
          return patched;
        } catch (err) {
          // Silence here looked exactly like success: the set simply stayed
          // unplayable. Say so once, where the user already reads failures.
          useLogStore
            .getState()
            .append(
              'warn',
              'setlists',
              `Could not register ${pending} track${pending === 1 ? '' : 's'} of "${cur.name}": ${
                err instanceof Error ? err.message : 'request failed'
              }`,
            );
          return null;
        }
      },
    }),
    { name: STORAGE_KEY },
  ),
);
