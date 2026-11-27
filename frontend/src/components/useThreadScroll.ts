// Where a chat's thread stands (CK-103; since CK-105 THE DESIGN §2 to §6 and
// §9). NOTHING ANOTHER PERSON DOES MOVES WHAT IS ON SCREEN: a message arriving,
// reactions growing a row, a held row appearing, shown or hidden, a newer page
// below — through every change the topmost entry in view keeps its place, at
// the foot as anywhere (the 48px follow of CK-103 is gone). Only these move
// the view: opening, at the New messages line or at the foot; a first read
// afresh, which keeps the topmost entry where it was if it is still loaded;
// the caller's own send, brought into view; the button to the newest; and the
// person's own scrolling. The thread's own size changing while its newest is
// in view (a keyboard, the box growing, a turned phone) keeps the newest in
// view.
//
// BY HAND. The browsers' own anchoring is turned off in the stylesheet: it
// isn't in every browser. What is in view is written down after each change
// and each scroll, and read back after the next change — so the place a
// reader is kept at is one they were at, never one worked out from heights.
// What grows without a render (the list's own height) is watched as well.
//
// WHAT IT TELLS THE PAGE: whether the button to the newest shows (the last
// entry's foot more than 48px below the view's foot, or a gap below), whether
// it carries its dot (a live message from someone else below the view, never
// seen and later than what the person had reached when it opened, or a gap
// below), and each entry seen — its foot inside the view,
// or the whole view filled by it, with the tab visible.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { compareEntries, type ChatItem } from '../lib/chat'
import type { Position } from './useChat'

// The newest is in view while its foot is within this of the view's foot.
const NEAR = 48
// Under this a difference is the browser's rounding.
const ROUNDING = 0.5

export interface Drawn {
  entries: ChatItem[]
  // How many first reads have landed: the thread places itself on each.
  opened: number
  // Moves with the caller's own send, `sent` its message.
  newest: number
  sent: string | null
  // Moves when the button to the newest has done its part.
  toNewest: number
  // Whether what is loaded stops short of the newest.
  newer: boolean
  // What the person had reached when the chat opened: never new to them.
  reached: Position | null
}

export interface ThreadView {
  jump: boolean
  dot: boolean
}

interface Place {
  drawn: Drawn
  width: number
  height: number
  // The newest entry is in view.
  newestInView: boolean
  // The entries in view, from the top, and where each stood in the thread.
  inView: { id: string; top: number }[]
}

const QUIET: ThreadView = { jump: false, dot: false }

function fromSomeoneElse(item: ChatItem): boolean {
  return item.kind === 'message' && item.removed === null && !item.author.is_self
}

function tabVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

