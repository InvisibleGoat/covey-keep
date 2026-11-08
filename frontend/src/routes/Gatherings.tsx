// /gatherings — your gatherings (CK-17; one request since CK-20; the mockup's
// layout since CK-85).
//
// The page (CK-85; the mockup's screen 05, `cardsView()`): the mockup's page
// column (`.page-column`; `.list-screen` until CK-86), the page head — *Your
// gatherings*, *Times in {zone}.* while any date is on screen, and **New
// gathering** — then, from
// the one list read, in the profile's zone, the three sections of
// `lib/gatherings.ts::gatheringSections`:
// - **Coming up**: the full-view items whose next date is still ahead, by
//   `isComingUp` — the rule the menu's *Gatherings coming up* reads too —
//   soonest first. THE FEATURED CARD is the first, as the cover's `hero`
//   variant (the web layer), and the rest are `tile`s under *Coming up*.
// - **Past**: the full-view items whose date has passed — a date in progress
//   included, by the same rule — most recent first: four, then **Show all
//   {N} past gatherings**, which shows the rest in place and goes away, and
//   stays away on a return to this page; a new visit starts folded (CK-88.2).
// - **Photos you can see** (Steven, 2026-11-01): every photos-only item, in
//   the server's order, after Past. Each says *You can see its photos* and
//   carries no date and no badge: the server withholds them, and nothing
//   here reads `next_occurrence` for such an item (the CK-80 Gotcha).
// An empty section leaves its heading out. Every card is one link to its
// gathering's page; a coming-up card carries the date badge. Nothing the list
// body does not carry — no photo count, no span of days, no answer.
//
// THE SWITCH (CK-91; the mockup's `.toolbar` and `.switch`): beneath the page
// head, a group named *Show gatherings as* — **Cards** and **Calendar**, each a
// button with `aria-pressed` — stored on the device by lib/gatheringsView.ts
// alone, Cards by default. **Cards** is the page above, unchanged: its read,
// its states and its words (the switch stands beneath the head of its failed,
// empty and loaded states). **Calendar** is the calendar
// (components/CalendarView.tsx) in place of the cards, under *Your gatherings*
// and *Times in {zone}.*, reading the calendar route alone — never `GET
// /gatherings` — its day in `?day=`, which the Cards view never reads.
// Switching keeps focus on the button pressed, put back on it once the other
// view's switch has mounted.
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { CalendarView } from '../components/CalendarView'
import { CardLine, Cover, DateBadge } from '../components/Cover'
import { Icon } from '../components/Icons'
import { usePagePlace } from '../components/pagePlace'
import { authFetch } from '../lib/api'
import { CALENDAR, CARDS, useCalendarDay, VIEW_SWITCH_LABEL } from '../lib/calendar'
import { effectiveZone } from '../lib/datetime'
import {
  cardDatePieces,
  cardPlaceLine,
  featuredPieces,
  gatheringSections,
  viewOf,
  type GatheringListItem,
} from '../lib/gatherings'
import { chooseGatheringsView, useGatheringsView, type GatheringsView } from '../lib/gatheringsView'

type LoadStatus = 'loading' | 'loaded' | 'failed'

// How many past gatherings show before Show all (the mockup's four). The
// date badge is components/Cover.tsx's `DateBadge` since CK-86, when a group
// page's strip took it too.
const PAST_SHOWN = 4

export function Gatherings() {
  const { person } = useAuth()
  const zone = effectiveZone(person?.timezone)
  const view = useGatheringsView()
  // The button just pressed, owed focus once the other view's switch mounts:
  // the press unmounts the view it was pressed in, so its button goes with it.
  const owed = useRef<GatheringsView | null>(null)
  const toolbar = (
    <ViewSwitch
      view={view}
      owed={owed}
      onChoose={(next) => {
        if (next === view) return
        owed.current = next
        chooseGatheringsView(next)
      }}
    />
  )
  return view === 'calendar' ? <CalendarGatherings zone={zone} toolbar={toolbar} /> : <CardsView zone={zone} toolbar={toolbar} />
}

