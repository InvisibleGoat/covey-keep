import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useLocation, type Location } from 'react-router-dom'
import type { PagePlaceState } from './pagePlace'

// A page keeps its place (CK-88.2): the ONE owner of a navigation's scroll, called
// once from the frame. Back, Forward and a link to the page just left land where
// the person was; everything else starts at the top. Pages do not opt in.
//
// - IT ACTS ONLY WHEN THE PATHNAME CHANGES. The photo viewer's history entries
//   share a pathname, and opening or closing it moves nothing.
// - THREE KINDS OF PAGE, decided during render, once, before the page mounts, and
//   held until the next pathname change. A key in the record can only be Back or
//   Forward, because a push and a replace always make new keys (and an initial
//   load reads POP, which is why this never asks the navigation's type). A new
//   key with no hash, at the path of the page left to reach this one, is a return
//   by a link: the crumb above all, a tab or a menu row too. Anything else is a
//   new page, at the top of whichever scroller is active, at once. So a link with
//   a hash always arrives, and going back and forth between two pages keeps both
//   places, a gathering's card straight after its crumb included.
// - THE RECORD IS IN THIS COMPONENT, in a ref, and nowhere else: a sign-out
//   unmounts the frame and the next person starts fresh; a reload starts at the
//   top. It is written once per leaving, in a layout effect, never during render,
//   so a key's presence cannot flip in the middle of a visit.
// - THE SCROLLER is the window below 900px and the page column from 900px, read and
//   written through scrollTop, instant. A place saved in one layout means nothing
//   in the other, so a mismatch goes to the top.
// - THE PLACE LEFT IS WHAT THE LAST SCROLL EVENT SAID. By the layout effect the old
//   page is out of the DOM and the browser has clamped, so scrollTop is never read
//   at the leaving. While a restore runs the listener is ignored and the place
//   stays at the target, so a person who leaves during the wait keeps the place
//   they were being returned to, not the clamp.
// - A RETURN IS HELD, not applied once. Every page reads on mount, so it comes back
//   on a loading screen and grows. The place is written at once, where the browser
//   clamps it, and again on every DOM change in the column; it does not stop on
//   reaching y, because more can land above it. It closes on the first of the
//   window, the person's own act, a pathname change or the frame going. A person's
//   act keeps the target until a scroll says otherwise; only the window's close
//   reads where the page came to rest, which a read slower than the window leaves
//   where it clamped.
// - FOCUS GOES BACK TO A LINK PRESSED FROM THE KEYBOARD. Only event.detail === 0, a
//   keyboard or assistive-technology press, records one, so a mouse or a touch
//   sees no difference by construction. Once the place is reached (or at the
//   window's close, if the page is shorter now), the page's link with that href
//   nearest the viewport's middle takes focus without scrolling, if nothing else
//   has it. Once; a person's act cancels it; a link that has gone means nothing
//   happens. Only the page's links are searched: a tab can carry the same href as
//   a crumb, and it is on screen while the page is still loading.
//
// jsdom has no layout, so none of this timing can be seen under test: the suite pins
// the rule on a stub scroller and the browser measured the rest (the CK-88.2 report).

export const RESTORE_WINDOW_MS = 5000

const ACTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
const ACT_OPTIONS = { capture: true, passive: true }

interface Place {
  path: string // pathname + search, never a fragment
  y: number
  wide: boolean
  shownAll: boolean
  href: string | null
}

// One visit to a page, decided at its pathname change: the place it returns to, if
// any, and the layout as it stood then.
interface Visit {
  pathname: string
  place: Place | null
  wide: boolean
}

interface Pressed {
  href: string
  pathname: string
}

type Closing = 'window' | 'act' | 'left'

function scrollerOf(column: HTMLElement | null, wide: boolean): Element | null {
  return wide ? column : (document.scrollingElement ?? document.documentElement)
}

function placeToReturnTo(location: Location, places: Map<string, Place>, left: Place | null): Place | null {
  const atKey = places.get(location.key)
  if (atKey !== undefined) return atKey
  if (location.hash === '' && left !== null && left.path === location.pathname + location.search) return left
  return null
}

// The page's links with this href, compared as values and never built into a
// selector; the one nearest the viewport's middle, because a gathering has both a
// strip card and a section head. Answers whether any was there to take.
function focusPressedLink(column: HTMLElement, href: string): boolean {
  const links = Array.from(column.querySelectorAll<HTMLAnchorElement>('main a[href]')).filter(
    (link) => link.getAttribute('href') === href,
  )
  if (links.length === 0) return false
  const middle = window.innerHeight / 2
  const distance = (link: HTMLAnchorElement) => {
    const box = link.getBoundingClientRect()
    return Math.abs((box.top + box.bottom) / 2 - middle)
  }
  const nearest = links.reduce((best, link) => (distance(link) < distance(best) ? link : best))
  const active = document.activeElement
  if (active === null || active === document.body) nearest.focus({ preventScroll: true })
  return true
}

