/**
 * The header's button: an icon, optionally with a word beside it.
 *
 * One treatment for every control in the top-bar cluster — mobile access, the
 * help search, IMPORT, the app menu — so the row reads as one set of buttons
 * instead of four lookalikes, in the theme accent. `active` is the filled
 * state a popover trigger wears while its panel is open; `label` adds visible
 * text for the one control (IMPORT) that has to be found without hovering.
 *
 * It sits in its own file rather than inside Shell because the help-search
 * popover renders one for its own trigger while Shell renders the popover:
 * leaving the button private to Shell would make that pair import each other.
 */
import React from 'react';

export interface TopBarButtonProps {
  onClick: () => void;
  icon: React.ReactNode;
  /**
   * Tooltip, and the accessible name when there is no `label` — an icon-only
   * button carries no visible text.
   */
  title: string;
  /**
   * Visible text beside the icon. When present it IS the accessible name, so
   * no aria-label is set: one would override what the button plainly says.
   * `title` then carries the longer hint.
   */
  label?: string;
  /** Filled treatment. A popover trigger wears it while its panel is open. */
  active?: boolean;
  /** Popover wiring, for a trigger that owns a panel. */
  ariaHasPopup?: 'dialog' | 'menu' | 'listbox';
  ariaExpanded?: boolean;
  /**
   * Pass the panel's id only while the panel is actually rendered:
   * aria-controls naming an element that does not exist is worse than no
   * aria-controls at all.
   */
  ariaControls?: string;
  /** On/off state, for a button that toggles something (fullscreen). */
  ariaPressed?: boolean;
  /** So a popover can hand focus back to its trigger when it closes. */
  buttonRef?: React.Ref<HTMLButtonElement>;
}

/**
 * The one treatment every header control wears: the theme accent
 * (--et-accent, re-pointed per theme) on a hairline border, filled while
 * active. No glow. The app menu and the recent-files clock take the same
 * classes, so the cluster is one colour.
 */
export function topBarButtonClass(active = false): string {
  const state = active
    ? 'border-[rgb(var(--et-accent)/0.55)] bg-[rgb(var(--et-accent)/0.15)] text-[rgb(var(--et-accent))]'
    : 'border-[rgb(var(--et-accent)/0.3)] text-[rgb(var(--et-accent))] hover:bg-[rgb(var(--et-accent)/0.12)]';
  return `p-1.5 rounded border transition-colors group flex items-center gap-1.5 outline-none focus-visible:ring-1 focus-visible:ring-[rgb(var(--et-accent)/0.6)] ${state}`;
}

export const TopBarButton: React.FC<TopBarButtonProps> = ({
  onClick,
  icon,
  title,
  label,
  active = false,
  ariaHasPopup,
  ariaExpanded,
  ariaControls,
  ariaPressed,
  buttonRef,
}) => {
  return (
    <button
      type="button"
      ref={buttonRef}
      onClick={onClick}
      title={title}
      aria-label={label ? undefined : title}
      aria-haspopup={ariaHasPopup}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
      aria-pressed={ariaPressed}
      className={topBarButtonClass(active)}
    >
      {icon}
      {label && (
        <span className="text-[10px] font-black uppercase tracking-widest leading-none">{label}</span>
      )}
    </button>
  );
};
