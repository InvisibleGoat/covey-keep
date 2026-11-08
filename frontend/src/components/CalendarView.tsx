// The calendar (CK-91; the mockup's screen 06, `calendarView()`; the merge
// record's §3 item 11; decisions/2026-10-04-calendars-and-alerts-by-scope.md
// §1, §2): ONE component for the three places it is drawn — the Calendar tab
// (`/calendar`), a group's calendar (`/calendar?group=<id>`) and the Calendar
// view on Your gatherings (`/gatherings`, through the switch). The caller owns
// the page around it and the address; this owns the month card and the day's
// list.
//
// - EVERY DAY IS THE PROFILE'S ZONE'S (`zone`, handed in): today, each day a
//   date covers, the month's read, the day's list. Nothing here reads the
//   runner's zone, and the helpers in lib/calendar.ts take days as strings.
// - THE READ is CK-90's route, one request per shown month — `GET /calendar`,
//   or `GET /groups/{id}/calendar` for a group's — and nothing else: never
//   `GET /gatherings`, `/members` or a gathering's detail. An answer for a
//   month no longer shown is ignored. No month is kept: Next then Previous
//   reads the month again. WHO SEES A DATE IS THE ROUTE'S: every date it
//   answers is drawn, and nothing here decides who may see one.
// - THE MONTH CARD (`.cal-card`): the month and year (an <h2>, polite), and
//   Previous month, Today and Next month, each keeping focus; the weekday row,
//   hidden from a reader; a button per day, labelled *{Weekday, Month D}*, then
//   *: {titles}* where it holds dates and *, today* on today, `aria-pressed` on
//   the selected day. On a phone at most two covers, then *+N*; from 640px at
//   most three chips — a cover and the title — then *N more*; each cover the
//   thumbnail layer through the one cache (`Cover`'s `mark`). The grid is ONE
//   tab stop, the selected day (the 1st while nothing is selected), and the
//   arrows move a day or a week within the month; at its edges nothing moves.
// - THE MOVES: a day pressed, an arrow, Today and a month that holds today
//   select that day and write it to the address (`onDay`, which replaces the
//   entry: moving around the calendar adds no history entry, and Back from a
//   gathering lands on the same day). Moving to a month that does not hold
//   today selects nothing until its answer lands, then its first day with a
//   date, else its 1st. With no day in the address the calendar opens at
//   `fallbackDay` (a group's next date) or today, and writes nothing.
// - THE DAY'S LIST (`.agenda`, polite): the day in full, *Today* and the count
//   of its gatherings, then a row per date — a link to the gathering with its
//   cover, its title, its time line and where it is, and at the right the
//   caller's own answer as CK-87's chip while the date is not over, or once it
//   is the published photos the caller can see (nothing for none). *Nothing on
//   this day.* only once the month's answer has landed; a failed read says so,
//   with Try again, one request per press.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  datesByDay,
  dayHeading,
  dayLabel,
  dayLine,
  isOver,
  monthDays,
  monthDefaultDay,
  monthOf,
  monthTitle,
  MONTH_FAILED,
  NEXT_MONTH,
  NOTHING_ON_THIS_DAY,
  PREVIOUS_MONTH,
  readCalendar,
  shiftDay,
  shiftMonth,
  SHOW_ALL_GROUPS,
  timeLine,
  todayIn,
  TODAY,
  WEEKDAYS,
  whereText,
  type CalendarEntry,
  type CalendarGathering,
  type CalendarRead,
} from '../lib/calendar'
import { photoCountLabel } from '../lib/media'
import { NOT_ANSWERED, rsvpResponseLabel } from '../lib/rsvps'
import { Cover } from './Cover'
import { Icon } from './Icons'
import { usePreviewWide } from './usePreviewWide'

// How many covers a day shows before its count: two on a phone, three chips
// from 640px (the mockup's).
const MARKS_SHOWN = 2
const CHIPS_SHOWN = 3

const ARROW_STEP: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }

export interface CalendarViewProps {
  zone: string
  // A group's calendar reads `GET /groups/{id}/calendar` and carries the
  // filter line; null is every gathering the person is invited to.
  groupId: string | null
  groupName?: string
  // The address's day, already parsed (lib/calendar.ts's `parseDay`).
  day: string | null
  // Where the calendar opens with no day in the address; null is today.
  fallbackDay: string | null
  // Writes a day to the address, replacing the entry.
  onDay: (day: string) => void
  // A 404 on a group's calendar read: the group page's not-found screen.
  onNotFound?: () => void
}

interface Shown {
  month: string
  // The selected day; null while a month moved to awaits its answer.
  selected: string | null
}

