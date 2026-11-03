import {
  useEffect,
  useId,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { fetchLayerObjectUrl, mediaName, type MediaItem } from '../lib/media'
import { Icon } from './Icons'

// The photo viewer (CK-88; the merge record §1.4 and §3 item 8, the mockup's
// screens 11 and 12, the design chat's decisions of 2026-10-14). An overlay
// over the whole window — never a route — opened from a gathering's grid of
// photos, or from a row's thumbnail for that one photo alone.
//
// - A MODAL DIALOG ABOVE THE FRAME. Rendered through a portal into
//   document.body, so it covers the menu column and the bottom bar; while it
//   is open every other child of the body is `inert` — the app's root among
//   them — and the page does not scroll (`body.viewer-open`; the drawer's
//   practice, CK-82). Each of those is put back exactly as it was on close.
//   Focus moves to Close on opening and Tab wraps inside the dialog; the
//   caller returns it to whatever opened the viewer.
// - THE BAR, THE STAGE, THE WORDS, THE STRIP: Close, the photo's name over
//   "{gathering} · {i} of {n}", Full screen; the web layer, contained, with
//   Previous photo and Next photo at FIXED places on the stage — they are
//   the stage's children, never the photo's, so they never move with the
//   photo's shape (Steven, 2026-10-14) — disabled at the ends, hidden while
//   zoomed; "Added by", the tags, the state line and the caller's acts; and
//   a thumbnail per photo in the set, the current one marked. A photo opened
//   from a row is shown alone: no arrows, no strip.
// - ONLY THE PHOTO ANSWERS A CLICK OR A TAP; the space around it does
//   nothing, so a missed arrow is harmless. A mouse: click for full screen,
//   double-click to zoom 2.5x at the point, drag to pan or to swipe. A
//   finger: tap for full screen, double-tap to zoom (in the normal view it
//   opens full screen first), pinch from 1x to 4x in full screen, swipe for
//   the next photo while not zoomed. The keyboard: ArrowLeft and ArrowRight
//   (never inside a text field), and Escape — zoom out, else leave full
//   screen, else close.
// - FULL SCREEN is the photo alone on the stage colour with Zoom in / Zoom
//   out and Leave full screen floating; from 900px (the window) it also asks
//   the browser for full screen, and leaving the browser's full screen
//   leaves the viewer's.
// - THE LAYERS: the web layer only — never archival, which CK-37 refuses —
//   for the current photo and its two neighbours, never more than three held
//   at once, each a `blob:` URL from one fetch (lib/media.ts::
//   fetchLayerObjectUrl, the CK-38 rule: no presigned URL past its fetch),
//   revoked the moment it is let go and all of them on close. The strip's
//   thumbnails mint as they near the viewport.

// A box that mints its picture only once it nears the viewport (CK-88): the
// grid's tiles below the fold and the strip's thumbnails. Where the browser
// has no IntersectionObserver (jsdom) it counts as near at once.
function useNearViewport<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null)
  const [near, setNear] = useState(() => typeof IntersectionObserver !== 'function')
  useEffect(() => {
    if (near) return
    const element = ref.current
    if (element === null) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true)
          observer.disconnect()
        }
      },
      { rootMargin: '200px' },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [near])
  return [ref, near]
}

// One photograph's thumbnail layer, minted when its box nears the viewport,
// held as a `blob:` URL and revoked on unmount. While it loads, or if it
// cannot be shown, the box shows the empty ground alone (CK-88's tiles and
// strip; a row keeps its own thumbnail and its words).
export function LazyThumbnail({ mediaId }: { mediaId: string }) {
  const [box, near] = useNearViewport<HTMLSpanElement>()
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!near) return
    let cancelled = false
    let held: string | null = null
    void fetchLayerObjectUrl(mediaId, 'thumbnail').then((outcome) => {
      if (!outcome.ok) return
      if (cancelled) {
        URL.revokeObjectURL(outcome.objectUrl)
        return
      }
      held = outcome.objectUrl
      setObjectUrl(outcome.objectUrl)
    })
    return () => {
      cancelled = true
      if (held !== null) URL.revokeObjectURL(held)
    }
  }, [near, mediaId])
  return (
    <span ref={box} className="lazy-thumb">
      {objectUrl !== null && <img src={objectUrl} alt="" />}
    </span>
  )
}

