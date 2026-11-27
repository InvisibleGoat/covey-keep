// A chat's screen (CK-103; THE DESIGN §3 to §9, §12, §13): a group's and a
// gathering's are this one component, drawn by routes/Chat.tsx with a place.
//
// THREE PARTS, ONE SCROLLER: the header, the thread and the box, in a column
// that fills what can be seen of the window (useVisualViewport) under 900px
// and the page's column from it. The thread alone scrolls.
//
// WHAT COMES AND GOES is the hook's (useChat); this draws a snapshot of it.
// Who may do what is the server's `may_moderate`, through `actOn`: no role is
// compared here. Which held messages are shown is the page's own state, by id,
// let go the moment the message or the role does; nothing of a chat is stored.
//
// FOCUS (§12) is CK-94's one mechanism, each act with its own container: a
// step's acts may take focus from its own row, so a person who has gone to
// another message keeps their place. A check moves focus only out of a step,
// or a message's reactions, that has gone with its message.
//
// THE SECOND PAIR (CK-105): the New messages line where the first read says,
// the button to the newest over the thread's foot, the page after asked for
// as the loaded end nears (Sentinel), each entry seen told to the hook as the
// reading place, who is typing in the header, and a live message's reactions
// — one panel open at a time in the thread, never beside a step.
import {
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import {
  actOn,
  backTo,
  CHAT_FAILED,
  CHECKS_FAILING,
  compareEntries,
  dayLine,
  EARLIER_FAILED,
  GATHERING_NOTICE,
  gatheringChatLine,
  GO_TO_NEWEST,
  GO_TO_NEWEST_NEW,
  groupChatLine,
  groupNotice,
  isMessage,
  lineWords,
  localDay,
  messageLabel,
  MESSAGES,
  NEW_MESSAGES,
  newMessages,
  NEWER_FAILED,
  NO_CHAT_HERE,
  NO_MESSAGES,
  NOTHING_HERE,
  reactionLine,
  readWhoReacted,
  removeLine,
  SEND,
  sendLine,
  SHOW_EARLIER,
  spoken,
  stillToSend,
  TRY_AGAIN,
  typingLine,
  type ChatItem,
  type ChatPlace,
  type ReactionKind,
  type SendRefusal,
} from '../lib/chat'
import type { CoverBody } from '../lib/covers'
import { effectiveZone } from '../lib/datetime'
import { groupLine, outsideFlags } from '../lib/outsideInvitations'
import { ChatArrivalContext } from './chatArrival'
import { ChatLine, ChatMessage, ChatStep, HeldRow, type ReactPress, type WhoState } from './ChatEntry'
import { Cover } from './Cover'
import { Icon } from './Icons'
import { useChat, type Chat, type ChatSubject } from './useChat'
import { useChatRows } from './useChatRows'
import { useFocusRequest, type FocusSource } from './useFocusRequest'
import { useThreadScroll } from './useThreadScroll'
import { useVisualViewport } from './useVisualViewport'

// More than this many at once are said as a number.
const SAID_ONE_BY_ONE = 3
// The box grows to this and then scrolls in itself.
const BOX_MAX = 140
// Where Enter is the send key: a keyboard's device, not a phone's.
const KEYBOARD = '(hover: hover) and (pointer: fine)'

// What the header and the notice say. `group` is the group a line may name:
// the chat's own, or the gathering's for its members alone.
interface Described {
  name: string
  line: string
  notice: string
  group: string | null
  to: string
  id: string
  cover: CoverBody | null | undefined
}

function describe(subject: ChatSubject): Described {
  if (subject.kind === 'group') {
    const { id, name, member_count, cover } = subject.group
    return { name, line: groupChatLine(member_count), notice: groupNotice(name), group: name, to: `/groups/${id}`, id, cover }
  }
  const { gathering } = subject
  const { inGroup, on } = outsideFlags(gathering)
  const group = inGroup && gathering.group !== null ? gathering.group.name : null
  return {
    name: gathering.title,
    line: gatheringChatLine(gathering.invited_count),
    notice: group === null ? GATHERING_NOTICE : groupLine(group, on),
    group,
    to: `/gatherings/${gathering.id}`,
    id: gathering.id,
    cover: gathering.cover,
  }
}

export function ChatView({ place }: { place: ChatPlace }) {
  const chat = useChat(place)
  const { status, subject } = chat
  const visible = useVisualViewport()
  const described = subject === null ? null : describe(subject)
  const open = status === 'loaded' && subject !== null && described !== null

  const main = useRef<HTMLElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const tryAgain = useRef<HTMLButtonElement>(null)
  const retryOwed = useRef(false)
  const arrival = useContext(ChatArrivalContext)
  const moveFocus = useFocusRequest(main)
  useEffect(() => {
    if (status === 'loading') return
    const retried = retryOwed.current
    const arrived = arrival?.current === true
    retryOwed.current = false
    if (arrival !== null) arrival.current = false
    if (status === 'notFound' || arrived) moveFocus(heading)
    else if (retried) moveFocus(status === 'failed' ? tryAgain : heading)
  }, [status, arrival, moveFocus])

  const groups = place.kind === 'group'
  return (
    <main
      ref={main}
      className={open ? 'chat' : 'auth-screen'}
      style={
        open && visible !== null
          ? ({ '--chat-top': `${visible.top}px`, '--chat-height': `${visible.height}px` } as CSSProperties)
          : undefined
      }
    >
      <Told chat={chat} group={described?.group ?? null} />
      {status === 'loading' && <p>Loading…</p>}
      {status === 'notFound' && (
        // One screen, no speculation: it must not hint whether a chat exists
        // behind this address, or that the caller was ever in it.
        <>
          <h1 ref={heading} tabIndex={-1}>
            {NOTHING_HERE}
          </h1>
          <p>{NO_CHAT_HERE}</p>
          <Link to={groups ? '/groups' : '/gatherings'}>{groups ? 'Back to your groups' : 'Back to your gatherings'}</Link>
        </>
      )}
      {status === 'failed' && (
        <>
          <h1 ref={heading} tabIndex={-1}>
            Something went wrong
          </h1>
          <p className="form-error" role="alert">
            {CHAT_FAILED}
          </p>
          <button
            ref={tryAgain}
            type="button"
            onClick={() => {
              retryOwed.current = true
              chat.retry()
            }}
          >
            {TRY_AGAIN}
          </button>
          <Link to={groups ? '/groups' : '/gatherings'}>{groups ? 'Back to your groups' : 'Back to your gatherings'}</Link>
        </>
      )}
      {open && <OpenChat chat={chat} subject={subject} described={described} heading={heading} />}
    </main>
  )
}

// The one live region, in the page from the first render: what the last check
// brought from other people. A message that leaves goes from it too.
function Told({ chat, group }: { chat: Chat; group: string | null }) {
  const { arrived, entries } = chat
  if (arrived === null) return <div className="visually-hidden" aria-live="polite" />
  const live = new Set(entries.filter((item) => item.removed === null).map((item) => item.id))
  const lines = arrived.items.flatMap((item) => {
    const words = spoken(item, group)
    return words === null ? [] : [{ id: item.id, words }]
  })
  return (
    <div className="visually-hidden" aria-live="polite">
      {lines.length > SAID_ONE_BY_ONE ? (
        <p key={arrived.batch}>{newMessages(lines.length)}</p>
      ) : (
        lines.filter((line) => live.has(line.id)).map((line) => <p key={`${arrived.batch}:${line.id}`}>{line.words}</p>)
      )}
    </div>
  )
}

// The step beneath a message: asked, being sent, or landed and waiting for the
// check that brings its held row.
interface Step {
  id: string
  phase: 'asking' | 'sending' | 'waiting'
  line: string | null
}

function OpenChat({
  chat,
  subject,
  described,
  heading,
}: {
  chat: Chat
  subject: ChatSubject
  described: Described
  heading: RefObject<HTMLHeadingElement | null>
}) {
  const { person } = useAuth()
  const zone = effectiveZone(person?.timezone)
  const me = person?.display_name ?? null
  const { entries, older, earlier, newer, later, mayModerate, now, remove, showEarlier, showLater, typing } = chat
  const { name, line, notice, group, to, id, cover } = described

  const byId = useMemo(() => new Map(entries.map((item) => [item.id, item])), [entries])
  // What this build can say: a setting line with no group to name draws
  // nothing, and takes no day line with it.
  const drawn = useMemo(
    () => entries.filter((item) => isMessage(item) || lineWords(item, group) !== null),
    [entries, group],
  )
  const firstOfDay = useMemo(() => firstOfEachDay(drawn, zone), [drawn, zone])
  // The entry the New messages line stands above: the one it names, or the
  // first after it where that one isn't drawn.
  const unreadAt = chat.line
  const lineAbove = useMemo(
    () => (unreadAt === null ? null : (drawn.find((item) => compareEntries(item, unreadAt) >= 0)?.id ?? null)),
    [drawn, unreadAt],
  )

  const frame = useRef<HTMLDivElement>(null)
  const thread = useRef<HTMLElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const newLine = useRef<HTMLLIElement>(null)
  const rows = useChatRows()
  const view = useThreadScroll(
    thread,
    list,
    newLine,
    {
      entries: drawn,
      opened: chat.opened,
      newest: chat.newest,
      sent: chat.sent,
      toNewest: chat.toNewest,
      newer,
      reached: chat.reached,
    },
    rows.row.get,
    chat.markSeen,
  )

  // --- focus

  const container = useRef<() => HTMLElement | null>(() => null)
  const requestFocus = useFocusRequest(() => container.current())
  const moveFocus = useCallback(
    (inside: () => HTMLElement | null, target: FocusSource) => {
      container.current = inside
      requestFocus(target)
    },
    [requestFocus],
  )

  // --- a held message, shown

  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set())
  const held = [...shown].filter((one) => byId.get(one)?.removed)
  if (held.length !== shown.size) setShown(new Set(held))
  const onToggle = useCallback((one: string) => {
    setShown((was) => {
      const next = new Set(was)
      if (!next.delete(one)) next.add(one)
      return next
    })
  }, [])

  // --- deleting and removing

  const [step, setStep] = useState<Step | null>(null)
  const stepItem = step === null ? undefined : byId.get(step.id)
  const stepAct = stepItem === undefined ? null : actOn(stepItem, mayModerate)
  // The message has gone, or the role has: its step goes with it.
  if (step !== null && stepAct === null) setStep(null)
  const stepId = stepAct === null ? null : (step?.id ?? null)

  const stepGroup = useRef<HTMLDivElement>(null)
  const redButton = useRef<HTMLButtonElement>(null)
  const hadFocus = useRef(false)
  // The message whose act is being sent: no other step opens until it answers.
  const sending = useRef<string | null>(null)
  // The message whose step the caller's own act is closing: that act says
  // where focus goes.
  const closing = useRef<string | null>(null)
  const lastStep = useRef<string | null>(null)
  useEffect(() => {
    const closed = lastStep.current
    lastStep.current = stepId
    if (closed === null || closed === stepId) return
    const own = closing.current === closed
    if (own) closing.current = null
    if (!own && hadFocus.current) moveFocus(() => null, thread)
    hadFocus.current = false
  }, [stepId, moveFocus])

  const onAct = useCallback(
    (one: string) => {
      if (sending.current !== null) return
      // A step opening closes any panel in the thread.
      setPanel(null)
      setStep({ id: one, phase: 'asking', line: null })
      moveFocus(() => rows.row.get(one), stepGroup)
    },
    [moveFocus, rows],
  )

  function keep(one: string) {
    closing.current = one
    setStep(null)
    moveFocus(
      () => rows.row.get(one),
      () => rows.word.get(one),
    )
  }

  // The message a landed act is waiting to see go, or become its held row.
  const [landing, setLanding] = useState<string | null>(null)
  useEffect(() => {
    if (landing === null) return
    const item = byId.get(landing)
    if (item !== undefined && item.removed === null) return
    setLanding(null)
    moveFocus(
      () => null,
      item === undefined ? thread : () => rows.toggle.get(landing),
    )
  }, [landing, byId, moveFocus, rows])

  async function confirm(one: string) {
    if (sending.current !== null) return
    sending.current = one
    closing.current = one
    setStep({ id: one, phase: 'sending', line: null })
    const outcome = await remove(one)
    sending.current = null
    if (outcome === 'over') return
    if (outcome === 'gone') {
      setStep((was) => (was?.id === one ? { ...was, phase: 'waiting' } : was))
      setLanding(one)
      return
    }
    closing.current = null
    setStep((was) => (was?.id === one ? { id: one, phase: 'asking', line: removeLine(outcome) } : was))
    moveFocus(
      () => rows.row.get(one),
      () => redButton.current ?? thread.current,
    )
  }

  // --- reactions (THE DESIGN §7)

  // The one message whose panel is open: React opens it, and closes any step;
  // a step closes it; it goes with its message.
  const [panel, setPanel] = useState<string | null>(null)
  const panelNow = useRef(panel)
  panelNow.current = panel
  if (panel !== null && byId.get(panel)?.removed !== null) setPanel(null)
  // Who reacted to the message whose panel is open, read once as it opens.
  const [who, setWho] = useState<{ id: string; state: WhoState } | null>(null)
  // The messages a press is waiting on: one press at a time each.
  const [waiting, setWaiting] = useState<ReadonlySet<string>>(() => new Set())
  const waitingNow = useRef(waiting)
  waitingNow.current = waiting
  // What the last press that failed left beneath its chips, gone on the next.
  const [rxLine, setRxLine] = useState<{ id: string; line: string } | null>(null)

  const onReactOpen = useCallback(
    (one: string) => {
      const toReact = () => rows.react.get(one)
      if (panelNow.current === one) {
        setPanel(null)
        moveFocus(() => rows.row.get(one), toReact)
        return
      }
      setStep(null)
      setPanel(one)
      setWho({ id: one, state: 'loading' })
      void readWhoReacted(one).then((answer) => {
        const state: WhoState = answer.status === 'ok' ? answer.value : 'failed'
        setWho((was) => (was?.id === one ? { id: one, state } : was))
      })
      moveFocus(
        () => rows.row.get(one),
        () => rows.pick.get(`${one}:like`),
      )
    },
    [moveFocus, rows],
  )

  const onPanelKey = useCallback(
    (one: string, event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setPanel(null)
      moveFocus(
        () => rows.row.get(one),
        () => rows.react.get(one),
      )
    },
    [moveFocus, rows],
  )

  const { react } = chat
  const onReact = useCallback<ReactPress>(
    (one: string, kind: ReactionKind, on: boolean, from: 'chip' | 'picker') => {
      if (waitingNow.current.has(one)) return
      const asked = new Set(waitingNow.current)
      asked.add(one)
      waitingNow.current = asked
      setWaiting(asked)
      setRxLine((was) => (was?.id === one ? null : was))
      void react(one, kind, on).then((outcome) => {
        setWaiting((was) => {
          const next = new Set(was)
          next.delete(one)
          return next
        })
        if (outcome === 'over') return
        const inRow = () => rows.row.get(one)
        const toReact = () => rows.react.get(one)
        if (outcome === 'ok') {
          if (from === 'picker') {
            setPanel((was) => (was === one ? null : was))
            moveFocus(inRow, toReact)
          } else moveFocus(inRow, () => rows.chip.get(`${one}:${kind}`) ?? toReact())
        } else if (outcome === 'notFound') {
          // A check is on its way: where the message has gone, focus goes to
          // the thread once it lands (below).
          moveFocus(inRow, () => toReact() ?? thread.current)
        } else {
          setRxLine({ id: one, line: reactionLine(outcome) })
          moveFocus(inRow, () =>
            from === 'picker' ? rows.pick.get(`${one}:${kind}`) : (rows.chip.get(`${one}:${kind}`) ?? toReact()),
          )
        }
      })
    },
    [react, moveFocus, rows],
  )

  // The message whose reactions hold focus: where a check takes it away, or
  // makes it a held row, focus goes to the thread rather than nowhere.
  const reactFocus = useRef<string | null>(null)
  useEffect(() => {
    const one = reactFocus.current
    if (one === null) return
    if (byId.get(one)?.removed === null) return
    reactFocus.current = null
    moveFocus(() => null, thread)
  }, [byId, moveFocus])

  // --- the button to the newest, and reading on below

  const jumpButton = useRef<HTMLButtonElement>(null)
  async function toNewest() {
    const outcome = await chat.goToNewest()
    if (outcome === 'ok') moveFocus(() => frame.current, thread)
    else if (outcome === 'failed') moveFocus(() => frame.current, jumpButton)
  }

  const laterPlace = useRef<HTMLDivElement>(null)
  const laterRetry = useRef<HTMLButtonElement>(null)
  // The last entry before a Try again was pressed: the first after it is
  // where focus lands.
  const laterOwed = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (later === 'loading' || laterOwed.current === undefined) return
    const before = laterOwed.current
    laterOwed.current = undefined
    if (later === 'failed') {
      moveFocus(() => laterPlace.current, laterRetry)
      return
    }
    const at = drawn.findIndex((item) => item.id === before)
    const first = at === -1 ? undefined : drawn[at + 1]
    moveFocus(
      () => frame.current,
      () => {
        const target = first === undefined ? null : rows.row.get(first.id)
        if (target === null) return thread.current
        target.tabIndex = -1
        return target
      },
    )
  }, [later, drawn, moveFocus, rows])

  // --- earlier messages

  const earlierPlace = useRef<HTMLDivElement>(null)
  const earlierButton = useRef<HTMLButtonElement>(null)
  const earlierOwed = useRef(false)
  useEffect(() => {
    if (earlier === 'loading' || !earlierOwed.current) return
    earlierOwed.current = false
    moveFocus(
      () => earlierPlace.current,
      () => {
        // Without scrolling: the button is at the top of the thread, and the
        // message the reader is at stays where it is.
        if (earlierButton.current === null) return thread.current
        earlierButton.current.focus({ preventScroll: true })
        return null
      },
    )
  }, [earlier, moveFocus])

  return (
    <>
      <header className="chatbar">
        <Link className="iconbtn" to={to} aria-label={backTo(name)}>
          <Icon name="back" />
        </Link>
        <Cover subject={subject.kind} id={id} cover={cover} variant="thumb" />
        <div>
          <h1 ref={heading} tabIndex={-1}>
            {name}
          </h1>
          {/* Who is typing, in place of the count: never live, never said. */}
          {typing.length > 0 ? <p className="typing">{typingLine(typing)}</p> : <p>{line}</p>}
        </div>
      </header>

      <div ref={frame} className="threadframe">
        <section
          ref={thread}
          className="thread"
          aria-label={MESSAGES}
          tabIndex={0}
          onFocus={(event) => {
            reactFocus.current = (event.target as Element).closest('[data-rx]')?.getAttribute('data-rx') ?? null
          }}
        >
          <p className="notice">{notice}</p>
          {older && (
            <div ref={earlierPlace} className="earlier">
              <button
                ref={earlierButton}
                type="button"
                className="btn btn-small"
                disabled={earlier === 'loading'}
                onClick={() => {
                  earlierOwed.current = true
                  showEarlier()
                }}
              >
                {SHOW_EARLIER}
              </button>
              {earlier === 'failed' && (
                <p className="form-error" role="alert">
                  <span aria-hidden="true">⚠ </span>
                  {EARLIER_FAILED}
                </p>
              )}
            </div>
          )}
          {drawn.length === 0 && !older && <p className="nothing">{NO_MESSAGES}</p>}
          {drawn.length > 0 && (
            <ul ref={list} className="msgs">
              {drawn.map((item) => (
                <Fragment key={item.id}>
                  {lineAbove === item.id && (
                    <li ref={newLine} className="newline">
                      {NEW_MESSAGES}
                    </li>
                  )}
                  {firstOfDay.has(item.id) && <li className="dayline">{dayLine(item.created_at, zone, now)}</li>}
                  {item.removed !== null ? (
                    <HeldRow
                      item={item}
                      zone={zone}
                      now={now}
                      shown={shown.has(item.id)}
                      rows={rows}
                      onToggle={onToggle}
                    />
                  ) : isMessage(item) ? (
                    <ChatMessage
                      item={item}
                      zone={zone}
                      act={actOn(item, mayModerate)}
                      rows={rows}
                      onAct={onAct}
                      open={panel === item.id}
                      busy={waiting.has(item.id)}
                      line={rxLine?.id === item.id ? rxLine.line : null}
                      who={panel === item.id && who?.id === item.id ? who.state : undefined}
                      me={me}
                      onReactOpen={onReactOpen}
                      onReact={onReact}
                      onPanelKey={onPanelKey}
                    >
                      {step !== null && stepAct !== null && step.id === item.id && (
                        <ChatStep
                          item={item}
                          act={stepAct}
                          busy={step.phase !== 'asking'}
                          line={step.line}
                          stepRef={stepGroup}
                          redRef={redButton}
                          hadFocus={hadFocus}
                          onConfirm={() => void confirm(item.id)}
                          onKeep={() => keep(item.id)}
                        />
                      )}
                    </ChatMessage>
                  ) : (
                    <ChatLine words={lineWords(item, group) ?? ''} rowRef={rows.row.ref(item.id)} />
                  )}
                </Fragment>
              ))}
            </ul>
          )}
          {/* The loaded end: as it nears the view, the page after it is asked for. */}
          {newer && later !== 'failed' && <Sentinel key={drawn.at(-1)?.id ?? ''} thread={thread} onNear={showLater} />}
        </section>
        {view.jump && (
          <button
            ref={jumpButton}
            type="button"
            className="jump"
            aria-label={view.dot ? GO_TO_NEWEST_NEW : GO_TO_NEWEST}
            onClick={() => void toNewest()}
          >
            <Icon name="down" />
            {view.dot && <span className="dot" aria-hidden="true" />}
          </button>
        )}
      </div>

      <div className="chat-foot">
        <div ref={laterPlace} className="chat-later" role="status">
          {later === 'failed' && (
            <>
              <span>{NEWER_FAILED}</span>
              <button
                ref={laterRetry}
                type="button"
                className="btn btn-small"
                onClick={() => {
                  laterOwed.current = drawn.at(-1)?.id ?? null
                  showLater()
                }}
              >
                {TRY_AGAIN}
              </button>
            </>
          )}
        </div>
        <p className="chat-status" role="status">
          {chat.checksFailing && <span>{CHECKS_FAILING}</span>}
        </p>
        <Composer
          name={name}
          send={chat.send}
          forgetLost={chat.forgetLost}
          settled={chat.settled}
          typed={chat.typed}
        />
      </div>
    </>
  )
}