// Hold a place on a page coming back. Answers the way to close it; onClose gets
// where the page came to rest, when the window's close is what closed it.
function holdPlace(
  column: HTMLElement,
  scroller: Element,
  { y, href }: Place,
  onClose: (settled: number | null) => void,
): (how: Closing) => void {
  let owedFocus = href
  let open = true

  const apply = () => {
    scroller.scrollTop = y
    if (owedFocus !== null && Math.abs(scroller.scrollTop - y) <= 1 && focusPressedLink(column, owedFocus)) {
      owedFocus = null
    }
  }

  const observer = new MutationObserver(apply)
  const onAct = () => close('act')
  const timer = setTimeout(() => close('window'), RESTORE_WINDOW_MS)

  function close(how: Closing) {
    if (!open) return
    open = false
    observer.disconnect()
    clearTimeout(timer)
    for (const act of ACTS) window.removeEventListener(act, onAct, ACT_OPTIONS)
    if (how === 'window' && owedFocus !== null) focusPressedLink(column, owedFocus)
    onClose(how === 'window' ? scroller.scrollTop : null)
  }

  observer.observe(column, { childList: true, subtree: true })
  for (const act of ACTS) window.addEventListener(act, onAct, ACT_OPTIONS)
  apply()
  return close
}

export function useKeepPlace(column: RefObject<HTMLElement | null>, wide: boolean): PagePlaceState {
  const location = useLocation()
  const places = useRef(new Map<string, Place>())
  const left = useRef<Place | null>(null)
  const tracked = useRef<{ key: string; pathname: string; path: string } | null>(null)
  const lastY = useRef(0)
  const pressed = useRef<Pressed | null>(null)
  const shownAll = useRef(false)
  const closeHold = useRef<((how: Closing) => void) | null>(null)
  const seenWide = useRef(wide)

  // Decided once per pathname change, during render, so the page mounts knowing it
  // (React's way of adjusting state to a changed input, the frame's seenKey).
  const [visit, setVisit] = useState<Visit>({ pathname: location.pathname, place: null, wide })
  if (visit.pathname !== location.pathname) {
    setVisit({
      pathname: location.pathname,
      place: placeToReturnTo(location, places.current, left.current),
      wide,
    })
  }

  // Save the page left, then put this one where it belongs. The hold's cleanup
  // runs before this body, so a page left during the wait saves its target.
  useLayoutEffect(() => {
    const leaving = tracked.current
    if (leaving !== null && leaving.pathname !== visit.pathname) {
      const place: Place = {
        path: leaving.path,
        y: lastY.current,
        wide: visit.wide,
        shownAll: shownAll.current,
        href: pressed.current?.pathname === visit.pathname ? pressed.current.href : null,
      }
      places.current.set(leaving.key, place)
      left.current = place
    }
    pressed.current = null
    shownAll.current = visit.place?.shownAll ?? false

    const scroller = scrollerOf(column.current, visit.wide)
    const page = column.current
    if (scroller === null || page === null) return
    if (visit.place === null || visit.place.wide !== visit.wide) {
      scroller.scrollTop = 0
      lastY.current = 0
      return
    }
    lastY.current = visit.place.y
    const close = holdPlace(page, scroller, visit.place, (settled) => {
      closeHold.current = null
      if (settled !== null) lastY.current = settled
    })
    closeHold.current = close
    return () => close('left')
  }, [visit, column])

  // The key being left, on every key change, because the viewer changes the key
  // without changing the pathname. After the effect above, which reads the old one.
  useLayoutEffect(() => {
    tracked.current = {
      key: location.key,
      pathname: location.pathname,
      path: location.pathname + location.search,
    }
  }, [location.key, location.pathname, location.search])

  // Recording: a passive listener on the active scroller. An element's scroll does
  // not bubble, so the strip's sideways scroll never reaches it. Crossing the
  // breakpoint ends a hold, and the place from then on is the new scroller's.
  useLayoutEffect(() => {
    const scroller = scrollerOf(column.current, wide)
    if (scroller === null) return
    if (seenWide.current !== wide) {
      seenWide.current = wide
      closeHold.current?.('left')
      lastY.current = scroller.scrollTop
    }
    const source: EventTarget = wide ? scroller : window
    const onScroll = () => {
      if (closeHold.current === null) lastY.current = scroller.scrollTop
    }
    source.addEventListener('scroll', onScroll, { passive: true })
    return () => source.removeEventListener('scroll', onScroll)
  }, [wide, column])

  // A press from the keyboard, read before the link's own handler navigates. A
  // mouse or a touch press clears any earlier one, so nothing stale survives it.
  useEffect(() => {
    const page = column.current
    if (page === null) return
    const onClick = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null
      pressed.current =
        event.detail === 0 && link !== null
          ? { href: link.getAttribute('href') as string, pathname: link.pathname }
          : null
    }
    page.addEventListener('click', onClick, { capture: true })
    return () => page.removeEventListener('click', onClick, { capture: true })
  }, [column])

  // The browser's own restoration, off while the frame is mounted: it would restore
  // onto the old page's DOM before React renders. The mode is per history entry and
  // new entries inherit it.
  useEffect(() => {
    const previous = window.history.scrollRestoration
    window.history.scrollRestoration = 'manual'
    return () => {
      window.history.scrollRestoration = previous
    }
  }, [])

  const rememberShownAll = useCallback(() => {
    shownAll.current = true
  }, [])

  return useMemo(
    () => ({
      isReturn: visit.place !== null,
      shownAll: visit.place?.shownAll ?? false,
      rememberShownAll,
    }),
    [visit, rememberShownAll],
  )
}