export function useThreadScroll(
  thread: RefObject<HTMLElement | null>,
  list: RefObject<HTMLElement | null>,
  newLine: RefObject<HTMLElement | null>,
  drawn: Drawn,
  row: (id: string) => HTMLElement | null,
  seen: (id: string) => void,
): ThreadView {
  const place = useRef<Place | null>(null)
  const latest = useRef(drawn)
  const onSeen = useRef(seen)
  // Every entry seen while the page has been open: the dot is for the others.
  const seenIds = useRef(new Set<string>())
  const [view, setView] = useState<ThreadView>(QUIET)

  const write = useCallback(() => {
    const element = thread.current
    if (element === null) return
    const top = element.getBoundingClientRect().top
    const height = element.clientHeight
    const bottom = top + height
    const now = latest.current
    const { entries } = now
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
    const looking = height > 0 && tabVisible()
    const inView: Place['inView'] = []
    let newestSeen: string | null = null
    // The first entry whose foot is below the view's.
    let below = entries.length
    let n = low
    for (; n < entries.length; n += 1) {
      const { id } = entries[n]
      const box = row(id)?.getBoundingClientRect()
      if (box === undefined || box.top >= bottom) break
      inView.push({ id, top: box.top - top })
      const footIn = box.bottom <= bottom + ROUNDING
      if (!footIn && below === entries.length) below = n
      if (looking && (footIn || (box.top <= top + ROUNDING && box.bottom >= bottom - ROUNDING))) {
        seenIds.current.add(id)
        newestSeen = id
      }
    }
    if (below === entries.length) below = n
    const last = entries.length === 0 ? null : row(entries[entries.length - 1].id)?.getBoundingClientRect()
    const newestInView = !now.newer && (last == null || last.bottom - bottom <= NEAR)
    place.current = {
      drawn: now,
      width: element.clientWidth,
      height,
      newestInView,
      inView,
    }
    const next: ThreadView = {
      jump: !newestInView,
      dot:
        now.newer ||
        entries
          .slice(below)
          .some(
            (item) =>
              fromSomeoneElse(item) &&
              !seenIds.current.has(item.id) &&
              (now.reached === null || compareEntries(item, now.reached) > 0),
          ),
    }
    setView((was) => (was.jump === next.jump && was.dot === next.dot ? was : next))
    if (newestSeen !== null) onSeen.current(newestSeen)
  }, [thread, row])

  const toFoot = useCallback(() => {
    const element = thread.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [thread])

  // The topmost entry that was in view and is still here goes back to where
  // it stood. Whether there was one.
  const putBack = useCallback(
    (inView: Place['inView']) => {
      const element = thread.current
      if (element === null) return false
      const top = element.getBoundingClientRect().top
      for (const was of inView) {
        const box = row(was.id)?.getBoundingClientRect()
        if (box === undefined) continue
        const moved = box.top - top - was.top
        if (Math.abs(moved) > ROUNDING) element.scrollTop += moved
        return true
      }
      return false
    },
    [thread, row],
  )

  // Opening: the New messages line at the top of the view, or the foot where
  // there is no line — and the foot where what is below the line is too
  // short, which the browser's own clamp does.
  const open = useCallback(() => {
    const element = thread.current
    const mark = newLine.current
    if (element === null) return
    if (mark === null) return toFoot()
    element.scrollTop += mark.getBoundingClientRect().top - element.getBoundingClientRect().top
  }, [thread, newLine, toFoot])

  // The caller's own message: the whole of it where it fits, its foot at the
  // view's foot; its top at the view's top where it is taller than the view.
  const toSent = useCallback(
    (id: string | null) => {
      const element = thread.current
      if (element === null) return
      const { entries } = latest.current
      const target = id === null ? null : row(id)
      if (target === null) return toFoot()
      const box = target.getBoundingClientRect()
      const top = element.getBoundingClientRect().top
      if (box.height > element.clientHeight) element.scrollTop += box.top - top
      else if (entries[entries.length - 1]?.id === id) toFoot()
      else element.scrollTop += box.bottom - (top + element.clientHeight)
    },
    [thread, row, toFoot],
  )

  const settle = useCallback(() => {
    const element = thread.current
    if (element === null) {
      place.current = null
      return
    }
    const was = place.current
    const now = latest.current
    if (was === null) open()
    else if (was.drawn.opened !== now.opened) {
      if (!putBack(was.inView)) open()
    } else if (was.drawn.newest !== now.newest) toSent(now.sent)
    else if (was.drawn.toNewest !== now.toNewest) toFoot()
    else if (was.newestInView && (was.width !== element.clientWidth || was.height !== element.clientHeight)) toFoot()
    else putBack(was.inView)
    write()
  }, [thread, open, putBack, toSent, toFoot, write])

  // After every render of the page the thread is on, before it is painted.
  useLayoutEffect(() => {
    latest.current = drawn
    onSeen.current = seen
    settle()
  })

  // The list's own height, and the thread's box: a row that grows above the
  // view puts the view back.
  const watched = useRef<{ observer: ResizeObserver | null; list: HTMLElement | null }>({ observer: null, list: null })
  useLayoutEffect(() => {
    const { observer } = watched.current
    if (observer === null || watched.current.list === list.current) return
    if (watched.current.list !== null) observer.unobserve(watched.current.list)
    watched.current.list = list.current
    if (list.current !== null) observer.observe(list.current)
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
    // What is in view is seen once the tab comes back.
    const onVisibility = () => write()
    document.addEventListener('visibilitychange', onVisibility)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => settle())
    observer?.observe(element)
    const holder = watched.current
    holder.observer = observer
    holder.list = null
    if (observer !== null && list.current !== null) {
      observer.observe(list.current)
      holder.list = list.current
    }
    return () => {
      element.removeEventListener('scroll', onScroll)
      document.removeEventListener('visibilitychange', onVisibility)
      observer?.disconnect()
      holder.observer = null
      holder.list = null
    }
  }, [thread, list, settle, write])

  return view
}
