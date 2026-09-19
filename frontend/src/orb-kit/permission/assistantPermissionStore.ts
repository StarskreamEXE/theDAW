/**
 * assistantPermissionStore — the assistant's permission MODE.
 *
 * One setting, four values, shared by the header dropdown and by every chat
 * request that goes to the Claude Code provider. The mode decides what the
 * assistant may do on its own and what has to come back as a permission
 * bubble; the backend policy in `backend/modules/assistant/permissions.py`
 * is the enforcer — this store only carries the user's choice.
 *
 * The chosen mode is remembered across sessions under
 * 'thedaw:assistant-permission-mode'. A live conversation is told about a
 * change immediately via POST /api/assistant/permission-mode, so the running
 * CLI session switches without waiting for the next turn.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/** The four permission modes. These strings are the wire contract shared with
 *  the backend policy — never rename one without changing it there too. */
export type PermissionMode = 'ask' | 'accept_edits' | 'readonly' | 'trusted';

/** localStorage key holding the persisted mode. */
export const ASSISTANT_PERMISSION_MODE_STORAGE_KEY = 'thedaw:assistant-permission-mode';

export interface PermissionModeOption {
  value: PermissionMode;
  /** Short name shown in the dropdown. */
  label: string;
  /** One line explaining the mode; rendered as the option's `title`. */
  description: string;
}

/** Dropdown contents, in display order. 'ask' is first and is the default. */
export const PERMISSION_MODE_OPTIONS: PermissionModeOption[] = [
  {
    value: 'ask',
    label: 'Ask before acting',
    description:
      'Reading is free; every edit, command or sub-agent asks you first. The default.',
  },
  {
    value: 'accept_edits',
    label: 'Accept edits, ask for shell',
    description:
      'File edits inside the project apply on their own; shell commands and sub-agents still ask.',
  },
  {
    value: 'readonly',
    label: 'Read-only',
    description: 'The assistant may only read. Every edit or command is refused outright.',
  },
  {
    value: 'trusted',
    label: 'Trusted',
    description:
      'No prompts — except changes to the assistant’s own code, which always ask.',
  },
];

const VALID_MODES: readonly PermissionMode[] = PERMISSION_MODE_OPTIONS.map((o) => o.value);

/** The default mode for a user who has never chosen one. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'ask';

/** Coerce an unknown value (persisted state, an API reply, a DOM event) into a
 *  mode, or null when it is not one of the four. */
export function normalizePermissionMode(value: unknown): PermissionMode | null {
  return typeof value === 'string' && (VALID_MODES as readonly string[]).includes(value)
    ? (value as PermissionMode)
    : null;
}

interface AssistantPermissionState {
  mode: PermissionMode;
  /** Set the mode. Values that are not one of the four are ignored. */
  setMode: (mode: unknown) => void;
}

export const useAssistantPermissionStore = create<AssistantPermissionState>()(
  persist(
    (set) => ({
      mode: DEFAULT_PERMISSION_MODE,
      setMode: (mode) => {
        const normalized = normalizePermissionMode(mode);
        if (!normalized) return;
        set({ mode: normalized });
      },
    }),
    {
      name: ASSISTANT_PERMISSION_MODE_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ mode: s.mode }),
      merge: (persisted, current) => ({
        ...current,
        mode:
          normalizePermissionMode((persisted as { mode?: unknown } | undefined)?.mode) ??
          current.mode,
      }),
    },
  ),
);

/**
 * Tell a live conversation about a mode change (contract C2). Returns true
 * when the backend accepted it. Never throws and never rejects: the dropdown
 * has already moved by the time this runs, and a backend that is down must
 * not strand the UI. Returns false — without calling the API — when there is
 * no conversation yet, in which case the mode simply rides along with the
 * next chat request.
 */
export async function postPermissionMode(
  conversationId: string | null | undefined,
  mode: PermissionMode,
): Promise<boolean> {
  if (!conversationId) return false;
  try {
    const response = await fetch('/api/assistant/permission-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, mode }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
