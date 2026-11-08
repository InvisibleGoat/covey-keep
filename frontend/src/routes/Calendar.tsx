// /calendar — the Calendar tab, and a group's calendar at /calendar?group=<id>
// (CK-91; the mockup's screen 06; the merge record's §1.3 and §3 item 11;
// decisions/2026-10-04-calendars-and-alerts-by-scope.md §2). One route, the
// group in the query, so the tab and a group's calendar are one page: the
// heading *Calendar*, the lede naming the profile's zone, **New gathering**,
// then the calendar (components/CalendarView.tsx).
//
// - THE TAB reads `GET /calendar` for the shown month: every date of every
//   gathering the person is invited to. New gathering opens the plain form.
// - A GROUP'S CALENDAR is reached from the group page's Calendar button and,
//   in Rail and panel, the Calendar row of the group's panel. It reads the
//   group (`GET /groups/{id}`) for its name, then — only when the address
//   holds no day — the group's gatherings once (`GET /groups/{id}/gatherings`),
//   to open at its next date, else its most recent past one, else today; then
//   `GET /groups/{id}/calendar` for the shown month. The opening day is not
//   written to the address: only a move writes it. The card says *Showing
//   {name} only* with **Show all groups**, a link to the tab at the same day;
//   New gathering opens the group's form. A 404 on the group or on its
//   calendar, and an id that cannot name a group (nothing asked), is the group
//   page's not-found screen, byte for byte; a failed read of the group is the
//   group page's failed screen.
// - THE DAY is `?day=YYYY-MM-DD`, written by replace, so moving around the
//   calendar adds no history entry; `useKeepPlace` acts on a pathname change
//   alone, and a move changes only the query.
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { CalendarView } from '../components/CalendarView'
import { Icon } from '../components/Icons'
import { CALENDAR, calendarLede, groupOpeningDay, parseGroupId, useCalendarDay } from '../lib/calendar'
import { effectiveZone } from '../lib/datetime'
import { readGroup, readGroupGatherings, type Group } from '../lib/groups'

export function Calendar() {
  const { person } = useAuth()
  const zone = effectiveZone(person?.timezone)
  const [params] = useSearchParams()
  const [day, onDay] = useCalendarDay()
  const group = params.get('group')

  if (group) return <GroupCalendar key={group} raw={group} zone={zone} day={day} onDay={onDay} />

  return (
    <main className="auth-screen page-column">
      <div className="page-head">
        <div>
          <h1>{CALENDAR}</h1>
          <p className="lede">{calendarLede(zone)}</p>
        </div>
        <Link className="btn btn-primary" to="/gatherings/new">
          <Icon name="plus" />
          New gathering
        </Link>
      </div>
      <CalendarView zone={zone} groupId={null} day={day} fallbackDay={null} onDay={onDay} />
    </main>
  )
}

type GroupLoad =
  | { status: 'loading' }
  | { status: 'notFound' }
  | { status: 'failed' }
  | { status: 'ready'; group: Group; opening: string | null }

function GroupCalendar({
  raw,
  zone,
  day,
  onDay,
}: {
  raw: string
  zone: string
  day: string | null
  onDay: (day: string) => void
}) {
  const groupId = parseGroupId(raw)
  // The opening is decided once, from the address the calendar was opened at.
  const [openedWithDay] = useState(day !== null)
  const [openedIn] = useState(zone)
  const [load, setLoad] = useState<GroupLoad>(groupId === null ? { status: 'notFound' } : { status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (groupId === null) return
    let cancelled = false
    async function read(id: string) {
      const result = await readGroup(id)
      if (cancelled) return
      if (result.status !== 'loaded') {
        setLoad({ status: result.status })
        return
      }
      let opening: string | null = null
      if (!openedWithDay) {
        const gatherings = await readGroupGatherings(id)
        if (cancelled) return
        if (gatherings.ok) opening = groupOpeningDay(gatherings.gatherings, Date.now(), openedIn)
      }
      setLoad({ status: 'ready', group: result.value, opening })
    }
    void read(groupId)
    return () => {
      cancelled = true
    }
  }, [groupId, attempt, openedWithDay, openedIn])

  if (load.status === 'notFound') {
    // The group page's one screen, word for word (routes/GroupDetail.tsx): it
    // must not hint whether a group exists behind this address.
    return (
      <main className="auth-screen">
        <h1>Nothing here</h1>
        <p>There's no group to show at this address.</p>
        <Link to="/groups">Back to your groups</Link>
      </main>
    )
  }

  if (load.status === 'failed') {
    return (
      <main className="auth-screen">
        <h1>Something went wrong</h1>
        <p className="form-error" role="alert">
          Something went wrong loading this group.
        </p>
        <button
          type="button"
          onClick={() => {
            setLoad({ status: 'loading' })
            setAttempt((value) => value + 1)
          }}
        >
          Try again
        </button>
        <Link to="/groups">Back to your groups</Link>
      </main>
    )
  }

  if (load.status === 'loading') {
    return (
      <main className="auth-screen">
        <p>Loading…</p>
      </main>
    )
  }

  const { group, opening } = load
  return (
    <main className="auth-screen page-column">
      <div className="page-head">
        <div>
          <h1>{CALENDAR}</h1>
          <p className="lede">{calendarLede(zone)}</p>
        </div>
        <Link className="btn btn-primary" to={`/groups/${group.id}/gatherings/new`}>
          <Icon name="plus" />
          New gathering
        </Link>
      </div>
      <CalendarView
        zone={zone}
        groupId={group.id}
        groupName={group.name}
        day={day}
        fallbackDay={opening}
        onDay={onDay}
        onNotFound={() => setLoad({ status: 'notFound' })}
      />
    </main>
  )
}
