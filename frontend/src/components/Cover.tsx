import { useEffect, useState, type ReactNode } from 'react'
import { EMPTY_COVER_LINE, loadCoverPicture, type CoverBody, type CoverSubject } from '../lib/covers'
import { EmptyCover, EmptyCoverCard } from './AuthArt'

// THE COVER (CK-84; the mockup's `cover()`, `.nthumb`, `.photo`, `.gcover`):
// one component wherever a group or a gathering appears — the menu's rows,
// the three lists' rows and the cover card at the top of a group's or a
// gathering's page.
//
// - `variant="thumb"`: the 42px thumbnail in its small ring mat, the
//   `thumbnail` layer. `variant="card"`: the page's cover card — the mat,
//   the photograph at 16/10, and `children` (the page's <h1>) over the
//   scrim, `action` (Change cover) at its top right — the `web` layer. The
//   layer follows the variant and nothing else, so no caller can ask for a
//   print master (`archival` is never served).
// - No cover (`cover` null or absent — the many bodies and fixtures that
//   carry none): the empty cover — the quail in the ring mat, or on the card
//   the quail and *No cover photo yet*. A 409 `no_cover` (cleared since the
//   body was read) draws the same.
// - A cover: the picture, `alt=""` — the name beside or over it is the text.
//   While it loads, and if it fails, the `--ck-empty` ground alone shows:
//   no quail and no words, because a cover does exist.
// - The picture comes from lib/covers.ts's cache, keyed on the subject, the
//   id, the layer and `set_at` — so a new version refetches, and the same
//   version asked again (by the menu after a navigation) fetches nothing.
//   The cache owns every object URL: this component never revokes one.
//   Nothing here ever holds a presigned URL — only the `blob:` reference.

type Shown =
  | { key: string; state: 'shown'; objectUrl: string }
  | { key: string; state: 'empty' }
  | { key: string; state: 'failed' }

export function Cover({
  subject,
  id,
  cover,
  variant,
  children,
  action,
}: {
  subject: CoverSubject
  id: string
  cover: CoverBody | null | undefined
  variant: 'thumb' | 'card'
  children?: ReactNode
  action?: ReactNode
}) {
  const layer = variant === 'card' ? 'web' : 'thumbnail'
  const setAt = cover ? cover.set_at : null
  const key = setAt === null ? null : `${subject}:${id}:${layer}:${setAt}`
  const [shown, setShown] = useState<Shown | null>(null)

  useEffect(() => {
    if (setAt === null) return
    const asked = `${subject}:${id}:${layer}:${setAt}`
    let cancelled = false
    void loadCoverPicture(subject, id, layer, setAt).then((outcome) => {
      if (cancelled) return
      if (outcome.ok) setShown({ key: asked, state: 'shown', objectUrl: outcome.objectUrl })
      else setShown({ key: asked, state: outcome.reason === 'no_cover' ? 'empty' : 'failed' })
    })
    return () => {
      cancelled = true
    }
  }, [subject, id, layer, setAt])

  // Only an answer for the version on screen counts: a new `set_at` shows the
  // ground until its own picture arrives.
  const current = shown !== null && shown.key === key ? shown : null
  const empty = key === null || current?.state === 'empty'
  const objectUrl = current?.state === 'shown' ? current.objectUrl : null
  const failed = () => {
    if (key !== null) setShown({ key, state: 'failed' })
  }

  if (variant === 'thumb') {
    if (empty) return <EmptyCover className="nthumb" />
    if (objectUrl !== null) return <img className="nthumb" src={objectUrl} alt="" onError={failed} />
    return <span className="nthumb cover-ground" aria-hidden="true" />
  }

  // The card: the heading comes first in the markup — it reads first — and
  // the scrim it sits on is drawn above the picture by CSS.
  return (
    <div className="cover-card">
      <div className="cover-photo">
        <div className="cover-over">{children}</div>
        {empty ? (
          <EmptyCoverCard line={EMPTY_COVER_LINE} />
        ) : (
          objectUrl !== null && <img src={objectUrl} alt="" onError={failed} />
        )}
      </div>
      {action}
    </div>
  )
}
