import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { formatDayWithYear } from '../lib/datetime'
import { sectionCountPieces, viewOf, type GatheringListItem } from '../lib/gatherings'
import { readGroupMedia, type GroupGatheringsLoad, type GroupMediaSection } from '../lib/groups'
import { mediaStateMessage, readPublishedPhotos, whoFor, type MediaItem } from '../lib/media'
import { Quail } from './AuthArt'
import { CardLine, Cover } from './Cover'
import { LazyThumbnail, PhotoViewer } from './PhotoViewer'
import { PREVIEW_PHONE, PREVIEW_WIDE_COUNT, usePreviewWide } from './usePreviewWide'
import { useViewerEntry } from './useViewerEntry'

// A GROUP'S PHOTOS IN SECTIONS, on its page after the strip (CK-88.1b; the
// mockup's .photos-head, .psec, .pbanner, .plainhead, .pgrid, .seeall and
// .nophotos; the merge record §3 item 8; Steven's six answers of 2026-11-03).
//
// - THE READS: `GET /groups/{id}/media` on its own key, here; the strip's list
//   of the group's gatherings, its moment and its failure handed down by the
//   page, so one read serves both. No gathering's list is read on load, and
//   never the member list. The page shows its loading screen until a new group's
//   body has landed, so this component is gone between two groups, and it hands
//   down a list that reads as loading until the new group's has landed: one
//   group's sections never meet another's gatherings.
// - THE SECTIONS, in the server's order (the newest photo first) and never
//   re-sorted, each joined to its gathering by `gathering_id`: a section not in
//   the list is not drawn and not counted. The head's count is the sum of
//   `published_count` over the sections drawn — the photos the caller can see,
//   never the keeper's charge.
// - A SECTION'S HEAD: a cover set is the cover's `banner` (Cover.tsx), its words
//   over the picture and its link over the whole of it; no cover is the plain
//   head, the name and its count line, and the link the name alone. A section
//   never draws the empty cover: it is a row of photos, and already has them.
// - THE PREVIEW: the first 6 of the section's newest eight on a phone, all 8 from
//   640px, a tile not rendered minting nothing and a rendered one minting as it
//   nears the viewport. See all ends every section, every photo already showing
//   or not — to the gathering's own Photos at `#photos`, which GatheringMedia
//   reads once as it mounts (its point 14).
// - THE VIEWER IS FOR VIEWING ONLY (Steven's answer 3): a press opens
//   PhotoViewer at once on the section's eight — all eight, even where a phone
//   shows six — with no `acts` for anyone and nothing read about the group's
//   seat; the acts stay on the gathering's page. Each opening reads that
//   gathering's whole list once, and its published photos replace the set, the
//   photo kept by id. Until then the total it names is `published_count`; if the
//   read fails it stays on the eight, with no new words, and the next opening
//   reads again. An answer for an opening that has closed is ignored. A photo
//   gone from the list closes the viewer, focus to the heading, and the sections
//   are read again once. One history entry (useViewerEntry.ts), as on a
//   gathering's page.

const EMPTY_LINE = 'No photos yet. Photos added to its gatherings show up here.'

type MediaLoad =
  | { status: 'loading' }
  | { status: 'loaded'; sections: GroupMediaSection[] }
  | { status: 'failed' }

// What the viewer is showing. `total` is what it names until the gathering's
// list has landed; after that the set's own length is the truth.
interface ViewerState {
  title: string
  photosOnly: boolean
  mediaId: string
  photos: MediaItem[]
  total: number | undefined
  opener: HTMLElement | null
}

// Where focus goes once the viewer has closed and the page is no longer inert.
type PendingFocus = { kind: 'opener'; element: HTMLElement | null } | { kind: 'heading' }

