// Focus after an answer (CK-94; CK-93.1's mechanism, made one copy). A press
// disables the control it was made on, or removes it, and the browser then
// drops focus to the body while the request waits — so a failure needs a
// move as much as a success does, and each answer names where focus goes
// next (reference/frontend/components.md, Focus after an answer).
//
// THE REQUEST IS STATE, never a ref: `requestFocus(target)` sets a fresh
// object in the same batch as the change that draws the target, and ONE
// effect spends it after the render that draws it. A ref set after an await
// can be read by the effect of an earlier render that commits in between —
// the control still disabled — and spent on nothing (found in CK-93.1's
// tests). A fresh object each time, so the same target asked twice is moved
// to twice; and the effect runs on the request alone, so a later render
// spends nothing.
//
// THE TARGET is a ref or a function, read when the request is spent, so a
// row that only exists after the answer (a re-read list's button, the next
// row's) can be found by the render that draws it.
//
// EVERY MOVE TAKES FOCUS ONLY FROM THE BODY OR FROM INSIDE THE CONTAINER
// (`mayTakeFocus`): the section the act belongs to. A person who moved
// elsewhere while the request waited keeps their place. The container is a
// ref or a function read at spend time — the invite form is drawn in two
// sections, so its container is whichever it is in — held in a ref the
// layout effect keeps current, so `requestFocus` stays one function for the
// life of the component and the spend effect runs on the request alone.
//
// No `preventScroll`: the target is the next thing the person acts on, and
// the browser brings it into view as it would for a Tab.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

export type FocusSource = RefObject<HTMLElement | null> | (() => HTMLElement | null)

function resolve(source: FocusSource): HTMLElement | null {
  return typeof source === 'function' ? source() : source.current
}

// Whether a move after an answer may take focus: only from the body (where
// the browser leaves it once the pressed control is disabled or gone) or
// from inside the piece that asked, never from where the person moved to
// while the request waited.
export function mayTakeFocus(container: HTMLElement | null): boolean {
  const active = document.activeElement
  return active === null || active === document.body || (container !== null && container.contains(active))
}

export function useFocusRequest(container: FocusSource): (target: FocusSource) => void {
  const [request, setRequest] = useState<{ target: FocusSource } | null>(null)

  // The container of the latest committed render. Layout effects run before
  // passive ones, so the spend effect below reads the render that drew the
  // target; a new inline function for the container changes nothing else.
  const latestContainer = useRef(container)
  useLayoutEffect(() => {
    latestContainer.current = container
  })

  // Keyed on the request alone, so a later render spends nothing again.
  useEffect(() => {
    if (request === null || !mayTakeFocus(resolve(latestContainer.current))) return
    resolve(request.target)?.focus()
  }, [request])

  return useCallback((target: FocusSource) => setRequest({ target }), [])
}

// The 422 rung: the first field in `container` that carries an error, in the
// order the form draws its fields. A field points at its inline error through
// aria-describedby (`error-<field>` or `error-<scope>-<field>`, the one
// mapper's contract — lib/formErrors.ts::describedBy) only while it has one,
// so the first such element is the first field the refusal names; null when
// the refusal names no field on screen.
export function firstFieldWithError(container: HTMLElement | null): HTMLElement | null {
  return (
    container?.querySelector<HTMLElement>(
      'input[aria-describedby^="error-"], select[aria-describedby^="error-"], textarea[aria-describedby^="error-"]',
    ) ?? null
  )
}

// A map of elements by key, for a target that is one row of a list: a
// row's `ref={register(key)}`, and `get(key)` when the request is spent.
export function useRefMap<K>() {
  const [map] = useState(() => new Map<K, HTMLElement>())
  const register = useCallback(
    (key: K) => (element: HTMLElement | null) => {
      if (element) map.set(key, element)
      else map.delete(key)
    },
    [map],
  )
  const get = useCallback((key: K) => map.get(key) ?? null, [map])
  return { register, get }
}
