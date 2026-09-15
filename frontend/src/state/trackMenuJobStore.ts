import { create } from 'zustand';

/**
 * Vocal melody jobs the footer track menu started, by library entry id. The
 * vocal module answers a job by its id only, so this is how the menu's Stop row
 * knows a vocal job is running for the loaded track and which one to cancel.
 */
interface TrackMenuJobState {
  vocal: Record<string, string>;
  setVocal: (entryId: string, jobId: string | null) => void;
}

export const useTrackMenuJobs = create<TrackMenuJobState>()((set) => ({
  vocal: {},
  setVocal: (entryId, jobId) =>
    set((s) => {
      const next = { ...s.vocal };
      if (jobId) next[entryId] = jobId;
      else delete next[entryId];
      return { vocal: next };
    }),
}));