// The loaded end of a thread that stops short of the newest (THE DESIGN §3):
// seen by an IntersectionObserver on the thread with a margin of one view's
// height, it asks for the page after; the hook asks one page at a time. One
// element a cursor, so a page that lands is watched afresh.
function Sentinel({ thread, onNear }: { thread: RefObject<HTMLElement | null>; onNear: () => void }) {
  const element = useRef<HTMLDivElement>(null)
  const near = useRef(onNear)
  useLayoutEffect(() => {
    near.current = onNear
  })
  useEffect(() => {
    const target = element.current
    const root = thread.current
    if (target === null || root === null || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (seen) => {
        if (seen.some((one) => one.isIntersecting)) near.current()
      },
      { root, rootMargin: `${root.clientHeight}px 0px` },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [thread])
  return <div ref={element} className="sentinel" aria-hidden="true" />
}

function firstOfEachDay(items: ChatItem[], zone: string): ReadonlySet<string> {
  const first = new Set<string>()
  let last: string | null = null
  for (const item of items) {
    const day = localDay(item.created_at, zone)
    if (day !== last) first.add(item.id)
    last = day
  }
  return first
}

// --- the box ---------------------------------------------------------------------

// As tall as its words, to BOX_MAX. The form keeps its height while the box is
// measured, so the thread above it never changes size for a measurement.
function fit(box: HTMLTextAreaElement | null) {
  const form = box?.form
  if (!box || !form) return
  form.style.height = `${form.offsetHeight}px`
  box.style.height = 'auto'
  if (box.scrollHeight > 0) {
    box.style.height = `${Math.min(box.scrollHeight + box.offsetHeight - box.clientHeight, BOX_MAX)}px`
  }
  form.style.height = ''
}

function Composer({
  name,
  send,
  forgetLost,
  settled,
  typed,
}: {
  name: string
  send: Chat['send']
  forgetLost: Chat['forgetLost']
  settled: Chat['settled']
  typed: Chat['typed']
}) {
  const [words, setWords] = useState('')
  const [sending, setSending] = useState(false)
  const [refusal, setRefusal] = useState<SendRefusal | null>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  const refusalId = useId()

  useLayoutEffect(() => fit(box.current), [words])
  useEffect(() => {
    const onResize = () => fit(box.current)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // A send whose answer was lost, found written by a later check: a keystroke
  // since its line was drawn would have let it go.
  useEffect(() => {
    if (settled === null) return
    setWords((was) => stillToSend(was, settled.words))
    setRefusal(null)
  }, [settled])

  async function submit() {
    const trimmed = words.trim()
    if (sending || trimmed === '') return
    // Before the control that was pressed goes quiet, and inside the press, so
    // a phone's keyboard stays up. The box stays open while the send waits: one
    // that goes read-only drops the keyboard, and what is typed meanwhile.
    box.current?.focus()
    setSending(true)
    setRefusal(null)
    const result = await send(trimmed)
    setSending(false)
    if (result.status === 'sent') setWords((was) => stillToSend(was, trimmed))
    if (result.status === 'refused') setRefusal(result.reason)
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    void submit()
  }

  // Never while an input method is composing: Safari says so by the key code
  // alone.
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey) return
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (typeof window.matchMedia !== 'function' || !window.matchMedia(KEYBOARD).matches) return
    event.preventDefault()
    void submit()
  }

  return (
    <>
      <form className="composer" onSubmit={onSubmit}>
        <textarea
          ref={box}
          rows={1}
          aria-label={messageLabel(name)}
          placeholder={messageLabel(name)}
          aria-describedby={refusal === null ? undefined : refusalId}
          value={words}
          onChange={(event) => {
            setWords(event.target.value)
            setRefusal(null)
            forgetLost()
            // Whether the next check says the caller is typing.
            typed(event.target.value)
          }}
          onKeyDown={onKeyDown}
        />
        <button
          type="submit"
          className="sendbtn"
          aria-label={SEND}
          disabled={sending}
          onMouseDown={(event) => event.preventDefault()}
        >
          <Icon name="send" />
        </button>
      </form>
      {refusal !== null && (
        <p id={refusalId} className="form-error" role="alert">
          <span aria-hidden="true">⚠ </span>
          {sendLine(refusal)}
        </p>
      )}
    </>
  )
}
