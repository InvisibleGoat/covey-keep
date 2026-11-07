// The menu layout, chosen on You and stored on this device (CK-89;
// decisions/2026-10-31-the-design-and-how-it-is-merged.md §1.4, §7), in
// lib/theme.ts's shape.
//
// THE ONE MODULE THAT NAMES THE KEY (pinned in styles/look.test.tsx).
//
// The key holds `list` or `rail`. Exactly `rail` is Rail and panel; anything
// else, a missing key or storage that throws is One list. Choosing stores it
// and tells every subscriber at once, so the menu follows You without a
// reload; where storage throws, the choice is held here for this page load.
// There is no `storage` listener — another tab takes the choice on its next
// load — no pre-paint script (React reads it before the frame first paints)
// and nothing sends it anywhere: it is a device preference, nothing personal,
// and a sign-out leaves it, as it leaves the theme.
import { useSyncExternalStore } from 'react'

export const MENU_LAYOUT_KEY = 'covey-keep:menu-layout'

export type MenuLayout = 'list' | 'rail'

// A choice the device refused to store, held for this page load. It is asked
// before storage, because a write can throw where a read still works (a full
// quota, a browser refusing writes), and storage would then answer what was
// stored before. A write that lands lets go of it.
let held: MenuLayout | null = null
const listeners = new Set<() => void>()

export function readMenuLayout(): MenuLayout {
  if (held !== null) return held
  try {
    return localStorage.getItem(MENU_LAYOUT_KEY) === 'rail' ? 'rail' : 'list'
  } catch {
    return 'list'
  }
}

export function chooseMenuLayout(layout: MenuLayout): void {
  try {
    localStorage.setItem(MENU_LAYOUT_KEY, layout)
    held = null
  } catch {
    held = layout
  }
  for (const listener of [...listeners]) listener()
}

export function subscribeMenuLayout(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useMenuLayout(): MenuLayout {
  return useSyncExternalStore(subscribeMenuLayout, readMenuLayout)
}
