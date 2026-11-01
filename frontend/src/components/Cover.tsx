import { useEffect, useState, type ReactNode } from 'react'
import { EMPTY_COVER_LINE, loadCoverPicture, type CoverBody, type CoverSubject } from '../lib/covers'
import type { ServableLayer } from '../lib/media'
import { EmptyCover, EmptyCoverCard } from './AuthArt'

// THE COVER (CK-84; the mockup's `cover()`, `.nthumb`, `.photo`, `.gcover`,
// and since CK-85 `.card.go.hero` and `.card.go.tile`): one component
// wherever a group or a gathering appears — the menu's rows, a group page's
// list of gatherings, the cards of the Groups and Gatherings lists, and the
// cover card at the top of a group's or a gathering's page.
//
// - `variant="thumb"`: the 42px thumbnail in its small ring mat.
//   `variant="card"`: the page's cover card — the mat, the photograph at
//   16/10, and `children` (the page's <h1>) over the scrim, `action` (Change
//   cover) at its top right.
//   `variant="hero"` (CK-85): the featured card of a list — the mat, the
//   photograph at 4:3 (16:9 from 640px, 2.25:1 from 900px), and `children`
//   (the <h2> holding the card's link, its meta line and the visual Open
//   pill) over the scrim.
//   `variant="tile"` (CK-85): a card in a list's grid — the mat, the
//   photograph at 4:3, and `children` (the <h3> holding the card's link and
//   the meta lines) beneath it. The words come first in the markup, so the
//   name reads first, and the picture is drawn above them by CSS.
//   `badge` (hero and tile): the date badge over the picture's corner.
// - THE LAYER FOLLOWS THE VARIANT AND NOTHING ELSE (`LAYER`, below): the
//   thumbnail for a thumb or a tile, the web layer for a card or a hero — so
//   no caller can ask for a print master (`archival` is never served).
// - No cover (`cover` null or absent — the many bodies and fixtures that
//   carry none): the empty cover — the quail in the ring mat, or on a card,
//   a hero or a tile the quail and *No cover photo yet*. A 409 `no_cover`
//   (cleared since the body was read) draws the same.
// - A cover: the picture, `alt=""` — the name beside or over it is the text.
//   While it loads, and if it fails, the `--ck-empty` ground alone shows:
//   no quail and no words, because a cover does exist.
// - The picture comes from lib/covers.ts's cache, keyed on the subject, the
//   id, the layer and `set_at` — so a new version refetches, and the same
//   version asked again (by the menu after a navigation) fetches nothing.
//   The cache owns every object URL: this component never revokes one.
//   Nothing here ever holds a presigned URL — only the `blob:` reference.

export type CoverVariant = 'thumb' | 'card' | 'hero' | 'tile'

const LAYER: Record<CoverVariant, ServableLayer> = {
  thumb: 'thumbnail',
  tile: 'thumbnail',
  card: 'web',
  hero: 'web',
}

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
  badge,
}: {
  subject: CoverSubject
  id: string
  cover: CoverBody | null | undefined
  variant: CoverVariant
  children?: ReactNode
  action?: ReactNode
  badge?: ReactNode
}) {
  const layer = LAYER[variant]
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

  // A card's, a hero's or a tile's picture: the empty cover, the picture, or
  // — while it loads or if it cannot be shown — nothing over the ground.
  const picture = empty ? (
    <EmptyCoverCard line={EMPTY_COVER_LINE} />
  ) : (
    objectUrl !== null && <img src={objectUrl} alt="" onError={failed} />
  )

  if (variant === 'hero') {
    // The words come first in the markup — they read first — and the scrim
    // they sit on is drawn above the picture by CSS (the card's order).
    return (
      <article className="cover-go cover-hero">
        <div className="cover-frame">
          <div className="cover-over">{children}</div>
          {picture}
          {badge}
        </div>
      </article>
    )
  }

  if (variant === 'tile') {
    return (
      <article className="cover-go cover-tile">
        <div className="cover-tile-body">{children}</div>
        <div className="cover-frame">
          {picture}
          {badge}
        </div>
      </article>
    )
  }

  // The card: the heading comes first in the markup — it reads first — and
  // the scrim it sits on is drawn above the picture by CSS.
  return (
    <div className="cover-card">
      <div className="cover-photo">
        <div className="cover-over">{children}</div>
        {picture}
      </div>
      {action}
    </div>
  )
}