function PhotoSection({
  item,
  section,
  previewLimit,
  zone,
  readAt,
  onOpen,
}: {
  item: GatheringListItem
  section: GroupMediaSection
  previewLimit: number
  zone: string
  readAt: number
  onOpen: (item: GatheringListItem, section: GroupMediaSection, mediaId: string, opener: HTMLElement) => void
}) {
  const headingId = useId()
  const to = `/gatherings/${item.id}`
  const total = section.published_count
  const pieces = sectionCountPieces(item, total, zone, readAt)
  const name = (
    <h3 id={headingId}>
      <Link to={to}>{item.title}</Link>
    </h3>
  )

  return (
    <section className="auth-card psec" aria-labelledby={headingId}>
      {item.cover ? (
        <Cover subject="gathering" id={item.id} cover={item.cover} variant="banner">
          {name}
          <span className="rule" aria-hidden="true" />
          <span className="count">
            <CardLine pieces={pieces} />
          </span>
        </Cover>
      ) : (
        <div className="plainhead">
          {name}
          <p className="meta">
            <CardLine pieces={pieces} />
          </p>
        </div>
      )}
      <ul className="pgrid">
        {section.media.slice(0, previewLimit).map((photo, position) => (
          <li key={photo.id}>
            <button
              type="button"
              className="ph"
              aria-label={`Photo ${position + 1} of ${total} in ${item.title}`}
              onClick={(event) => onOpen(item, section, photo.id, event.currentTarget)}
            >
              <LazyThumbnail mediaId={photo.id} />
            </button>
          </li>
        ))}
      </ul>
      <div className="seeall">
        <Link className="btn btn-small" to={`${to}#photos`}>
          See all {total} {total === 1 ? 'photo' : 'photos'}
        </Link>
      </div>
    </section>
  )
}

