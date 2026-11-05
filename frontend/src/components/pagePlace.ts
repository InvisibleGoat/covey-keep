import { createContext, useContext } from 'react'

// What a page may read about its own visit (CK-88.2): the frame decides it, once
// per pathname change, before the page mounts, and holds it until the next.
// Outside the frame every page is a new visit and nothing is remembered, so a page
// rendered on its own behaves as it did.
export interface PagePlaceState {
  // This visit is a return, by history or by a link to the page just left.
  isReturn: boolean
  // A list on this page was opened in place when it was last left.
  shownAll: boolean
  // Remember that a list on this page has been opened in place.
  rememberShownAll: () => void
}

export const PagePlaceContext = createContext<PagePlaceState>({
  isReturn: false,
  shownAll: false,
  rememberShownAll: () => {},
})

export function usePagePlace(): PagePlaceState {
  return useContext(PagePlaceContext)
}