// The tags as they are on the photograph: text, one chip each, never a link
// (the CK-21 discipline — nothing here reaches an href or an HTML sink;
// React's escaping covers the text case). A row and the viewer both use it.
export function TagList({ tags, label }: { tags: string[]; label: string }) {
  if (tags.length === 0) return null
  return (
    <ul className="media-tags" aria-label={label}>
      {tags.map((tag) => (
        <li key={tag}>{tag}</li>
      ))}
    </ul>
  )
}

type WebLayer =
  | { status: 'loading' }
  | { status: 'shown'; objectUrl: string }
  | { status: 'failed'; reason: 'not_ready' | 'unavailable' }

interface Held {
  layer: WebLayer
  cancelled: boolean
}

interface Zoom {
  s: number
  x: number
  y: number
}

const NO_ZOOM: Zoom = { s: 1, x: 0, y: 0 }
const ZOOM_AT = 2.5
const PINCH_MAX = 4
const SWIPE_PX = 60
// A single click waits this long for a second one, so a double-click zooms
// without first toggling full screen.
const CLICK_WAIT_MS = 260
const TAP_WAIT_MS = 300

const WIDE = '(min-width: 900px)'
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'

function wideWindow(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(WIDE).matches
}

function isControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('button') !== null
}

function isPhoto(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.vphoto') !== null
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return target.closest('input, textarea, select') !== null
}

interface Props {
  // The set, in order, and the current photograph's id (always in the set).
  photos: MediaItem[]
  current: string
  onMove: (mediaId: string) => void
  // Opened from a row: the photograph alone — no arrows, no strip.
  single: boolean
  // The set's name for the bar: the gathering's title.
  setLabel: string
  // "Added by …" (with its date where the dates are not withheld) and the
  // state line, each from the caller, which knows the seat and the zone.
  addedLine: (item: MediaItem) => string
  stateLine: (item: MediaItem) => string
  // The caller's acts on the current photograph, in the words column.
  acts?: (item: MediaItem) => ReactNode
  onClose: () => void
}

