// Your gatherings' view, Cards or Calendar, chosen with the switch on the page
// and stored on this device (CK-91; the mockup's `gview`), in
// lib/menuLayout.ts's shape.
//
// THE ONE MODULE THAT NAMES THE KEY (pinned in styles/look.test.tsx).
//
// The key holds `cards` or `calendar`. Exactly `calendar` is the Calendar
// view; anything else, a missing key or storage that throws is Cards.
// Choosing stores it and tells every subscriber at once; where storage
// throws, the choice is held here for this page load. There is no `storage`
// listener — another tab takes the choice on its next load — and nothing
// sends it anywhere: it is a display choice, nothing personal, and a sign-out
// leaves it, as it leaves the theme and the menu layout.
import { useSyncExternalStore } from 'react'

export const GATHERINGS_VIEW_KEY = 'covey-keep:gatherings-view'

export type GatheringsView = 'cards' | 'calendar'

// A choice the device refused to store, held for this page load — asked before
// storage, because a write can throw where a read still works. A write that
// lands lets go of it.
let held: GatheringsView | null = null
const listeners = new Set<() => void>()

export function readGatheringsView(): GatheringsView {
  if (held !== null) return held
  try {
    return localStorage.getItem(GATHERINGS_VIEW_KEY) === 'calendar' ? 'calendar' : 'cards'
  } catch {
    return 'cards'
  }
}

export function chooseGatheringsView(view: GatheringsView): void {
  try {
    localStorage.setItem(GATHERINGS_VIEW_KEY, view)
    held = null
  } catch {
    held = view
  }
  for (const listener of [...listeners]) listener()
}

export function subscribeGatheringsView(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useGatheringsView(): GatheringsView {
  return useSyncExternalStore(subscribeGatheringsView, readGatheringsView)
}
