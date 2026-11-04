import { useEffect, useRef, useState, type RefObject } from 'react'

// A box that mints its picture only once it nears the viewport (CK-88): the
// grid's tiles below the fold, the strip's thumbnails, and since CK-88.1b a
// section's banner on a group's page. Where the browser has no
// IntersectionObserver (jsdom) it counts as near at once.
export function useNearViewport<T extends Element>(): [RefObject<T | null>, boolean] {
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
