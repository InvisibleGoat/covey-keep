// Where the visible part of the window is (CK-103): a phone's keyboard shortens
// the visual viewport and leaves the layout's alone, so a column pinned to the
// layout would keep its foot behind the keyboard. Null where the browser has
// no `visualViewport`; the stylesheet's own height stands then.
//
// A pinch makes the visual viewport smaller without taking any of the screen
// away, so its height is read at the page's own scale and its offset is left
// alone while it lasts.
import { useLayoutEffect, useState } from 'react'

export interface VisibleBox {
  top: number
  height: number
}

// Above this the page is pinched; a scale of 1 reads a hair over on some
// phones.
const PINCHED = 1.02

function visibleBox(): VisibleBox | null {
  const viewport = window.visualViewport
  if (!viewport) return null
  const pinched = viewport.scale > PINCHED
  return {
    top: pinched ? 0 : Math.max(0, Math.round(viewport.offsetTop)),
    height: Math.round(pinched ? viewport.height * viewport.scale : viewport.height),
  }
}

function same(a: VisibleBox | null, b: VisibleBox | null): boolean {
  return a?.top === b?.top && a?.height === b?.height
}

export function useVisualViewport(): VisibleBox | null {
  const [box, setBox] = useState(visibleBox)

  useLayoutEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const onChange = () =>
      setBox((was) => {
        const now = visibleBox()
        return same(was, now) ? was : now
      })
    onChange()
    viewport.addEventListener('resize', onChange)
    viewport.addEventListener('scroll', onChange)
    return () => {
      viewport.removeEventListener('resize', onChange)
      viewport.removeEventListener('scroll', onChange)
    }
  }, [])

  return box
}