export function GroupPhotos({
  groupId,
  gatherings,
  onRetryGatherings,
  zone,
}: {
  groupId: string
  gatherings: GroupGatheringsLoad
  onRetryGatherings: () => void
  zone: string
}) {
  const headingId = useId()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const previewWide = usePreviewWide()
  const [mediaLoad, setMediaLoad] = useState<MediaLoad>({ status: 'loading' })
  // The read re-runs when its key moves; a loaded value stays on screen until
  // the new answer replaces it.
  const [mediaKey, setMediaKey] = useState(0)
  const [viewer, setViewer] = useState<ViewerState | null>(null)
  const [pendingFocus, setPendingFocus] = useState<PendingFocus | null>(null)
  // Which opening a list answer belongs to: moved by every open and every
  // close, so an answer for one that has gone is ignored.
  const opening = useRef(0)

  useEffect(() => {
    let cancelled = false
    void readGroupMedia(groupId).then((outcome) => {
      if (cancelled) return
      setMediaLoad(outcome.ok ? { status: 'loaded', sections: outcome.sections } : { status: 'failed' })
    })
    return () => {
      cancelled = true
    }
  }, [groupId, mediaKey])

  useEffect(
    () => () => {
      opening.current += 1
    },
    [],
  )

  function open(item: GatheringListItem, section: GroupMediaSection, mediaId: string, opener: HTMLElement) {
    if (viewer !== null) return
    opening.current += 1
    const asked = opening.current
    setPendingFocus(null)
    setViewer({
      title: item.title,
      photosOnly: viewOf(item.caller_view).photosOnly,
      mediaId,
      photos: section.media,
      total: section.published_count,
      opener,
    })
    viewerEntry.push()
    void readPublishedPhotos(item.id).then((outcome) => {
      if (asked !== opening.current || !outcome.ok) return
      setViewer((shown) => shown && { ...shown, photos: outcome.photos, total: undefined })
    })
  }

  function close(focus: PendingFocus | null = null, popHistory = true) {
    if (viewer === null) return
    opening.current += 1
    if (popHistory) viewerEntry.pop()
    setViewer(null)
    setPendingFocus(focus ?? { kind: 'opener', element: viewer.opener })
  }

  // The effects below close the viewer through the latest render's close,
  // which reads the state it closes.
  const latestClose = useRef(close)
  useLayoutEffect(() => {
    latestClose.current = close
  })

  // Back: the entry the viewer pushed is left, so it closes and pops nothing.
  const viewerEntry = useViewerEntry(() => latestClose.current(null, false))

  // The list took the photo on screen out of the set (it was removed after the
  // sections were read): the viewer closes, and the sections are read again.
  const viewerLost = viewer !== null && !viewer.photos.some((photo) => photo.id === viewer.mediaId)
  useEffect(() => {
    if (!viewerLost) return
    latestClose.current({ kind: 'heading' })
    setMediaKey((key) => key + 1)
  }, [viewerLost])

  // Focus, once the viewer has closed and the page is no longer inert.
  useEffect(() => {
    if (pendingFocus === null || viewer !== null) return
    const element = pendingFocus.kind === 'opener' ? pendingFocus.element : null
    const target = element !== null && element.isConnected ? element : headingRef.current
    target?.focus({ preventScroll: true })
    setPendingFocus(null)
  }, [pendingFocus, viewer])

  // Try again re-reads whichever failed, one request each per press.
  function tryAgain() {
    if (mediaLoad.status === 'failed') {
      setMediaLoad({ status: 'loading' })
      setMediaKey((key) => key + 1)
    }
    if (gatherings.status === 'failed') onRetryGatherings()
  }

  const failed = mediaLoad.status === 'failed' || gatherings.status === 'failed'
  const loaded = mediaLoad.status === 'loaded' && gatherings.status === 'loaded'

  // The join: a section whose gathering is not in the list is left out.
  const drawn = (() => {
    if (mediaLoad.status !== 'loaded' || gatherings.status !== 'loaded') return []
    const byId = new Map(gatherings.items.map((item) => [item.id, item]))
    return mediaLoad.sections.flatMap((section) => {
      const item = byId.get(section.gathering_id)
      return item === undefined ? [] : [{ item, section }]
    })
  })()
  const total = drawn.reduce((sum, { section }) => sum + section.published_count, 0)
  const line = failed || total === 0 ? '' : total === 1 ? '1 photo · newest first' : `${total} photos · newest first`

  return (
    <section className="group-photos" aria-labelledby={headingId}>
      <div className="photos-head">
        <h2 id={headingId} ref={headingRef} tabIndex={-1}>
          Photos
        </h2>
        {line !== '' && <span className="meta">{line}</span>}
      </div>

      {failed && (
        <div className="list-state">
          <p className="form-error" role="alert">
            <span aria-hidden="true">⚠ </span>
            Some photos couldn't be loaded just now.
          </p>
          <button type="button" onClick={tryAgain}>
            Try again
          </button>
        </div>
      )}
      {!failed && !loaded && <p>Loading…</p>}
      {!failed && loaded && drawn.length === 0 && (
        <div className="auth-card nophotos">
          <Quail />
          <p>{EMPTY_LINE}</p>
        </div>
      )}
      {!failed &&
        gatherings.status === 'loaded' &&
        drawn.map(({ item, section }) => (
          <PhotoSection
            key={section.gathering_id}
            item={item}
            section={section}
            previewLimit={previewWide ? PREVIEW_WIDE_COUNT : PREVIEW_PHONE}
            zone={zone}
            readAt={gatherings.readAt}
            onOpen={open}
          />
        ))}

      {viewer !== null && !viewerLost && (
        <PhotoViewer
          photos={viewer.photos}
          current={viewer.mediaId}
          total={viewer.total}
          onMove={(mediaId) => setViewer((shown) => shown && { ...shown, mediaId })}
          single={false}
          setLabel={viewer.title}
          addedLine={(photo) =>
            // The date where the dates are not withheld (the photos-only view
            // gives none), in the profile's zone, with its year.
            viewer.photosOnly
              ? `Added by ${whoFor(photo)}`
              : `Added by ${whoFor(photo)} · ${formatDayWithYear(photo.created_at, zone)}`
          }
          stateLine={(photo) => mediaStateMessage(photo, { isHost: false, organises: false })}
          onClose={() => close()}
        />
      )}
    </section>
  )
}