export function PhotoViewer({ photos, current, onMove, single, setLabel, addedLine, stateLine, acts, onClose }: Props) {
  const found = photos.findIndex((photo) => photo.id === current)
  const index = found === -1 ? 0 : found
  const item = photos[index]
  const count = photos.length
  const nameId = useId()

  const [immersive, setImmersiveState] = useState(false)
  const [zoom, setZoomState] = useState<Zoom>(NO_ZOOM)
  const [dragging, setDragging] = useState(false)
  const immersiveRef = useRef(false)
  const zoomRef = useRef<Zoom>(NO_ZOOM)

  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const fullRef = useRef<HTMLButtonElement>(null)
  const prevRef = useRef<HTMLButtonElement>(null)
  const nextRef = useRef<HTMLButtonElement>(null)
  const exitFullRef = useRef<HTMLButtonElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const photoRef = useRef<HTMLImageElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const focusAfterFull = useRef<'exitfull' | 'full' | null>(null)
  const focusAfterMove = useRef<'prev' | 'next' | null>(null)

  // THE MODAL: every other child of the body inert, the page still — and
  // each put back exactly as it was. A layout effect, so the inert attribute
  // is gone before the caller moves focus back into the page.
  useLayoutEffect(() => {
    const own = dialogRef.current
    const changed: Element[] = []
    for (const element of Array.from(document.body.children)) {
      if (element === own || element.hasAttribute('inert')) continue
      element.setAttribute('inert', '')
      changed.push(element)
    }
    document.body.classList.add('viewer-open')
    return () => {
      for (const element of changed) element.removeAttribute('inert')
      document.body.classList.remove('viewer-open')
    }
  }, [])

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true })
  }, [])

  // THE LAYERS: the current photograph's web layer and its two neighbours',
  // never more; everything else let go and revoked.
  const held = useRef(new Map<string, Held>())
  const [, layersChanged] = useReducer((n: number) => n + 1, 0)
  const wanted = (single ? [index] : [index - 1, index, index + 1])
    .filter((position) => position >= 0 && position < count)
    .map((position) => photos[position].id)
  const wantedKey = wanted.join(' ')
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    const keep = new Set(wantedKey === '' ? [] : wantedKey.split(' '))
    for (const [mediaId, entry] of held.current) {
      if (keep.has(mediaId)) continue
      entry.cancelled = true
      if (entry.layer.status === 'shown') URL.revokeObjectURL(entry.layer.objectUrl)
      held.current.delete(mediaId)
    }
    for (const mediaId of keep) {
      if (held.current.has(mediaId)) continue
      const entry: Held = { layer: { status: 'loading' }, cancelled: false }
      held.current.set(mediaId, entry)
      void fetchLayerObjectUrl(mediaId, 'web').then((outcome) => {
        if (entry.cancelled) {
          if (outcome.ok) URL.revokeObjectURL(outcome.objectUrl)
          return
        }
        entry.layer = outcome.ok
          ? { status: 'shown', objectUrl: outcome.objectUrl }
          : { status: 'failed', reason: outcome.reason }
        layersChanged()
      })
    }
    layersChanged()
  }, [wantedKey, retryKey])

  useEffect(() => {
    const layers = held.current
    return () => {
      for (const entry of layers.values()) {
        entry.cancelled = true
        if (entry.layer.status === 'shown') URL.revokeObjectURL(entry.layer.objectUrl)
      }
      layers.clear()
    }
  }, [])

  function retryCurrent() {
    const entry = held.current.get(item.id)
    if (entry !== undefined) {
      entry.cancelled = true
      held.current.delete(item.id)
    }
    setRetryKey((key) => key + 1)
  }

  function setZoom(next: Zoom) {
    zoomRef.current = next
    setZoomState(next)
  }

  function clampPan(next: Zoom): Zoom {
    const photo = photoRef.current
    if (photo === null) return next
    const mx = (photo.offsetWidth * (next.s - 1)) / 2
    const my = (photo.offsetHeight * (next.s - 1)) / 2
    return { s: next.s, x: Math.max(-mx, Math.min(mx, next.x)), y: Math.max(-my, Math.min(my, next.y)) }
  }

  // 2.5x at the point, or back to 1x when already zoomed.
  function zoomAt(cx: number, cy: number) {
    const photo = photoRef.current
    if (zoomRef.current.s > 1 || photo === null) {
      setZoom(NO_ZOOM)
      return
    }
    const rect = photo.getBoundingClientRect()
    const px = cx - (rect.left + rect.width / 2)
    const py = cy - (rect.top + rect.height / 2)
    setZoom(clampPan({ s: ZOOM_AT, x: -px * (ZOOM_AT - 1), y: -py * (ZOOM_AT - 1) }))
  }

  function zoomAtCentre() {
    const photo = photoRef.current
    if (photo === null) return
    const rect = photo.getBoundingClientRect()
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2)
  }

  function exitBrowserFullscreen() {
    if (document.fullscreenElement && typeof document.exitFullscreen === 'function') {
      document.exitFullscreen().catch(() => {})
    }
  }

  function setImmersive(on: boolean, quiet = false) {
    immersiveRef.current = on
    setImmersiveState(on)
    if (!on) setZoom(NO_ZOOM)
    const dialog = dialogRef.current
    if (on && wideWindow() && dialog !== null && typeof dialog.requestFullscreen === 'function') {
      try {
        dialog.requestFullscreen().catch(() => {})
      } catch {
        // A browser that refuses outright: the viewer's own full screen stands.
      }
    }
    if (!on) exitBrowserFullscreen()
    if (!quiet) focusAfterFull.current = on ? 'exitfull' : 'full'
  }

  useEffect(() => {
    const want = focusAfterFull.current
    focusAfterFull.current = null
    if (want === 'exitfull') exitFullRef.current?.focus({ preventScroll: true })
    else if (want === 'full') fullRef.current?.focus({ preventScroll: true })
  }, [immersive])

  // Leaving the browser's full screen (its own Escape, a gesture) leaves the
  // viewer's; and closing the viewer leaves the browser's.
  useEffect(() => {
    function onChange() {
      if (!document.fullscreenElement && immersiveRef.current) {
        immersiveRef.current = false
        setImmersiveState(false)
        setZoom(NO_ZOOM)
      }
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      if (document.fullscreenElement && typeof document.exitFullscreen === 'function') {
        document.exitFullscreen().catch(() => {})
      }
    }
  }, [])

  // MOVING: the arrows, the strip, the keyboard and a swipe. Moving resets
  // the zoom; the caller closes any open step.
  function go(position: number, focus: 'prev' | 'next' | null = null) {
    if (single || position < 0 || position >= count || position === index) return
    setZoom(NO_ZOOM)
    focusAfterMove.current = focus
    onMove(photos[position].id)
  }

  useEffect(() => {
    const want = focusAfterMove.current
    focusAfterMove.current = null
    if (want !== null) {
      const control = want === 'prev' ? prevRef.current : nextRef.current
      if (control !== null && !control.disabled) control.focus({ preventScroll: true })
      else if (!immersiveRef.current) closeRef.current?.focus({ preventScroll: true })
    }
    const marked = stripRef.current?.querySelector<HTMLElement>('[aria-current="true"]')
    marked?.scrollIntoView?.({ block: 'nearest', inline: 'center' })
  }, [current])

  // The keyboard, on the document while the viewer is open; the handler reads
  // the latest render through a ref.
  const latest = useRef({ escape: () => {}, step: (_delta: number) => {} })
  useLayoutEffect(() => {
    latest.current = {
      escape: () => {
        if (zoomRef.current.s > 1) setZoom(NO_ZOOM)
        else if (immersiveRef.current) setImmersive(false)
        else onClose()
      },
      step: (delta: number) => go(index + delta, delta < 0 ? 'prev' : 'next'),
    }
  })
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        latest.current.escape()
        return
      }
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      if (isEditable(event.target)) return
      event.preventDefault()
      latest.current.step(event.key === 'ArrowLeft' ? -1 : 1)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  // Tab and Shift+Tab wrap inside the dialog.
  function keepFocusIn(event: ReactKeyboardEvent) {
    if (event.key !== 'Tab' || dialogRef.current === null) return
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (element) => element.offsetParent !== null || element === document.activeElement,
    )
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  // THE GESTURES. Only the photograph answers; a press on a control is the
  // control's. Taps are told apart by their timing, because the stage takes
  // every touch itself (touch-action: none), so a finger gets no dblclick.
  const gesture = useRef({
    points: new Map<number, { x: number; y: number }>(),
    pinch: null as null | { d0: number; s0: number; c: { x: number; y: number }; u: { x: number; y: number } },
    pan: null as null | { x: number; y: number; sx: number; sy: number },
    moved: false,
    two: false,
    downOnPhoto: false,
    lastTap: { t: 0, x: 0, y: 0 },
    tapTimer: 0,
    clickTimer: 0,
    drag: null as null | { x: number; y: number; sx: number; sy: number },
    dragMoved: false,
    type: 'mouse',
  })

  useEffect(() => {
    const timers = gesture.current
    const dialog = dialogRef.current
    // Safari's own pinch on the page is not the photo's.
    const stop = (event: Event) => event.preventDefault()
    dialog?.addEventListener('gesturestart', stop)
    dialog?.addEventListener('gesturechange', stop)
    return () => {
      window.clearTimeout(timers.tapTimer)
      window.clearTimeout(timers.clickTimer)
      dialog?.removeEventListener('gesturestart', stop)
      dialog?.removeEventListener('gesturechange', stop)
    }
  }, [])

  function singleTap() {
    if (zoomRef.current.s === 1) setImmersive(!immersiveRef.current)
  }

  function doubleTap(x: number, y: number) {
    if (immersiveRef.current) {
      zoomAt(x, y)
      return
    }
    // In the normal view a double-tap opens full screen first, then zooms at
    // the same place on the larger photograph.
    const photo = photoRef.current
    const rect = photo?.getBoundingClientRect()
    const fx = rect && rect.width ? (x - rect.left) / rect.width : 0.5
    const fy = rect && rect.height ? (y - rect.top) / rect.height : 0.5
    setImmersive(true, true)
    window.requestAnimationFrame(() => {
      const after = photoRef.current?.getBoundingClientRect()
      if (!after) return
      zoomRef.current = NO_ZOOM
      zoomAt(after.left + fx * after.width, after.top + fy * after.height)
    })
  }

  function tap(x: number, y: number) {
    const g = gesture.current
    const now = performance.now()
    if (now - g.lastTap.t < 320 && Math.hypot(x - g.lastTap.x, y - g.lastTap.y) < 40) {
      window.clearTimeout(g.tapTimer)
      g.lastTap.t = 0
      doubleTap(x, y)
    } else {
      g.lastTap = { t: now, x, y }
      window.clearTimeout(g.tapTimer)
      g.tapTimer = window.setTimeout(singleTap, TAP_WAIT_MS)
    }
  }

  function stageCentre() {
    const stage = stageRef.current?.getBoundingClientRect()
    const photo = photoRef.current
    if (!stage || photo === null) return { x: 0, y: 0 }
    return { x: stage.left + photo.offsetLeft + photo.offsetWidth / 2, y: stage.top + photo.offsetTop + photo.offsetHeight / 2 }
  }

  function onPointerDown(event: ReactPointerEvent) {
    const g = gesture.current
    g.type = event.pointerType || 'mouse'
    if (isControl(event.target)) return
    if (g.type === 'mouse') {
      g.drag = { x: event.clientX, y: event.clientY, sx: zoomRef.current.x, sy: zoomRef.current.y }
      g.dragMoved = false
      setDragging(true)
      return
    }
    try {
      stageRef.current?.setPointerCapture?.(event.pointerId)
    } catch {
      // Capture is a nicety; the gesture works without it inside the stage.
    }
    g.points.set(event.pointerId, { x: event.clientX, y: event.clientY })
    setDragging(true)
    if (g.points.size === 2) {
      g.two = true
      g.moved = true
      g.pan = null
      if (immersiveRef.current) {
        const [a, b] = Array.from(g.points.values())
        const c = stageCentre()
        const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        const z = zoomRef.current
        g.pinch = {
          d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
          s0: z.s,
          c,
          u: { x: (m.x - c.x - z.x) / z.s, y: (m.y - c.y - z.y) / z.s },
        }
      }
    } else if (g.points.size === 1) {
      g.two = false
      g.moved = false
      g.downOnPhoto = isPhoto(event.target)
      g.pan = { x: event.clientX, y: event.clientY, sx: zoomRef.current.x, sy: zoomRef.current.y }
    }
  }

  function onPointerMove(event: ReactPointerEvent) {
    const g = gesture.current
    if (g.drag !== null && event.pointerType === 'mouse') {
      if ((event.buttons & 1) === 0) {
        g.drag = null
        setDragging(false)
        return
      }
      const dx = event.clientX - g.drag.x
      const dy = event.clientY - g.drag.y
      if (Math.hypot(dx, dy) > 6) g.dragMoved = true
      if (zoomRef.current.s > 1) setZoom(clampPan({ s: zoomRef.current.s, x: g.drag.sx + dx, y: g.drag.sy + dy }))
      return
    }
    if (!g.points.has(event.pointerId)) return
    g.points.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (g.pinch !== null && g.points.size >= 2) {
      const [a, b] = Array.from(g.points.values())
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const s = Math.max(1, Math.min(PINCH_MAX, (g.pinch.s0 * Math.hypot(a.x - b.x, a.y - b.y)) / g.pinch.d0))
      setZoom(clampPan({ s, x: m.x - g.pinch.c.x - s * g.pinch.u.x, y: m.y - g.pinch.c.y - s * g.pinch.u.y }))
      return
    }
    if (g.pan !== null && g.points.size === 1) {
      const dx = event.clientX - g.pan.x
      const dy = event.clientY - g.pan.y
      if (Math.hypot(dx, dy) > 8) g.moved = true
      if (zoomRef.current.s > 1) setZoom(clampPan({ s: zoomRef.current.s, x: g.pan.sx + dx, y: g.pan.sy + dy }))
    }
  }

  function swipe(dx: number, dy: number) {
    if (zoomRef.current.s === 1 && Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
      go(dx < 0 ? index + 1 : index - 1)
    }
  }

  function onPointerUp(event: ReactPointerEvent) {
    const g = gesture.current
    if (g.drag !== null && event.pointerType === 'mouse') {
      const dx = event.clientX - g.drag.x
      const dy = event.clientY - g.drag.y
      g.drag = null
      setDragging(false)
      swipe(dx, dy)
      return
    }
    if (!g.points.has(event.pointerId)) return
    g.points.delete(event.pointerId)
    if (g.pinch !== null) {
      if (g.points.size < 2) {
        g.pinch = null
        if (zoomRef.current.s < 1.08) setZoom(NO_ZOOM)
        if (g.points.size === 1) {
          const p = Array.from(g.points.values())[0]
          g.pan = { x: p.x, y: p.y, sx: zoomRef.current.x, sy: zoomRef.current.y }
        } else {
          setDragging(false)
        }
      }
      return
    }
    if (g.points.size > 0) return
    setDragging(false)
    if (g.two) {
      // A pinch in the normal view opens full screen; pinch again to zoom.
      g.two = false
      g.pan = null
      if (!immersiveRef.current) setImmersive(true)
      return
    }
    if (g.pan === null) return
    const dx = event.clientX - g.pan.x
    const dy = event.clientY - g.pan.y
    g.pan = null
    if (event.type === 'pointercancel') return
    if (!g.moved) {
      if (g.downOnPhoto) tap(event.clientX, event.clientY)
    } else {
      swipe(dx, dy)
    }
  }

  function onStageClick(event: ReactMouseEvent) {
    const g = gesture.current
    if (isControl(event.target) || g.type !== 'mouse') return
    if (g.dragMoved) {
      g.dragMoved = false
      return
    }
    if (!isPhoto(event.target)) return
    window.clearTimeout(g.clickTimer)
    g.clickTimer = window.setTimeout(singleTap, CLICK_WAIT_MS)
  }

  function onStageDoubleClick(event: ReactMouseEvent) {
    const g = gesture.current
    if (isControl(event.target) || g.type !== 'mouse' || !isPhoto(event.target)) return
    window.clearTimeout(g.clickTimer)
    zoomAt(event.clientX, event.clientY)
  }

  const zoomed = zoom.s > 1
  const layer = held.current.get(item.id)?.layer ?? { status: 'loading' }
  const className = ['viewer', immersive ? 'immersive' : '', zoomed ? 'zoomed' : ''].filter(Boolean).join(' ')
  const name = mediaName(item)

  return createPortal(
    <div
      ref={dialogRef}
      className={className}
      role="dialog"
      aria-modal="true"
      aria-labelledby={nameId}
      onKeyDown={keepFocusIn}
    >
      <div className="vbar">
        <button ref={closeRef} type="button" className="iconbtn" aria-label="Close" onClick={onClose}>
          <Icon name="back" />
        </button>
        <div className="vtitle">
          <b id={nameId}>{name}</b>
          <span>
            {setLabel} · {index + 1} of {count}
          </span>
        </div>
        <button ref={fullRef} type="button" className="iconbtn" aria-label="Full screen" onClick={() => setImmersive(true)}>
          <Icon name="expand" />
        </button>
      </div>
      <div
        ref={stageRef}
        className="vstage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={onStageClick}
        onDoubleClick={onStageDoubleClick}
      >
        {!single && (
          <button
            ref={prevRef}
            type="button"
            className="varrow prev"
            aria-label="Previous photo"
            disabled={index === 0}
            onClick={() => go(index - 1, 'prev')}
          >
            <Icon name="prev" />
          </button>
        )}
        {layer.status === 'shown' ? (
          <img
            ref={photoRef}
            className={dragging ? 'vphoto dragging' : 'vphoto'}
            src={layer.objectUrl}
            alt={item.caption !== null && item.caption !== '' ? item.caption : 'A photo'}
            draggable={false}
            style={zoomed ? { transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})` } : undefined}
          />
        ) : layer.status === 'failed' ? (
          <span className="vplaceholder">
            {layer.reason === 'not_ready' ? 'Not ready to show yet.' : "Couldn't show this photo just now."}{' '}
            <button type="button" className="link-button" onClick={retryCurrent}>
              Retry
            </button>
          </span>
        ) : (
          <span className="vplaceholder">Loading…</span>
        )}
        {!single && (
          <button
            ref={nextRef}
            type="button"
            className="varrow next"
            aria-label="Next photo"
            disabled={index === count - 1}
            onClick={() => go(index + 1, 'next')}
          >
            <Icon name="next" />
          </button>
        )}
        {immersive && (
          <div className="vfloat">
            <button type="button" aria-label={zoomed ? 'Zoom out' : 'Zoom in'} onClick={zoomAtCentre}>
              <Icon name={zoomed ? 'zoomOut' : 'zoomIn'} />
            </button>
            <button ref={exitFullRef} type="button" aria-label="Leave full screen" onClick={() => setImmersive(false)}>
              <Icon name="shrink" />
            </button>
          </div>
        )}
      </div>
      <div className="vinfo">
        <p className="vline">{addedLine(item)}</p>
        <TagList tags={item.tags} label={`Tags on ${name}`} />
        <p className="vstate">{stateLine(item)}</p>
        {acts?.(item)}
      </div>
      {!single && (
        <div ref={stripRef} className="vstrip" role="group" aria-label="Photos here">
          {photos.map((photo, position) => (
            <button
              key={photo.id}
              type="button"
              aria-label={`${position + 1} of ${count}: ${mediaName(photo)}`}
              aria-current={position === index ? 'true' : undefined}
              onClick={() => go(position)}
            >
              <LazyThumbnail mediaId={photo.id} />
            </button>
          ))}
        </div>
      )}
    </div>,
    document.body,
  )
}
