import { useEffect, useState } from 'react'

// The grid's preview (CK-88; Steven's answer 2 of 2026-11-02): the mockup's
// first row or two — 6 tiles on a phone, 8 from 640px — read from the WINDOW
// (the frame's practice; jsdom has no matchMedia and reads as a phone). A
// gathering's grid and a group page's sections read the same (CK-88.1b).
const PREVIEW_WIDE = '(min-width: 640px)'
export const PREVIEW_PHONE = 6
export const PREVIEW_WIDE_COUNT = 8

function matchesPreviewWide(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(PREVIEW_WIDE).matches
}

export function usePreviewWide(): boolean {
  const [wide, setWide] = useState(matchesPreviewWide)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(PREVIEW_WIDE)
    const onChange = () => setWide(query.matches)
    onChange()
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return wide
}