// A day's gatherings, each once, in the order of its first date that day —
// a gathering with two dates on one day is one cover and one title.
function gatheringsOf(entries: CalendarEntry[]): CalendarGathering[] {
  const seen = new Map<string, CalendarGathering>()
  for (const { gathering } of entries) if (!seen.has(gathering.id)) seen.set(gathering.id, gathering)
  return [...seen.values()]
}

export function CalendarView({ zone, groupId, groupName, day, fallbackDay, onDay, onNotFound }: CalendarViewProps) {
  const today = todayIn(zone)
  const wide = usePreviewWide()
  const grid = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState<Shown>(() => {
    const opening = day ?? fallbackDay ?? todayIn(zone)
    return { month: monthOf(opening), selected: opening }
  })

  // The address's day is the selection. A move writes it, and reads back here
  // as the day already selected; anything else that changes it — the Calendar
  // tab pressed on the calendar, Back — moves the calendar there, and no day at
  // all is the opening day again.
  const [seenDay, setSeenDay] = useState(day)
  if (day !== seenDay) {
    setSeenDay(day)
    const next = day ?? fallbackDay ?? today
    if (next !== shown.selected) setShown({ month: monthOf(next), selected: next })
  }

  // The month's read, keyed by what it was asked for: an answer for another
  // month, group or zone — or one a Try again has replaced — counts as out.
  const [attempt, setAttempt] = useState(0)
  const loadKey = `${groupId ?? ''}|${zone}|${shown.month}|${attempt}`
  const [load, setLoad] = useState<{ key: string; read: CalendarRead } | null>(null)
  useEffect(() => {
    let cancelled = false
    const key = `${groupId ?? ''}|${zone}|${shown.month}|${attempt}`
    void readCalendar(shown.month, zone, groupId).then((read) => {
      if (!cancelled) setLoad({ key, read })
    })
    return () => {
      cancelled = true
    }
  }, [groupId, zone, shown.month, attempt])
  const read = load !== null && load.key === loadKey ? load.read : null
  const byDay = read?.status === 'loaded' ? datesByDay(read.answer, shown.month, zone) : new Map<string, CalendarEntry[]>()

  // The caller's two callbacks, read at the moment they are called.
  const callbacks = useRef({ onDay, onNotFound })
  useEffect(() => {
    callbacks.current = { onDay, onNotFound }
  })

  // A month moved to selects its first day with a date once its answer lands.
  useEffect(() => {
    if (shown.selected !== null || read?.status !== 'loaded') return
    const next = monthDefaultDay(shown.month, todayIn(zone), datesByDay(read.answer, shown.month, zone))
    setShown({ month: shown.month, selected: next })
    callbacks.current.onDay(next)
  }, [read, shown, zone])

  useEffect(() => {
    if (read?.status === 'notFound') callbacks.current.onNotFound?.()
  }, [read])

  function select(next: string) {
    setShown({ month: monthOf(next), selected: next })
    onDay(next)
  }

  function moveMonth(delta: number) {
    const month = shiftMonth(shown.month, delta)
    if (monthOf(today) === month) select(today)
    else setShown({ month, selected: null })
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = ARROW_STEP[event.key]
    if (step === undefined) return
    const from = (event.target as HTMLElement).closest('button.day')?.getAttribute('data-day')
    if (!from) return
    event.preventDefault()
    const target = shiftDay(from, step)
    if (monthOf(target) !== shown.month) return
    select(target)
    grid.current?.querySelector<HTMLButtonElement>(`button[data-day="${target}"]`)?.focus()
  }

  const { lead, days } = monthDays(shown.month)
  const trail = (7 - ((lead + days.length) % 7)) % 7
  const selected = shown.selected
  const tabStop = selected !== null && monthOf(selected) === shown.month ? selected : `${shown.month}-01`

  function dayButton(d: string) {
    const isToday = d === today
    const gatherings = gatheringsOf(byDay.get(d) ?? [])
    const count = gatherings.length
    let covers = null
    if (count > 0 && wide) {
      covers = (
        <span className="chips" aria-hidden="true">
          {gatherings.slice(0, CHIPS_SHOWN).map((gathering) => (
            <span className="ev" key={gathering.id}>
              <Cover subject="gathering" id={gathering.id} cover={gathering.cover} variant="mark" />
              <span>{gathering.title}</span>
            </span>
          ))}
          {count > CHIPS_SHOWN && <span className="more">{count - CHIPS_SHOWN} more</span>}
        </span>
      )
    } else if (count > 0) {
      covers = (
        <span className="marks" aria-hidden="true">
          {gatherings.slice(0, MARKS_SHOWN).map((gathering) => (
            <Cover key={gathering.id} subject="gathering" id={gathering.id} cover={gathering.cover} variant="mark" />
          ))}
          {count > MARKS_SHOWN && <span className="more">+{count - MARKS_SHOWN}</span>}
        </span>
      )
    }
    return (
      <button
        key={d}
        type="button"
        className={isToday ? 'day today' : 'day'}
        data-day={d}
        aria-pressed={d === selected}
        aria-label={dayLabel(
          d,
          gatherings.map((gathering) => gathering.title),
          isToday,
        )}
        tabIndex={d === tabStop ? 0 : -1}
        onClick={() => select(d)}
      >
        <span className="num">{Number(d.slice(8))}</span>
        {covers}
      </button>
    )
  }

  const failed = read?.status === 'failed' && (
    <div className="list-state">
      <p className="form-error">{MONTH_FAILED}</p>
      <button type="button" className="btn-small" onClick={() => setAttempt((value) => value + 1)}>
        Try again
      </button>
    </div>
  )

  function agenda() {
    if (selected === null) return failed
    const isToday = selected === today
    const entries = byDay.get(selected) ?? []
    const line = dayLine(isToday, gatheringsOf(entries).length)
    const now = Date.now()
    return (
      <>
        <h3>{dayHeading(selected)}</h3>
        {line !== null && <p className="sub">{line}</p>}
        {read?.status === 'loaded' && entries.length === 0 && <p className="empty-day">{NOTHING_ON_THIS_DAY}</p>}
        {read?.status === 'loaded' && entries.length > 0 && (
          <ul className="nrows">
            {entries.map((entry) => (
              <li key={entry.date.id}>
                <Link className="nrow" to={`/gatherings/${entry.gathering.id}`}>
                  <Cover subject="gathering" id={entry.gathering.id} cover={entry.gathering.cover} variant="thumb" />
                  <span className="t">
                    <b>{entry.gathering.title}</b>
                    <span>{timeLine(entry, selected, zone)}</span>
                    <span>{whereText(entry.gathering)}</span>
                  </span>
                  <span className="right">{rowEnd(entry, now)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {failed}
      </>
    )
  }

  return (
    <div className="cal">
      <div className="auth-card cal-card">
        <div className="cal-head">
          <h2 className="cal-title" aria-live="polite">
            {monthTitle(shown.month)}
          </h2>
          <div className="cal-nav">
            <button type="button" className="iconbtn" aria-label={PREVIOUS_MONTH} onClick={() => moveMonth(-1)}>
              <Icon name="prev" />
            </button>
            <button type="button" className="btn-small" onClick={() => select(today)}>
              {TODAY}
            </button>
            <button type="button" className="iconbtn" aria-label={NEXT_MONTH} onClick={() => moveMonth(1)}>
              <Icon name="next" />
            </button>
          </div>
        </div>
        {groupId !== null && groupName !== undefined && (
          <p className="filter">
            Showing <b>{groupName}</b> only{' '}
            <Link className="btn btn-small" to={selected !== null ? `/calendar?day=${selected}` : '/calendar'}>
              {SHOW_ALL_GROUPS}
            </Link>
          </p>
        )}
        <div className="wk" aria-hidden="true">
          {WEEKDAYS.map((weekday) => (
            <span key={weekday}>{weekday}</span>
          ))}
        </div>
        <div className="days" ref={grid} onKeyDown={onKeyDown}>
          {Array.from({ length: lead }, (_, index) => (
            <span key={`lead-${index}`} className="blank" aria-hidden="true" />
          ))}
          {days.map(dayButton)}
          {Array.from({ length: trail }, (_, index) => (
            <span key={`trail-${index}`} className="blank" aria-hidden="true" />
          ))}
        </div>
      </div>
      <div className="auth-card agenda" aria-live="polite">
        {agenda()}
      </div>
    </div>
  )
}

// A row's end: the caller's own answer while the date is not over (CK-87's
// chip, dashed for none), and once it is, the published photos the caller can
// see — nothing for none.
function rowEnd({ date, gathering }: CalendarEntry, now: number) {
  if (isOver(date, now)) {
    return gathering.published_count > 0 ? (
      <span className="count">{photoCountLabel(gathering.published_count)}</span>
    ) : null
  }
  const response = date.caller_response
  return (
    <span className={response ? 'answer' : 'answer answer-none'}>
      {response ? rsvpResponseLabel(response) : NOT_ANSWERED}
    </span>
  )
}
