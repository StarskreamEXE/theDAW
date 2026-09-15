/**
 * Status notices: the one-line statuses the app posts through
 * useStatusBarStore.getState().setText, and the health check's changes.
 *
 * Each notice is written to the LOG and shown in the assistant orb's speech
 * bubble (components/audio/OrbTipBubble.tsx, and OrbStatusFloat.tsx below the
 * xl breakpoint) for a few seconds, after which the bubble returns to its tips.
 *
 * - The idle value READY is not a notice.
 * - A text equal to the last text posted, posted again within STATUS_REPEAT_MS,
 *   is dropped: no LOG line, and the bubble keeps the notice it has and its
 *   timer. Any other text posts, so START, FAILED, START logs all three.
 * - A caller that already wrote the same line to the LOG gets no second entry.
 *   The check runs in a microtask, so it sees a line the caller wrote just
 *   before the post (within LOG_MATCH_MS) or right after it in the same task.
 *   "The same line" is a LOG message that contains the notice's detail (the
 *   text after its "LABEL: ") or every word of the notice (sameLine), and that
 *   reports the same outcome (sameOutcome): a failure or refusal matches a warn
 *   or error line, and any other notice matches an info line that carries one
 *   of its label's outcome words (COMPLETE, SAVED, QUEUED, ...). A call site
 *   that logs the event in other words passes `logged: true`.
 * - statusLevel reads the label, the text before the first ": ", so a file or
 *   plugin name in the detail never sets the level. A failure (FAILED,
 *   UNREACHABLE, ...) logs at error, a refusal (REQUIRED, SKIPPED, DID NOT, ...)
 *   at warn, anything else at info. The bubble draws warn and error in failure
 *   colours.
 * - statusSource names the subsystem from the text's opening words, matching the
 *   LOG sources those callers use; a text it does not know logs as 'status'.
 * - The bubble shows an info notice for STATUS_INFO_MS and a warn or error
 *   notice for STATUS_FAILURE_MS. A notice less severe than the one showing
 *   waits until that one has shown for FAILURE_HOLD_MS, so a failure followed at
 *   once by a success is still on screen long enough to read.
 */
import { useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { useLogStore } from './logStore';

export type StatusLevel = 'info' | 'warn' | 'error';

export interface StatusNotice {
  id: number;
  text: string;
  level: StatusLevel;
  /** The LOG source the notice was filed under. */
  source: string;
  /** Date.now() when the bubble took the notice. */
  shownAt: number;
  /** Date.now() when the bubble lets it go. */
  until: number;
}

export interface PostStatusOptions {
  /** LOG source; statusSource(text) when omitted. */
  source?: string;
  /** LOG level and bubble tone; statusLevel(text) when omitted. */
  level?: StatusLevel;
  /** The caller wrote this notice's LOG line itself. */
  logged?: boolean;
}

export const STATUS_INFO_MS = 5000;
export const STATUS_FAILURE_MS = 8000;
export const FAILURE_HOLD_MS = 4000;
export const STATUS_REPEAT_MS = 5000;
export const LOG_MATCH_MS = 1500;

const ERROR_WORDS = /\b(?:FAILED|FAIL|FAILURE|ERROR|UNREACHABLE|UNHEALTHY)\b|\bNO USABLE MODEL\b/i;
const WARN_WORDS = /\b(?:REQUIRED|SKIPPED|DID NOT|NOT FOUND|NO PLAYABLE)\b/i;

/** A status text's label: the text before its first ": ", or all of it. */
function statusLabel(text: string): string {
  const cut = text.indexOf(': ');
  return cut > 0 ? text.slice(0, cut) : text;
}

/** The LOG level a status text reports at, read from its label. */
export function statusLevel(text: string): StatusLevel {
  const label = statusLabel(text);
  if (ERROR_WORDS.test(label)) return 'error';
  if (WARN_WORDS.test(label)) return 'warn';
  return 'info';
}

// First match wins. 'Saved to disk, but ...' is the generate flow's, so its row
// comes before the files row that 'SAVED: <path>' belongs to.
const SOURCES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(?:GENERATION|CHIMERA|HEAL|HEALING|PROMPT|NO USABLE MODEL|DECODED|SAVED TO DISK|LORA)\b/i, 'generate'],
  [/^(?:SAVE|SAVING|SAVED|DOWNLOADED|SHOW IN FOLDER)\b/i, 'files'],
  [/^SCENE\b/i, 'sway'],
  [/^INSTALL\b/i, 'assets'],
  [/^(?:STUDIO|MIX|VST PROCESS|VST FAILED)\b/i, 'studio'],
  [/^VST\b/i, 'vst'],
  [/^(?:TRAINING|PRE-ENCODE|AUTOENCODE|AUTODECODE)\b/i, 'training'],
  [/^PROJECT\b/i, 'project'],
  [/^(?:IMPORTED|OPENED \.tasmo|NO PLAYABLE CLIPS)\b|: export-to-audio required$/i, 'dawimport'],
  [/^OPEN \.gan\b/i, 'plugin'],
  [/^FOLDER IMPORT\b/i, 'library'],
  [/^(?:API|HEALTH)\b/i, 'health'],
];

/** The LOG source a status text is filed under. */
export function statusSource(text: string): string {
  for (const [pattern, source] of SOURCES) {
    if (pattern.test(text)) return source;
  }
  return 'status';
}

const words = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Whether the LOG message `msg` already says what the status `text` says. */
export function sameLine(text: string, msg: string): boolean {
  const have = words(msg);
  const cut = text.indexOf(': ');
  const detail = cut > 0 ? words(text.slice(cut + 2)) : [];
  if (detail.join('').length >= 3 && ` ${have.join(' ')} `.includes(` ${detail.join(' ')} `)) return true;
  const all = words(text);
  const present = new Set(have);
  return all.length > 0 && all.every((w) => present.has(w));
}

