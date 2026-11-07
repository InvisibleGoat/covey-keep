import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import { Link, useLocation } from 'react-router-dom'
import type { Person } from '../auth/context'
import { useAuth } from '../auth/useAuth'
import { MAKER_LINE, PRODUCT_NAME } from '../brand'
import { onCoverChange } from '../lib/covers'
import { effectiveZone } from '../lib/datetime'
import {
  groupPanelGatherings,
  homePanelSections,
  onMenuChange,
  panelGatheringLine,
  panelOf,
  readMenuLists,
  SECTIONS,
  sectionOf,
  upcomingGatherings,
  type MenuLists,
} from '../lib/frame'
import type { GatheringListItem } from '../lib/gatherings'
import { initials, memberCountLabel, type Group } from '../lib/groups'
import { useMenuLayout } from '../lib/menuLayout'
import { QuailHead } from './AuthArt'
import { Cover } from './Cover'
import { Icon } from './Icons'

// The menu, in its two layouts (CK-82 One list; CK-89 Rail and panel; the
// design handoff §3, the mockup's screens 02, 15 and 16): the same component
// in the wide screen's column and the phone's drawer.
//
// ONE LIST: the brand; the sections, the current one tinted; Your groups and
// Gatherings coming up; and a footer with the person, a way to Settings and
// the maker's line. Every row's thumbnail is its cover (CK-84), read through
// lib/covers.ts's cache. A row opens its group's or gathering's page directly
// (Steven, 2026-10-31), so no row carries a chevron. Its *Gatherings coming
// up* is Your gatherings' *Coming up*, the first five (CK-85).
//
// RAIL AND PANEL (CK-89): a rail of group covers down the side (`.rail`) and
// beside it a panel (`.panel`) that shows Home's — the brand, the sections,
// *Coming up*, *Not in a group* — or the chosen group's: a back row, its cover,
// three rows and its gatherings; the count is the People row's line alone
// (CK-89.1 dropped the facts line that repeated it). WHAT THE PANEL SHOWS IS READ FROM
// THE ADDRESS AND THE HELD LISTS (lib/frame.ts::panelOf), never from a second
// state, so Back and Forward always agree with it. A gathering's row opens its
// page directly in both layouts: there is no gathering's panel.
//
// The Home tile, a group's tile and the back row keep the drawer open on a
// phone and say where focus is owed; every other press closes it. `onPress`
// hands Frame that — in a ref, for a plain press only, so a press that opens a
// tab leaves nothing stale — and never in navigation state.
//
// The two lists are the caller's own, from the same two reads the list pages
// make (`GET /groups`, `GET /gatherings`), re-read whenever the page changes,
// after a cover act (lib/covers.ts) and after an act that changed what they
// draw with no page change (lib/frame.ts's announceMenuChange, CK-89.1);
// every read is cancelled on unmount. The menu reads neither
// `/groups/{id}/gatherings` nor `/members`. An empty list leaves its heading
// out; a failed read is one quiet line with Try again.

export type Owed = 'back-row' | 'home-tile' | null

export interface MenuPress {
  keepOpen: boolean
  owed: Owed
}

function plain(event: MouseEvent): boolean {
  return !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
}

function MenuHead() {
  return (
    <div className="nav-head">
      <Link className="brand" to="/groups">
        <QuailHead />
        {PRODUCT_NAME}
      </Link>
    </div>
  )
}

