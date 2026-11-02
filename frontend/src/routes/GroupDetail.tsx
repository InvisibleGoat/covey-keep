// /groups/:id — a group's page, in the mockup's shape since CK-86 (the
// mockup's screen 03, `groupPage()`; decisions/2026-10-31-the-design-and-
// how-it-is-merged.md §1.3 and §3 item 6; Steven's answers of 2026-11-01).
// Its people — Members, Requests to join, Invite people, rename and Leave —
// moved to the People page (routes/GroupPeople.tsx), unchanged in behaviour,
// and this page keeps the mockup's shape, top to bottom:
//
// - THE COVER CARD AT THE MOCKUP'S MEASURE (`.card.gcover`; the cover's
//   `wide` variant, through components/PageCover.tsx): the group's cover, or
//   the empty cover, the page column's width, the picture 16:10 on a phone
//   and 3:1 from 640px, and over its scrim the group's name — the page's
//   <h1> — and the meta line, *{N} people* (`memberCountLabel`). The admin
//   and co-admins get Change cover at the card's top right, with its panel:
//   Upload a picture, and Remove cover behind its second step — the card's
//   own step now, the only one on this page. A cover from a photograph is
//   chosen in a group gathering's opened photo (Use as the group's cover),
//   and nothing here ever names that photograph or its gathering — no group
//   body does.
// - THE ACTIONS (`.gactions`), for every member: **New gathering**, the
//   primary pill with the plus, to `/groups/<id>/gatherings/new` (any member
//   of a household group may start one, CK-76), and **People**, the quiet
//   pill with the groups icon, to `/groups/<id>/people`. Both are links.
//   Add photos is left out: posting to a group is not in this arc (Steven,
//   answer 3), so New gathering is the primary.
// - THE GATHERINGS STRIP (`.gstrip`, labelled *Gatherings*): `GET
//   /groups/{id}/gatherings` on its own key, failing in its own place with
//   Try again. The order is Your gatherings' sections, through the ONE rule
//   (`gatheringSections`, `isComingUp`): coming up soonest first, then past
//   most recent first, then the photos-only items in the server's order.
//   Each card is the cover's `tile` (the thumbnail layer), 168px wide,
//   scrolling sideways: its title (an <h3> holding the card's link) and ONE
//   line, `cardDateLine`'s — the line a card's date reads everywhere, each
//   date and time in it kept whole (CK-87, `cardDatePieces`) — with no
//   group line, since every card is this group's; the date badge on a
//   coming-up card alone; a photos-only card says *You can see its photos*
//   and carries no date and no badge, and nothing here reads its
//   `next_occurrence` (the CK-80 Gotcha). A gathering the caller is kept a
//   surprise from is not in the answer at all. *Times in {zone}.* while a
//   date is on screen. The strip shows at every width: the mockup hides it
//   from 900px because its menu's details panel lists the group's gatherings
//   there, and this app's menu has no details panel (Steven, 2026-10-31).
//
// Not here, because none is built (the merge record §4): the chat preview,
// *Kept by*, the pin, member faces, *Active … ago*, Add photos and the
// photos in sections (CK-88 builds the grid for this page and a gathering's).
//
// THE READS: the group body and its gatherings — never the member list, which
// is the People page's. A 404 on the group is the one not-found screen,
// byte-identical for a missing id, a group the caller is not in and a path
// 422; a failed read offers Try again. Both screens are the page's own from
// before CK-86, word for word.
//
// WHO THE CALLER IS COMES FROM THE BODY: `groupRoleFlags(caller_role)` —
// `organises` (the admin or a co-admin) is Change cover's flag, and nothing
// here compares person ids.
import { useEffect, useId, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { CardLine, Cover, DateBadge } from '../components/Cover'
import { Icon } from '../components/Icons'
import { PageCover } from '../components/PageCover'
import { COVER_HINT_GROUP, REMOVE_PHOTO_SENTENCE_GROUP } from '../lib/covers'
import { effectiveZone } from '../lib/datetime'
import { cardDatePieces, gatheringSections, viewOf, type GatheringListItem } from '../lib/gatherings'
import {
  groupRoleFlags,
  memberCountLabel,
  readGroup,
  readGroupGatherings,
  type Group,
  type GroupRead,
} from '../lib/groups'

type Load<T> = { status: 'loading' } | GroupRead<T>

// The strip's own read: it fails in its own place, with its own Try again,
// and never takes the page with it. `readAt` is the moment the list arrived:
// the one `now` the order and every card's line are read against, so a card's
// line always agrees with where it sits (CK-85's practice).
type StripLoad =
  | { status: 'loading' }
  | { status: 'loaded'; items: GatheringListItem[]; readAt: number }
  | { status: 'failed' }

export function GroupDetail() {
  const { id } = useParams()
  const groupId = id ?? ''
  // Dates — the badge, each card's line — read in the profile zone (the
  // CK-17 rule).
  const { person } = useAuth()
  const zone = effectiveZone(person?.timezone)
  const stripLabel = useId()

  const [groupLoad, setGroupLoad] = useState<Load<Group>>({ status: 'loading' })
  // Each read re-runs when its key moves; a loaded value stays on screen
  // until the new answer replaces it.
  const [groupKey, setGroupKey] = useState(0)
  const [stripLoad, setStripLoad] = useState<StripLoad>({ status: 'loading' })
  const [stripKey, setStripKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const result = await readGroup(groupId)
      if (!cancelled) setGroupLoad(result)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [groupId, groupKey])

  // The group's gatherings: any member may read them, so they are read on
  // mount (CK-80).
  useEffect(() => {
    let cancelled = false
    async function load() {
      const outcome = await readGroupGatherings(groupId)
      if (cancelled) return
      setStripLoad(
        outcome.ok ? { status: 'loaded', items: outcome.gatherings, readAt: Date.now() } : { status: 'failed' },
      )
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [groupId, stripKey])

  function tryAgain() {
    setGroupLoad({ status: 'loading' })
    setGroupKey((key) => key + 1)
  }

  if (groupLoad.status === 'notFound') {
    // One screen, no speculation: it must not hint whether a group exists
    // behind this address, or that the caller was ever in it.
    return (
      <main className="auth-screen">
        <h1>Nothing here</h1>
        <p>There's no group to show at this address.</p>
        <Link to="/groups">Back to your groups</Link>
      </main>
    )
  }

  if (groupLoad.status === 'failed') {
    return (
      <main className="auth-screen">
        <h1>Something went wrong</h1>
        <p className="form-error" role="alert">
          Something went wrong loading this group.
        </p>
        <button type="button" onClick={tryAgain}>
          Try again
        </button>
        <Link to="/groups">Back to your groups</Link>
      </main>
    )
  }

  if (groupLoad.status === 'loading') {
    return (
      <main className="auth-screen">
        <p>Loading…</p>
      </main>
    )
  }

  const group = groupLoad.value
  const { organises } = groupRoleFlags(group.caller_role)

  // The strip's cards in the one rule's order. A photos-only item carries no
  // date to sort by, and nothing may claim it is over: it goes last, in the
  // server's order.
  const strip =
    stripLoad.status === 'loaded'
      ? (() => {
          const { comingUp, past, photosOnly } = gatheringSections(stripLoad.items, stripLoad.readAt)
          return {
            readAt: stripLoad.readAt,
            cards: [
              ...comingUp.map((item) => ({ item, upcoming: true })),
              ...past.map((item) => ({ item, upcoming: false })),
              ...photosOnly.map((item) => ({ item, upcoming: false })),
            ],
          }
        })()
      : null
  // The hint names the zone only while a date is on screen: the photos-only
  // view carries none (CK-80).
  const anyDate =
    strip !== null &&
    strip.cards.some(({ item }) => viewOf(item.caller_view).full && item.next_occurrence !== null)

  return (
    <main className="auth-screen page-column">
      <PageCover
        subject="group"
        id={group.id}
        cover={group.cover}
        organises={organises}
        hint={COVER_HINT_GROUP}
        photoRemovalSentence={REMOVE_PHOTO_SENTENCE_GROUP}
        onChanged={() => setGroupKey((key) => key + 1)}
      >
        <h1>{group.name}</h1>
        <p className="cover-card-meta">{memberCountLabel(group.member_count)}</p>
      </PageCover>

      <div className="group-actions">
        <Link className="btn btn-primary" to={`/groups/${group.id}/gatherings/new`}>
          <Icon name="plus" />
          New gathering
        </Link>
        <Link className="btn" to={`/groups/${group.id}/people`}>
          <Icon name="groups" />
          People
        </Link>
      </div>

      <section className="group-strip" aria-labelledby={stripLabel}>
        <h2 className="strip-label" id={stripLabel}>
          Gatherings
        </h2>
        {anyDate && <p className="field-hint">Times in {zone}.</p>}
        {stripLoad.status === 'loading' && <p>Loading…</p>}
        {stripLoad.status === 'failed' && (
          <div className="list-state">
            <p className="form-error" role="alert">
              <span aria-hidden="true">⚠ </span>
              The group's gatherings couldn't be loaded just now.
            </p>
            <button
              type="button"
              onClick={() => {
                setStripLoad({ status: 'loading' })
                setStripKey((key) => key + 1)
              }}
            >
              Try again
            </button>
          </div>
        )}
        {strip !== null && strip.cards.length === 0 && <p>No gatherings in this group yet.</p>}
        {strip !== null && strip.cards.length > 0 && (
          <ul className="cover-strip" aria-label="The group's gatherings">
            {strip.cards.map(({ item, upcoming }) => {
              const line = cardDatePieces(item, zone, strip.readAt)
              return (
                <li key={item.id}>
                  <Cover
                    subject="gathering"
                    id={item.id}
                    cover={item.cover}
                    variant="tile"
                    badge={
                      upcoming && item.next_occurrence ? (
                        <DateBadge startsAt={item.next_occurrence.starts_at} zone={zone} />
                      ) : undefined
                    }
                  >
                    <h3>
                      <Link className="cover-link" to={`/gatherings/${item.id}`}>
                        {item.title}
                      </Link>
                    </h3>
                    {line !== null && (
                      <p className="cover-meta">
                        <CardLine pieces={line} />
                      </p>
                    )}
                  </Cover>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </main>
  )
}
