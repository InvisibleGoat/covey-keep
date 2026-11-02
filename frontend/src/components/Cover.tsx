import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { EMPTY_COVER_LINE, loadCoverPicture, type CoverBody, type CoverSubject } from '../lib/covers'
import { badgeParts } from '../lib/datetime'
import type { LinePiece } from '../lib/gatherings'
import type { ServableLayer } from '../lib/media'
import { EmptyCover, EmptyCoverCard } from './AuthArt'

// THE COVER (CK-84; the mockup's `cover()`, `.nthumb`, `.photo`, `.gcover`,
// and since CK-85 `.card.go.hero` and `.card.go.tile`): one component
// wherever a group or a gathering appears — the menu's rows, the cards of the
// Groups and Gatherings lists and of a group page's strip of gatherings, and
// the cover card at the top of a group's or a gathering's page.
//
// - `variant="thumb"`: the 42px thumbnail in its small ring mat.
//   `variant="wide"` (CK-86): a page's cover card at the mockup's measure
//   (`.card.gcover`) — the mat, the page column's width, the photograph
//   16:10 on a phone and 3:1 from 640px, `children` (the page's <h1> and its
//   meta line) over the scrim at the title's and the scrim's fluid sizes,
//   and `action` (Change cover) at the picture's top right; a group's page since
//   CK-86, a gathering's since CK-87. The photograph's height is its LEAST
//   height: a name that wraps grows the picture rather than running off its
//   top. (Until CK-87 a `card` variant drew the same card at the width the
//   old centred column gave its cards; a gathering's page was its last user,
//   and it went with its styles and its `LAYER` row.)
//   `variant="hero"` (CK-85): the featured card of a list — the mat, the
//   photograph at 4:3 (16:9 from 640px, 2.25:1 from 900px), and `children`
//   (the <h2> holding the card's link, its meta line and the visual Open
//   pill) over the scrim.
//   `variant="tile"` (CK-85): a card in a list's grid — the mat, the
//   photograph at 4:3, and `children` (the <h3> holding the card's link and
//   the meta lines) beneath it. The words come first in the markup, so the
//   name reads first, and the picture is drawn above them by CSS.
//   `badge` (hero, tile, and since CK-87 the wide card): the date badge over
//   the picture's corner — `DateBadge`, below. On a wide card with no cover
//   it leads the empty cover's row instead (CK-87.1), in the same corner.
// - THE LAYER FOLLOWS THE VARIANT AND NOTHING ELSE (`LAYER`, below): the
//   thumbnail for a thumb or a tile, the web layer for a wide card or a hero
//   — so no caller can ask for a print master (`archival` is never served).
// - No cover (`cover` null or absent — the many bodies and fixtures that
//   carry none): the empty cover — the quail in the ring mat, or on a wide
//   card, a hero or a tile the quail and *No cover photo yet*. A 409
//   `no_cover` (cleared since the body was read) draws the same.
// - A cover: the picture, `alt=""` — the name beside or over it is the text.
//   While it loads, and if it fails, the `--ck-empty` ground alone shows:
//   no quail and no words, because a cover does exist.
// - The picture comes from lib/covers.ts's cache, keyed on the subject, the
//   id, the layer and `set_at` — so a new version refetches, and the same
//   version asked again (by the menu after a navigation) fetches nothing.
//   The cache owns every object URL: this component never revokes one.
//   Nothing here ever holds a presigned URL — only the `blob:` reference.

export type CoverVariant = 'thumb' | 'wide' | 'hero' | 'tile'

const LAYER: Record<CoverVariant, ServableLayer> = {
  thumb: 'thumbnail',
  tile: 'thumbnail',
  wide: 'web',
  hero: 'web',
}

// The date badge (the mockup's `dateBadge()`; CK-85, beside the cover since
// CK-86, when a group page's strip took it too): the month and the day of a
// coming-up gathering's next date in the profile's zone, frosted, on its
// card's corner. Decorative — the card's date line says the same in words.
export function DateBadge({ startsAt, zone }: { startsAt: string; zone: string }) {
  const { month, day } = badgeParts(startsAt, zone)
  return (
    <span className="cover-date" aria-hidden="true">
      <span className="cover-date-m">{month}</span>
      <span className="cover-date-d">{day}</span>
    </span>
  )
}

// A card's line from its pieces (CK-87; lib/gatherings.ts's `LinePiece`):
// each date and each time in an element that does not wrap, so a narrow card
// never breaks inside one, and the separators between them free to break.
// The text is the pieces as they are — nothing replaced — so the line reads
// exactly as its string does.
export function CardLine({ pieces }: { pieces: LinePiece[] }) {
  return (
    <>
      {pieces.map((piece, index) =>
        piece.keep ? (
          <span key={index} className="nowrap">
            {piece.text}
          </span>
        ) : (
          <Fragment key={index}>{piece.text}</Fragment>
        ),
      )}
    </>
  )
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

  // A wide card's, a hero's or a tile's picture: the empty cover, the picture, or
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

  // The wide card: the heading comes first in the markup — it reads first —
  // and the picture is drawn beneath the words by CSS, the badge at its
  // corner. THE EMPTY COVER IS A ROW OF ITS OWN (CK-87.1): the badge and the
  // empty cover share `.cover-lead`, which CSS lays in the flow above the
  // words, beside Change cover — so each takes the room it needs, the line
  // drops beneath the badge and the quail when the row is crowded, and the
  // words start below whatever height the row takes. Change cover sits in the
  // picture, last, in both states: the same element whether a cover is set or
  // not, so setting or clearing one never remounts the button under the
  // person's focus. (Until CK-87.1 it followed the picture in the card, and
  // the empty cover's row was laid over the picture with fixed insets.)
  return (
    <div className="cover-card cover-card-wide">
      <div className="cover-photo">
        <div className="cover-over">{children}</div>
        {empty ? (
          <div className="cover-lead">
            {badge}
            {picture}
          </div>
        ) : (
          picture
        )}
        {empty ? null : badge}
        {action}
      </div>
    </div>
  )
}
