import { useEffect, useId, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { MAKER_LINE, PRODUCT_NAME } from '../brand'
import { onCoverChange } from '../lib/covers'
import { effectiveZone, formatWeekdayDay } from '../lib/datetime'
import { readMenuLists, SECTIONS, sectionOf, upcomingGatherings, type MenuLists } from '../lib/frame'
import { initials, memberCountLabel } from '../lib/groups'
import { QuailHead } from './AuthArt'
import { Cover } from './Cover'
import { Icon } from './Icons'

// The menu, in the One list layout (CK-82; the design handoff §3, the
// mockup's screen 02): the same component in the wide screen's column and
// the phone's drawer. The brand; the sections, the current one tinted; Your
// groups and Gatherings coming up; and a footer with the person, a way to
// Settings and the maker's line.
//
// Every row's thumbnail is its cover (CK-84; components/Cover.tsx) — the
// picture an organiser set, or the empty cover, the quail on mint — read
// through lib/covers.ts's cache, so a re-read of the lists fetches no
// picture it already holds at the same version.
//
// What it leaves out, each a later phase: no pins and no "Active …
// ago" (neither has a backend — a group's row shows its count, in people,
// through the one helper the Groups list and a group's page read too), no
// Calendar (CK-91), and no details panel — a row opens its group's or
// gathering's page directly (Steven, 2026-10-31), so no row carries a
// chevron. Its *Gatherings coming up* is Your gatherings' *Coming up*, the
// first five (lib/frame.ts::upcomingGatherings, CK-85).
//
// The two lists are the caller's own, from the same two reads the list
// pages make (`GET /groups`, `GET /gatherings`), re-read whenever the page
// changes so a group made or renamed shows on the next page; every read is
// cancelled on unmount (the CK-17 pattern). An empty list leaves its heading
// out — the mockup draws no empty menu, and the Groups and Gatherings pages
// say what an empty list means. A failed read is one quiet line with Try
// again, inside the menu; the page beside it is never blocked.
export function Menu() {
  const { person } = useAuth()
  const { pathname } = useLocation()
  const current = sectionOf(pathname)
  const zone = effectiveZone(person?.timezone)
  const [lists, setLists] = useState<MenuLists | null>(null)
  // Bumped by Try again: the two reads over again, once per press.
  const [reloadKey, setReloadKey] = useState(0)
  const groupsHeading = useId()
  const upcomingHeading = useId()

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await readMenuLists()
      if (!cancelled) setLists(result)
    })()
    return () => {
      cancelled = true
    }
  }, [pathname, reloadKey])

  // A cover act landed on a page (CK-84): the two lists again at once, so a
  // thumbnail does not wait for the next navigation to show the new cover.
  useEffect(() => onCoverChange(() => setReloadKey((key) => key + 1)), [])

  function tryAgain() {
    setLists(null)
    setReloadKey((key) => key + 1)
  }

  const groups = lists?.ok ? lists.groups : []
  const upcoming = lists?.ok ? upcomingGatherings(lists.gatherings, Date.now()) : []

  return (
    <nav className="menu" aria-label="Menu">
      <div className="nav-head">
        <Link className="brand" to="/groups">
          <QuailHead />
          {PRODUCT_NAME}
        </Link>
      </div>

      <ul className="nrows">
        {SECTIONS.map((section) => (
          <li key={section.id}>
            <Link
              className="nrow"
              to={section.to}
              aria-current={current === section.id ? 'page' : undefined}
            >
              <Icon name={section.icon} />
              <span className="t">
                <b>{section.label}</b>
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {lists?.ok === false && (
        <div className="menu-failed">
          <p>Your groups and gatherings couldn't be loaded just now.</p>
          <button type="button" className="btn btn-small" onClick={tryAgain}>
            Try again
          </button>
        </div>
      )}

      {groups.length > 0 && (
        <>
          <h2 className="nav-label" id={groupsHeading}>
            Your groups
          </h2>
          <ul className="nrows" aria-labelledby={groupsHeading}>
            {groups.map((group) => (
              <li key={group.id}>
                <Link className="nrow" to={`/groups/${group.id}`}>
                  <Cover subject="group" id={group.id} cover={group.cover} variant="thumb" />
                  <span className="t">
                    <b>{group.name}</b>
                    <span>{memberCountLabel(group.member_count)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      {upcoming.length > 0 && (
        <>
          <h2 className="nav-label" id={upcomingHeading}>
            Gatherings coming up
          </h2>
          <ul className="nrows" aria-labelledby={upcomingHeading}>
            {upcoming.map((gathering) => (
              <li key={gathering.id}>
                <Link className="nrow" to={`/gatherings/${gathering.id}`}>
                  <Cover subject="gathering" id={gathering.id} cover={gathering.cover} variant="thumb" />
                  <span className="t">
                    <b>{gathering.title}</b>
                    {gathering.next_occurrence && (
                      <span>{formatWeekdayDay(gathering.next_occurrence.starts_at, zone)}</span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="nav-foot">
        <div className="me">
          {/* No profile, no name: the way to Settings still works. */}
          {person && (
            <>
              <span className="avatar" aria-hidden="true">
                {initials(person.display_name)}
              </span>
              <span className="me-name">
                <b>{person.display_name}</b>
                <span>Signed in</span>
              </span>
            </>
          )}
          <Link className="iconbtn" to="/settings" aria-label="Settings">
            <Icon name="gear" />
          </Link>
        </div>
        <span className="badge">{MAKER_LINE}</span>
      </div>
    </nav>
  )
}
