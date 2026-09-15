/**
 * A MIDI dock key's availability and where keyboard focus goes when it changes.
 *
 * A key is unavailable in one of two ways. `disabled` is the native attribute,
 * for a key with nothing to act on (APPLY with an empty roll, the last meter
 * change's NEXT); the browser blurs a disabled key and focus falls to the page.
 * `unavailable` is for the length of a job the key or its neighbours started
 * (REC converting a take, ANALYZE, EDIT bouncing): the key stays a native
 * enabled button marked `aria-disabled`, so it keeps keyboard focus and reads as
 * unavailable, and it ignores presses until the job ends.
 */

export interface KeyAvailability {
  /** The native `disabled` attribute. */
  disabled: boolean;
  /** `aria-disabled`, set only while the key is unavailable but not disabled. */
  ariaDisabled: true | undefined;
  /** Whether a press runs the key's action. */
  pressable: boolean;
}

export function keyAvailability(disabled?: boolean, unavailable?: boolean): KeyAvailability {
  const native = !!disabled;
  const held = !native && !!unavailable;
  return { disabled: native, ariaDisabled: held ? true : undefined, pressable: !native && !held };
}

/**
 * Where keyboard focus goes when the key that has it turns `now`.
 *
 * `stays`: the key is still a native enabled button (available, or only
 * unavailable), so focus never leaves it. `neighbour`: the key is disabled and
 * passes focus on, as the limit keys do (a stepper's end, the last meter change,
 * Remove on bar 1), so focus moves to the nearest enabled key in its field.
 * `page`: the key is disabled by something other than its own press (an empty
 * roll), and focus falls where the browser puts it, never onto an unrelated key.
 */
export type FocusFate = 'stays' | 'neighbour' | 'page';

export function focusFate(now: KeyAvailability, passFocusOnDisable: boolean): FocusFate {
  if (!now.disabled) return 'stays';
  return passFocusOnDisable ? 'neighbour' : 'page';
}
