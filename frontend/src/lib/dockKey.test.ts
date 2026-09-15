import assert from 'node:assert/strict';
import { focusFate, keyAvailability } from './dockKey.ts';

// Availability: disabled wins; unavailable keeps the native button enabled.
{
  assert.deepEqual(keyAvailability(), { disabled: false, ariaDisabled: undefined, pressable: true });
  assert.deepEqual(keyAvailability(false, true), { disabled: false, ariaDisabled: true, pressable: false });
  assert.deepEqual(keyAvailability(true, false), { disabled: true, ariaDisabled: undefined, pressable: false });
  assert.deepEqual(keyAvailability(true, true), { disabled: true, ariaDisabled: undefined, pressable: false });
}

// The sequence a busy key goes through with keyboard focus on it: focus, the job starts, the job ends.
// ANALYZE (and REC converting, EDIT bouncing) keeps focus the whole way, and only presses change.
{
  const steps = [
    { event: 'focus', unavailable: false },
    { event: 'busy on', unavailable: true },
    { event: 'busy off', unavailable: false },
  ];
  const seen = steps.map(({ event, unavailable }) => {
    const now = keyAvailability(false, unavailable);
    return { event, fate: focusFate(now, false), pressable: now.pressable, aria: now.ariaDisabled };
  });
  assert.deepEqual(seen, [
    { event: 'focus', fate: 'stays', pressable: true, aria: undefined },
    { event: 'busy on', fate: 'stays', pressable: false, aria: true },
    { event: 'busy off', fate: 'stays', pressable: true, aria: undefined },
  ]);
}

// A key an empty roll disables (APPLY, EDIT with no notes) lets focus fall to the page, never to a neighbour.
{
  const steps = [false, true, false].map((disabled) => focusFate(keyAvailability(disabled, false), false));
  assert.deepEqual(steps, ['stays', 'page', 'stays']);
}

// A limit key disabled by its own press (More beats at 32, NEXT on the last change) passes focus on.
{
  assert.equal(focusFate(keyAvailability(true, false), true), 'neighbour');
  // Merely unavailable, it keeps focus even when it would pass it on.
  assert.equal(focusFate(keyAvailability(false, true), true), 'stays');
}

console.log('dockKey: all assertions passed');