function SectionRows({ current }: { current: ReturnType<typeof sectionOf> }) {
  return (
    <ul className="nrows">
      {SECTIONS.map((section) => (
        <li key={section.id}>
          <Link className="nrow" to={section.to} aria-current={current === section.id ? 'page' : undefined}>
            <Icon name={section.icon} />
            <span className="t">
              <b>{section.label}</b>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

function GatheringRow({
  gathering,
  line,
  current,
  onPress,
}: {
  gathering: GatheringListItem
  line: string | null
  current?: boolean
  onPress?: (event: MouseEvent) => void
}) {
  return (
    <li>
      <Link
        className="nrow"
        to={`/gatherings/${gathering.id}`}
        aria-current={current ? 'page' : undefined}
        onClick={onPress}
      >
        <Cover subject="gathering" id={gathering.id} cover={gathering.cover} variant="thumb" />
        <span className="t">
          <b>{gathering.title}</b>
          {line !== null && <span>{line}</span>}
        </span>
      </Link>
    </li>
  )
}

function MenuFoot({ person }: { person: Person | null }) {
  return (
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
  )
}

function MenuFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="menu-failed">
      <p>Your groups and gatherings couldn't be loaded just now.</p>
      <button type="button" className="btn btn-small" onClick={onRetry}>
        Try again
      </button>
    </div>
  )
}

function Rail({
  groups,
  chosen,
  press,
}: {
  groups: Group[]
  chosen: string | null
  press: (kind: MenuPress) => (event: MouseEvent) => void
}) {
  return (
    <nav className="rail" aria-label="Your groups">
      <Link
        className="rail-item rail-home"
        to="/groups"
        aria-label="Home"
        title="Home"
        aria-current={chosen === null ? 'true' : undefined}
        onClick={press({ keepOpen: true, owed: null })}
      >
        <QuailHead />
      </Link>
      <span className="rail-sep" aria-hidden="true" />
      {groups.map((group) => (
        <Link
          key={group.id}
          className="rail-item"
          to={`/groups/${group.id}`}
          aria-label={group.name}
          title={group.name}
          aria-current={chosen === group.id ? 'true' : undefined}
          onClick={press({ keepOpen: true, owed: 'back-row' })}
        >
          <Cover subject="group" id={group.id} cover={group.cover} variant="thumb" />
        </Link>
      ))}
      {groups.length > 0 && <span className="rail-sep" aria-hidden="true" />}
      <Link className="rail-item rail-add" to="/groups/new" aria-label="New group" title="New group">
        <Icon name="plus" />
      </Link>
    </nav>
  )
}

export function Menu({ onPress }: { onPress?: (press: MenuPress) => void } = {}) {
  const { person } = useAuth()
  const { pathname } = useLocation()
  const layout = useMenuLayout()
  const current = sectionOf(pathname)
  const zone = effectiveZone(person?.timezone)
  const [lists, setLists] = useState<MenuLists | null>(null)
  // Bumped by Try again: the two reads over again, once per press.
  const [reloadKey, setReloadKey] = useState(0)
  const groupsHeading = useId()
  const upcomingHeading = useId()
  const comingHeading = useId()
  const standaloneHeading = useId()
  const gatheringsHeading = useId()
  const panelRef = useRef<HTMLElement>(null)

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
  // An act that changed a name, a count, a title or a date landed with no page
  // change (CK-89.1): the two lists again at once, the held ones kept on screen
  // until the new ones land.
  useEffect(() => onMenuChange(() => setReloadKey((key) => key + 1)), [])

  function tryAgain() {
    setLists(null)
    setReloadKey((key) => key + 1)
  }

  const now = Date.now()
  const groups = lists?.ok ? lists.groups : []
  const upcoming = lists?.ok ? upcomingGatherings(lists.gatherings, now) : []

  // The panel, from the address and the held lists alone.
  const panel = panelOf(pathname, lists?.ok ? lists : null)
  const panelKey = panel.kind === 'group' ? `group:${panel.group.id}` : 'home'
  // A panel that changes to another group's or to Home's starts at its top; a
  // row pressed inside the same group's panel moves nothing.
  useLayoutEffect(() => {
    if (panelRef.current) panelRef.current.scrollTop = 0
  }, [panelKey, layout])

  if (layout === 'list') {
    return (
      <nav className="menu" aria-label="Main">
        <MenuHead />
        <SectionRows current={current} />

        {lists?.ok === false && <MenuFailed onRetry={tryAgain} />}

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
                <GatheringRow key={gathering.id} gathering={gathering} line={panelGatheringLine(gathering, zone, now)} />
              ))}
            </ul>
          </>
        )}

        <MenuFoot person={person} />
      </nav>
    )
  }

  // Rail and panel. A plain press records what Frame needs; a press that opens
  // a tab (a modifier) records nothing.
  const press = (kind: MenuPress) => (event: MouseEvent) => {
    if (plain(event)) onPress?.(kind)
  }
  const home = lists?.ok ? homePanelSections(lists.gatherings, now) : null

  return (
    <>
      <Rail groups={groups} chosen={panel.kind === 'group' ? panel.group.id : null} press={press} />
      <nav className="panel" aria-label="Main" ref={panelRef}>
        {panel.kind === 'home' && lists !== null && (
          <>
            <MenuHead />
            <SectionRows current={current} />
            {lists.ok === false && <MenuFailed onRetry={tryAgain} />}
            {home && home.withGroup.length > 0 && (
              <>
                <h2 className="nav-label" id={comingHeading}>
                  Coming up
                </h2>
                <ul className="nrows" aria-labelledby={comingHeading}>
                  {home.withGroup.map((gathering) => (
                    <GatheringRow
                      key={gathering.id}
                      gathering={gathering}
                      line={panelGatheringLine(gathering, zone, now)}
                      // A gathering in a group changes the panel under the press.
                      onPress={press({ keepOpen: false, owed: 'back-row' })}
                    />
                  ))}
                </ul>
              </>
            )}
            {home && home.standalone.length > 0 && (
              <>
                <h2 className="nav-label" id={standaloneHeading}>
                  Not in a group
                </h2>
                <ul className="nrows" aria-labelledby={standaloneHeading}>
                  {home.standalone.map((gathering) => (
                    <GatheringRow
                      key={gathering.id}
                      gathering={gathering}
                      line={panelGatheringLine(gathering, zone, now)}
                    />
                  ))}
                </ul>
              </>
            )}
          </>
        )}
        {panel.kind === 'group' && lists?.ok && (
          <>
            <div className="backrow">
              <Link className="nrow" to="/groups" onClick={press({ keepOpen: true, owed: 'home-tile' })}>
                <Icon name="back" />
                <span className="t">
                  <b>Home</b>
                </span>
              </Link>
            </div>
            <Cover subject="group" id={panel.group.id} cover={panel.group.cover} variant="panel">
              <h2>{panel.group.name}</h2>
            </Cover>
            <ul className="nrows d">
              <li>
                <Link
                  className="nrow"
                  to={`/groups/${panel.group.id}`}
                  aria-current={pathname === `/groups/${panel.group.id}` ? 'page' : undefined}
                >
                  <Icon name="home" />
                  <span className="t">
                    <b>Group page</b>
                    <span>Cover, gatherings and photos</span>
                  </span>
                  <Icon name="chevron" className="chev" />
                </Link>
              </li>
              <li>
                <Link className="nrow" to={{ pathname: `/groups/${panel.group.id}`, hash: '#photos' }}>
                  <Icon name="photos" />
                  <span className="t">
                    <b>Photos</b>
                    <span>By gathering</span>
                  </span>
                  <Icon name="chevron" className="chev" />
                </Link>
              </li>
              <li>
                <Link
                  className="nrow"
                  to={`/groups/${panel.group.id}/people`}
                  aria-current={pathname === `/groups/${panel.group.id}/people` ? 'page' : undefined}
                >
                  <Icon name="groups" />
                  <span className="t">
                    <b>People</b>
                    <span>{memberCountLabel(panel.group.member_count)}</span>
                  </span>
                  <Icon name="chevron" className="chev" />
                </Link>
              </li>
            </ul>
            <h2 className="nav-label" id={gatheringsHeading}>
              Gatherings
            </h2>
            <PanelGatherings
              items={groupPanelGatherings(lists.gatherings, panel.group.id, now)}
              labelledBy={gatheringsHeading}
              zone={zone}
              now={now}
              currentId={panel.gatheringId}
            />
          </>
        )}
        <MenuFoot person={person} />
      </nav>
    </>
  )
}

function PanelGatherings({
  items,
  labelledBy,
  zone,
  now,
  currentId,
}: {
  items: GatheringListItem[]
  labelledBy: string
  zone: string
  now: number
  currentId: string | null
}) {
  if (items.length === 0) return <p className="facts facts-none">No gatherings yet.</p>
  return (
    <ul className="nrows" aria-labelledby={labelledBy}>
      {items.map((gathering) => (
        <GatheringRow
          key={gathering.id}
          gathering={gathering}
          line={panelGatheringLine(gathering, zone, now)}
          current={gathering.id === currentId}
        />
      ))}
    </ul>
  )
}