function ViewSwitch({
  view,
  owed,
  onChoose,
}: {
  view: GatheringsView
  owed: RefObject<GatheringsView | null>
  onChoose: (view: GatheringsView) => void
}) {
  const cards = useRef<HTMLButtonElement>(null)
  const calendar = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    const target = owed.current
    if (target === null) return
    owed.current = null
    // Only where focus went with the pressed button: never taken from
    // anywhere the person has since put it.
    const active = document.activeElement
    if (active === null || active === document.body) (target === 'cards' ? cards : calendar).current?.focus()
  }, [owed])
  return (
    <div className="toolbar">
      <div className="switch" role="group" aria-label={VIEW_SWITCH_LABEL}>
        <button type="button" ref={cards} aria-pressed={view === 'cards'} onClick={() => onChoose('cards')}>
          <Icon name="cards" />
          {CARDS}
        </button>
        <button type="button" ref={calendar} aria-pressed={view === 'calendar'} onClick={() => onChoose('calendar')}>
          <Icon name="calendar" />
          {CALENDAR}
        </button>
      </div>
    </div>
  )
}

// The Calendar view: the page head with the zone always named (a calendar
// always shows dates), the switch, then the calendar of every gathering the
// person is invited to — the calendar route's reads alone.
function CalendarGatherings({ zone, toolbar }: { zone: string; toolbar: ReactNode }) {
  const [day, onDay] = useCalendarDay()
  return (
    <main className="auth-screen page-column">
      <div className="page-head">
        <div>
          <h1>Your gatherings</h1>
          <p className="lede">Times in {zone}.</p>
        </div>
        <Link className="btn btn-primary" to="/gatherings/new">
          <Icon name="plus" />
          New gathering
        </Link>
      </div>
      {toolbar}
      <CalendarView zone={zone} groupId={null} day={day} fallbackDay={null} onDay={onDay} />
    </main>
  )
}

