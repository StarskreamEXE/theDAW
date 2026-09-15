/**
 * Where keyboard focus goes in the footer's track menu.
 *
 * The menu's rows are not a fixed list. It opens with the Stems group holding
 * one "Checking" placeholder, and when the probe lands that row is gone and one
 * line per stem sits in its place — every one of them after the row that was
 * last a moment ago. The columns also repack on a resize, which remounts the
 * boxes and drops focus to <body>. So two things have to survive a row-set
 * change: the row the user was on, and the intent behind how the menu opened.
 *
 * DOM-only (no React, no stores), so a test can build a menu by hand and replay
 * a probe landing in it.
 */

/** Every focusable row of `root`, in reading order. */
export const menuItems = (root: ParentNode): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>('[role="menuitem"]'));

/** The last row of `root`, or null when it has none. */
export const lastMenuItem = (root: ParentNode): HTMLElement | null => {
  const items = menuItems(root);
  return items[items.length - 1] ?? null;
};

/** Where focus was when the rows changed under it. */
export interface FocusMark {
  /** The row's id (`data-row-id`). */
  rowId: string | null;
  /** Its group's id (`data-group-id` on the enclosing `[role="group"]`). */
  groupId: string | null;
  /** It was the last row of that group, so a replacement lands at that end. */
  atGroupEnd: boolean;
}

/** Reads a mark off a row, for storing before the rows change. */
export function markOf(item: HTMLElement): FocusMark {
  const group = item.closest<HTMLElement>('[role="group"]');
  const inGroup = group ? menuItems(group) : [];
  return {
    rowId: item.dataset.rowId ?? null,
    groupId: group?.dataset.groupId ?? null,
    atGroupEnd: inGroup[inGroup.length - 1] === item,
  };
}

/**
 * The row to focus in `menu` after the rows changed, for a user who was on
 * `mark`.
 *
 * The same row when it is still there. Otherwise the end of its group the user
 * was at — the group's last row when they had arrowed to the bottom of it,
 * its first otherwise — because a probe that replaces one placeholder with
 * eight stem rows would otherwise drop a user who was at the bottom of the menu
 * seven rows short of it. Failing that, the menu's first row.
 */
export function restoreTarget(menu: ParentNode, mark: FocusMark): HTMLElement | null {
  const items = menuItems(menu);
  if (items.length === 0) return null;
  if (mark.rowId) {
    const same = items.find((el) => el.dataset.rowId === mark.rowId);
    if (same) return same;
  }
  const group = [...menu.querySelectorAll<HTMLElement>('[role="group"]')].find(
    (g) => g.dataset.groupId === mark.groupId,
  );
  const inGroup = group ? menuItems(group) : [];
  const end = mark.atGroupEnd ? inGroup[inGroup.length - 1] : inGroup[0];
  return end ?? items[0];
}

/** The keys the menu steers focus with. */
export type MenuKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';

/**
 * The index a key moves to, wrapping at both ends. `at` is -1 when focus is not
 * on a row, which ArrowDown reads as "before the first" and ArrowUp as "after
 * the last", so either key from the menu itself lands on the end it points at.
 */
export function rovingIndex(at: number, count: number, key: MenuKey): number {
  if (count === 0) return -1;
  switch (key) {
    case 'ArrowDown':
      return at < 0 || at >= count - 1 ? 0 : at + 1;
    case 'ArrowUp':
      return at <= 0 ? count - 1 : at - 1;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
  }
}
