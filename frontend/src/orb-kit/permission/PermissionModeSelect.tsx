/**
 * PermissionModeSelect — the assistant's permission mode, as a dropdown.
 *
 * A native <select>, deliberately: the four modes are a one-of-four choice
 * with no icons or badges to render, and a native control comes with keyboard
 * handling, type-ahead and a real <label> association for free (HARD RULE 3).
 * Each option carries its explanation as a `title`, so hovering a mode says
 * what it will and will not do before you pick it.
 *
 * Changing the mode updates the store (persisted, used by the next chat
 * request) and, when a conversation is already running, tells the backend at
 * once so the live CLI session switches mid-conversation.
 *
 * Only the Claude Code provider has permission modes. This component does not
 * gate itself — whoever renders it decides when it applies.
 */
import type { ChangeEvent } from 'react'

import {
  PERMISSION_MODE_OPTIONS,
  normalizePermissionMode,
  postPermissionMode,
  useAssistantPermissionStore,
} from './assistantPermissionStore'

export interface PermissionModeSelectProps {
  /** The live conversation to switch, if there is one. Without it the mode is
   *  only remembered locally and rides along with the next chat request. */
  conversationId?: string | null
  /** Hide the visible label text (it stays in the DOM for screen readers) and
   *  tighten the control for a crowded header row. */
  compact?: boolean
}

export function PermissionModeSelect({ conversationId, compact = false }: PermissionModeSelectProps) {
  const mode = useAssistantPermissionStore((s) => s.mode)
  const setMode = useAssistantPermissionStore((s) => s.setMode)

  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = normalizePermissionMode(event.target.value)
    if (!next) return
    setMode(next)
    // Fire-and-forget: postPermissionMode never rejects, and the dropdown must
    // not wait on the network to show the mode the user just picked.
    void postPermissionMode(conversationId, next)
  }

  return (
    <div className={compact ? 'flex items-center gap-1.5' : 'flex flex-col gap-0.5'}>
      <label
        htmlFor="assistant-permission-mode"
        className={
          compact
            ? 'sr-only'
            : 'text-[10px] text-muted uppercase tracking-wider'
        }
      >
        Permissions
      </label>
      <select
        id="assistant-permission-mode"
        name="assistantPermissionMode"
        value={mode}
        onChange={handleChange}
        className={`${compact ? 'max-w-40' : 'w-full'} bg-black/30 border border-white/10 rounded px-2 py-1 text-[11px] text-white cursor-pointer hover:border-white/20 focus:outline-none focus:border-primary/50 transition-colors`}
      >
        {PERMISSION_MODE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value} title={option.description} className="bg-black text-white">
            {option.label}
          </option>
        ))}
      </select>
    </div>
  )
}

export default PermissionModeSelect