// The Cards view: the page as it was before CK-91, the switch beneath its head.
function CardsView({ zone, toolbar }: { zone: string; toolbar: ReactNode }) {
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [gatherings, setGatherings] = useState<GatheringListItem[]>([])
  // The moment the list arrived: the one `now` the sections and every card's
  // line are read against, so a card's line always agrees with its section.
  const [readAt, setReadAt] = useState(0)
  // Bumped by Try again: the ordinary read over again, through the loading
  // state (the CK-74.1 idiom).
  const [reloadKey, setReloadKey] = useState(0)
  // Show all stays open on a return and folds on a new visit (CK-88.2; Steven).
  const { shownAll, rememberShownAll } = usePagePlace()
  const [allPast, setAllPast] = useState(shownAll)
  // Show all moves focus to the first card it reveals, so a keyboard is not
  // left on a button that has gone.
  const revealed = useRef<HTMLUListElement>(null)
  const [justRevealed, setJustRevealed] = useState(false)
  const comingUpHeading = useId()
  const pastHeading = useId()
  const photosHeading = useId()

  useEffect(() => {
    let cancelled = false
    async function load() {
      // ONE request: since CK-20 each list item carries next_occurrence (the
      // backend's next-or-most-recent rule) — the CK-17 per-gathering detail
      // fetches and their per-row degrade are gone with the N+1 they existed
      // to work around.
      try {
        const response = await authFetch('/gatherings')
        if (!response.ok) {
          if (!cancelled) setStatus('failed')
          return
        }
        const body = (await response.json()) as { gatherings: GatheringListItem[] }
        if (cancelled) return
        setGatherings(body.gatherings)
        setReadAt(Date.now())
        setStatus('loaded')
      } catch {
        if (!cancelled) setStatus('failed')
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  useEffect(() => {
    if (!justRevealed) return
    setJustRevealed(false)
    revealed.current?.querySelectorAll<HTMLAnchorElement>('a.cover-link')[PAST_SHOWN]?.focus()
  }, [justRevealed])

  if (status === 'loading') {
    return (
      <main className="auth-screen page-column">
        <p>Loading your gatherings…</p>
      </main>
    )
  }

  if (status === 'failed') {
    // A retry is a control, never a sentence with nothing to press (CK-80;
    // CK-74.1's idiom): Try again re-reads through the loading state.
    return (
      <main className="auth-screen page-column">
        <div className="page-head">
          <div>
            <h1>Your gatherings</h1>
          </div>
        </div>
        {toolbar}
        <div className="list-state">
          <p className="form-error" role="alert">
            Something went wrong loading your gatherings.
          </p>
          <button
            type="button"
            onClick={() => {
              setStatus('loading')
              setReloadKey((key) => key + 1)
            }}
          >
            Try again
          </button>
        </div>
      </main>
    )
  }

  // The empty state is a real screen — it is what every new account sees.
  // It says what the list holds — what you host, co-host, are invited to or
  // can see the photos of — and never "keep": since CK-77 keeping lets no
  // one in, so a gathering you keep and are none of those is not here.
  if (gatherings.length === 0) {
    return (
      <main className="auth-screen page-column">
        <div className="page-head">
          <div>
            <h1>No gatherings yet</h1>
            <p className="lede">Gatherings you start or are invited to will be listed here.</p>
          </div>
          <Link className="btn btn-primary" to="/gatherings/new">
            Create your first gathering
          </Link>
        </div>
        {toolbar}
      </main>
    )
  }

  // The hint names the zone only when a date is on screen: the photos-only
  // view carries none (CK-80).
  const anyDate = gatherings.some(
    (gathering) => viewOf(gathering.caller_view).full && gathering.next_occurrence !== null,
  )
  const { comingUp, past, photosOnly } = gatheringSections(gatherings, readAt)
  const [featured, ...moreComingUp] = comingUp
  const pastShown = allPast ? past : past.slice(0, PAST_SHOWN)

  function tile(gathering: GatheringListItem, upcoming: boolean) {
    // Each date and time kept whole on the card (CK-87's rider): the line's
    // pieces, its text the same as `cardDateLine`'s.
    const dateLine = cardDatePieces(gathering, zone, readAt)
    return (
      <li key={gathering.id}>
        <Cover
          subject="gathering"
          id={gathering.id}
          cover={gathering.cover}
          variant="tile"
          badge={
            upcoming && gathering.next_occurrence ? (
              <DateBadge startsAt={gathering.next_occurrence.starts_at} zone={zone} />
            ) : undefined
          }
        >
          <h3>
            <Link className="cover-link" to={`/gatherings/${gathering.id}`}>
              {gathering.title}
            </Link>
          </h3>
          <p className="cover-meta">{cardPlaceLine(gathering)}</p>
          {dateLine !== null && (
            <p className="cover-meta">
              <CardLine pieces={dateLine} />
            </p>
          )}
        </Cover>
      </li>
    )
  }

  return (
    <main className="auth-screen page-column">
      <div className="page-head">
        <div>
          <h1>Your gatherings</h1>
          {anyDate && <p className="lede">Times in {zone}.</p>}
        </div>
        <Link className="btn btn-primary" to="/gatherings/new">
          <Icon name="plus" />
          New gathering
        </Link>
      </div>
      {toolbar}

      {featured && (
        <Cover
          subject="gathering"
          id={featured.id}
          cover={featured.cover}
          variant="hero"
          badge={
            featured.next_occurrence ? (
              <DateBadge startsAt={featured.next_occurrence.starts_at} zone={zone} />
            ) : undefined
          }
        >
          <h2>
            <Link className="cover-link" to={`/gatherings/${featured.id}`}>
              {featured.title}
            </Link>
          </h2>
          <p className="cover-hero-meta">
            <CardLine pieces={featuredPieces(featured, zone)} />
          </p>
          {/* A picture of a button: the card's link already names the page. */}
          <span className="btn btn-photo" aria-hidden="true">
            Open gathering
          </span>
        </Cover>
      )}

      {moreComingUp.length > 0 && (
        <>
          <h2 className="list-section" id={comingUpHeading}>
            Coming up
          </h2>
          <ul className="cover-tiles" aria-labelledby={comingUpHeading}>
            {moreComingUp.map((gathering) => tile(gathering, true))}
          </ul>
        </>
      )}

      {past.length > 0 && (
        <>
          <h2 className="list-section" id={pastHeading}>
            Past
          </h2>
          <ul className="cover-tiles" aria-labelledby={pastHeading} ref={revealed}>
            {pastShown.map((gathering) => tile(gathering, false))}
          </ul>
          {!allPast && past.length > PAST_SHOWN && (
            <p className="list-more">
              <button
                type="button"
                onClick={() => {
                  setAllPast(true)
                  setJustRevealed(true)
                  rememberShownAll()
                }}
              >
                Show all {past.length} past gatherings
              </button>
            </p>
          )}
        </>
      )}

      {photosOnly.length > 0 && (
        <>
          <h2 className="list-section" id={photosHeading}>
            Photos you can see
          </h2>
          <ul className="cover-tiles" aria-labelledby={photosHeading}>
            {photosOnly.map((gathering) => tile(gathering, false))}
          </ul>
        </>
      )}
    </main>
  )
}