/** Label words that say what happened, as the status labels in the app spell them. */
const OUTCOME_WORDS = new Set([
  'complete', 'completed', 'done', 'finished', 'ready', 'decoded', 'registering', 'downloaded',
  'cleared', 'queued', 'started', 'stopped', 'aborted', 'cancelled', 'healing', 'imported',
  'installed', 'exported', 'saved', 'saving', 'opened', 'loaded', 'loading', 'promoted',
  'submitting', 'rendering', 'recovered', 'removed', 'deleted',
]);

/**
 * Whether a LOG entry at `entryLevel` reporting `msg` tells the same outcome as
 * the status `text` at `level`. A failure or refusal matches a warn or error
 * entry. Any other status matches an info entry, and when its label carries
 * outcome words (STUDIO PROCESS COMPLETE) the entry must carry one of them, so a
 * start line that names the same effect or path never stands in for the result.
 */
export function sameOutcome(text: string, level: StatusLevel, msg: string, entryLevel: string): boolean {
  if (level !== 'info') return entryLevel === 'warn' || entryLevel === 'error';
  if (entryLevel !== 'info') return false;
  const want = words(statusLabel(text)).filter((w) => OUTCOME_WORDS.has(w));
  if (want.length === 0) return true;
  const have = new Set(words(msg));
  return want.some((w) => have.has(w));
}

interface StatusNoticeState {
  /** The notice the bubble shows, or null while it shows its tips. */
  current: StatusNotice | null;
  /** Let the notice go now, and drop one that is waiting (a click on the bubble). */
  dismiss: () => void;
}

type Timer = ReturnType<typeof setTimeout>;

let expiryTimer: Timer | null = null;
let waitingTimer: Timer | null = null;
let nextId = 0;
/** The last text posted and when, for the repeat window. */
let lastPosted: { line: string; at: number } | null = null;
/** LOG entry ids this module wrote, so a notice never matches an earlier notice. */
const ownEntries = new Set<string>();

const SEVERITY: Record<StatusLevel, number> = { info: 0, warn: 1, error: 2 };

function after(ms: number, fn: () => void): Timer {
  const timer = setTimeout(fn, Math.max(0, ms));
  // A notice waiting to expire must not hold a node test process open.
  (timer as unknown as { unref?: () => void }).unref?.();
  return timer;
}

function cancel(timer: Timer | null): null {
  if (timer !== null) clearTimeout(timer);
  return null;
}

export const useStatusNoticeStore = create<StatusNoticeState>()((set) => ({
  current: null,
  dismiss: () => {
    expiryTimer = cancel(expiryTimer);
    waitingTimer = cancel(waitingTimer);
    set({ current: null });
  },
}));

function currentNotice(): StatusNotice | null {
  return useStatusNoticeStore.getState().current;
}

/** The notice up now. The server snapshot reads live state as well, so a
 *  static render (statusNotice.test.tsx) draws the notice that is up. */
export function useStatusNotice(): StatusNotice | null {
  return useSyncExternalStore(useStatusNoticeStore.subscribe, currentNotice, currentNotice);
}

function show(id: number, text: string, level: StatusLevel, source: string): void {
  const shownAt = Date.now();
  const until = shownAt + (level === 'info' ? STATUS_INFO_MS : STATUS_FAILURE_MS);
  expiryTimer = cancel(expiryTimer);
  useStatusNoticeStore.setState({ current: { id, text, level, source, shownAt, until } });
  expiryTimer = after(until - shownAt, () => {
    expiryTimer = null;
    if (currentNotice()?.id === id) useStatusNoticeStore.setState({ current: null });
  });
}

function writtenByCaller(text: string, level: StatusLevel, postedAt: number): boolean {
  const { entries } = useLogStore.getState();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.ts < postedAt - LOG_MATCH_MS) break;
    if (entry.level === 'debug' || ownEntries.has(entry.id)) continue;
    if (sameOutcome(text, level, entry.msg, entry.level) && sameLine(text, entry.msg)) return true;
  }
  return false;
}

function writeLog(text: string, level: StatusLevel, source: string): void {
  useLogStore.getState().append(level, source, text);
  const { entries } = useLogStore.getState();
  const entry = entries[entries.length - 1];
  if (!entry) return;
  ownEntries.add(entry.id);
  if (ownEntries.size > 200) {
    const oldest = ownEntries.values().next().value;
    if (oldest !== undefined) ownEntries.delete(oldest);
  }
}

/** Write a status to the LOG and show it in the orb's speech bubble. */
export function postStatus(text: string, options: PostStatusOptions = {}): void {
  const line = text.trim();
  if (!line || /^ready$/i.test(line)) return;

  const now = Date.now();
  if (lastPosted && lastPosted.line === line && now - lastPosted.at < STATUS_REPEAT_MS) return;
  lastPosted = { line, at: now };

  const level = options.level ?? statusLevel(line);
  const source = options.source ?? statusSource(line);
  if (!options.logged) {
    queueMicrotask(() => {
      if (!writtenByCaller(line, level, now)) writeLog(line, level, source);
    });
  }

  nextId += 1;
  const id = nextId;
  waitingTimer = cancel(waitingTimer);
  const showing = currentNotice();
  const holdEnds = showing ? showing.shownAt + FAILURE_HOLD_MS : 0;
  if (showing && SEVERITY[showing.level] > SEVERITY[level] && now < holdEnds) {
    waitingTimer = after(holdEnds - now, () => {
      waitingTimer = null;
      show(id, line, level, source);
    });
    return;
  }
  show(id, line, level, source);
}
