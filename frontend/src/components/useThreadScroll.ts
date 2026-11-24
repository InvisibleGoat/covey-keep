// Where a chat's thread stands (CK-103; THE DESIGN §9). It opens at the newest
// message and, within 48px of the bottom, stays there as messages come and go
// and as its own size changes; anywhere else nothing moves, whatever arrives,
// changes or goes: the entry at the top of the view stays where it was. What
// stands above the entries, and an earlier page, move nothing even there. The
// caller's own send goes to the newest.
//
// BY HAND. The browsers' own anchoring is turned off in the stylesheet: it
// isn't in every browser, and it doesn't know the bottom from anywhere else.
// What is in view is written down after each change and each scroll, and read
// back after the next change — so the place a reader is kept at is one they
// were at, never one worked out from heights.
//
// WHAT COUNTS AS A CHANGE: an entry that came, went or became its held row;
// what stands above the entries (the notice, Show earlier messages and its
// line); and the thread's own size (the keyboard, the box growing, a turned
// phone). A step that opens and a held message that is shown are neither, so
// they move nothing.
import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import type { ChatItem } from '../lib/chat'

const NEAR = 48
// Under this a difference is the browser's rounding.
const ROUNDING = 0.5

interface Drawn {
  entries: ChatItem[]
  newest: number
  above: string
}

interface Place {
  drawn: Drawn
  width: number
  height: number
  atBottom: boolean
  // The entries in view, from the top, and where each stood in the thread.
  inView: { id: string; top: number }[]
}

function sameEntries(a: ChatItem[], b: ChatItem[]): boolean {
  if (a === b) return true
  return (
    a.length === b.length &&
    a.every((item, n) => item.id === b[n].id && (item.removed === null) === (b[n].removed === null))
  )
}

// An earlier page: what was first is still here, and no longer first.
function putBefore(was: ChatItem[], now: ChatItem[]): boolean {
  if (was.length === 0 || now.length === 0 || now[0].id === was[0].id) return false
  return now.some((item) => item.id === was[0].id)
}

export function useThreadScroll(
  thread: RefObject<HTMLElement | null>,
  drawn: Drawn,
  row: (id: string) => HTMLElement | null,
) {
  const place = useRef<Place | null>(null)
  const latest = useRef(drawn)

  const write = useCallback(() => {
    const element = thread.current
    if (element === null) return
    const top = element.getBoundingClientRect().top
    const bottom = top + element.clientHeight
    const { entries } = latest.current
    // The first entry that reaches into the view: the entries stand in order,
    // so it is found by halves.
    let low = 0
    let high = entries.length
    while (low < high) {
      const middle = (low + high) >> 1
      const reaches = (row(entries[middle].id)?.getBoundingClientRect().bottom ?? 0) > top
      if (reaches) high = middle
      else low = middle + 1
    }
    const inView: Place['inView'] = []
    for (const { id } of entries.slice(low)) {
      const box = row(id)?.getBoundingClientRect()
      if (box === undefined || box.top >= bottom) break
      inView.push({ id, top: box.top - top })
    }
    place.current = {
      drawn: latest.current,
      width: element.clientWidth,
      height: element.clientHeight,
      atBottom: element.scrollHeight - element.clientHeight - element.scrollTop <= NEAR,
      inView,
    }
  }, [thread, row])

  const toBottom = useCallback(() => {
    const element = thread.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [thread])

  // The topmost entry that was in view and is still here goes back to where
  // it stood.
  const putBack = useCallback(
    (inView: Place['inView']) => {
      const element = thread.current
      if (element === null) return
      const top = element.getBoundingClientRect().top
      for (const was of inView) {
        const box = row(was.id)?.getBoundingClientRect()
        if (box === undefined) continue
        const moved = box.top - top - was.top
        if (Math.abs(moved) > ROUNDING) element.scrollTop += moved
        return
      }
    },
    [thread, row],
  )

  const settle = useCallback(() => {
    const element = thread.current
    if (element === null) {
      place.current = null
      return
    }
    const was = place.current
    const now = latest.current
    if (was === null || was.drawn.newest !== now.newest) toBottom()
    else {
      const entriesChanged = !sameEntries(was.drawn.entries, now.entries)
      const sizeChanged = was.width !== element.clientWidth || was.height !== element.clientHeight
      if (entriesChanged || sizeChanged || was.drawn.above !== now.above) {
        const arrived = entriesChanged && !putBefore(was.drawn.entries, now.entries)
        if (was.atBottom && (arrived || sizeChanged)) toBottom()
        else putBack(was.inView)
      }
    }
    write()
  }, [thread, toBottom, putBack, write])

  // After every render of the page the thread is on, before it is painted.
  useLayoutEffect(() => {
    latest.current = drawn
    settle()
  })

  useEffect(() => {
    const element = thread.current
    if (element === null) return
    // A scroll that comes with a change of size is the browser's own clamp.
    const onScroll = () => {
      const was = place.current
      if (was !== null && (was.width !== element.clientWidth || was.height !== element.clientHeight)) settle()
      else write()
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => settle())
    observer?.observe(element)
    return () => {
      element.removeEventListener('scroll', onScroll)
      observer?.disconnect()
    }
  }, [thread, settle, write])
}
