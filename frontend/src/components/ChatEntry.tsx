// What a chat draws (CK-103; THE DESIGN §5, §7, §8): a message, a line the chat
// wrote itself, a held message's row and the step beneath a message; since
// CK-105 a live message's reactions — its chips, React, and the panel React
// opens, the picker and Who reacted. A line, a held row, a message the server
// sent no reactions for and a Chat card's entry carry none of them. The chat's
// screen and the cards on the two pages draw a message through one copy
// (MessageParts), so a card and the chat never disagree about one.
//
// EVERYTHING IS TEXT. A message's words are pieces of text, and an explicit
// http or https address among them is a link through the one URL guard
// (lib/chat.ts::linkPieces); nothing here sets HTML, and no preview of a link
// is ever asked for.
//
// A HELD MESSAGE'S WORDS ARE NOT IN THE PAGE UNTIL THE PRESS: the row draws
// them only while it is shown, and nothing else here draws one at all.
import { memo, useId, useLayoutEffect, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import {
  atStart,
  chipLabel,
  CHOOSE_A_REACTION,
  DELETE,
  DELETE_SENTENCE,
  DELETE_YOUR_MESSAGE,
  daysLeftWords,
  heldWords,
  HIDE_IT,
  isFormerMember,
  KEEP_IT,
  linkPieces,
  REACTION_EMOJI,
  REACTION_KINDS,
  reactionName,
  reactionsOf,
  reactLabel,
  REMOVE,
  removeLabel,
  removeSentence,
  SHOW_IT,
  WHO_FAILED,
  WHO_REACTED,
  whoNames,
  YOU,
  type Act,
  type ChatItem,
  type ReactionKind,
  type WhoReacted,
} from '../lib/chat'
import { formatTime } from '../lib/datetime'
import { initials } from '../lib/groups'
import { Icon, LikeMark } from './Icons'
import type { ChatRows } from './useChatRows'

export function Words({ words }: { words: string }) {
  return (
    <>
      {linkPieces(words).map((piece, n) =>
        piece.href === undefined ? (
          piece.text
        ) : (
          <a key={n} href={piece.href} target="_blank" rel="noreferrer">
            {piece.text}
          </a>
        ),
      )}
    </>
  )
}

// A message: whose it is, when, the words — your own at the right, with no
// avatar. `time` is the caller's: the time alone in the chat, the day with it
// in a card where it was not today.
export function MessageParts({
  item,
  time,
  rowRef,
  act,
  children,
}: {
  item: ChatItem
  time: string
  rowRef?: (element: HTMLLIElement | null) => void
  act?: ReactNode
  children?: ReactNode
}) {
  const { display_name: name, is_self: own } = item.author
  return (
    <li ref={rowRef} className={own ? 'msg me' : 'msg'}>
      {!own && (
        <span className="avatar" aria-hidden="true">
          {isFormerMember(name) ? '' : initials(name)}
        </span>
      )}
      <div>
        <div className="mhead">
          <span className="by">{own ? YOU : atStart(name)}</span>
          <time dateTime={item.created_at}>{time}</time>
          {act}
        </div>
        <div className="bubble">
          <Words words={item.body ?? ''} />
        </div>
        {children}
      </div>
    </li>
  )
}

// Who reacted, as the panel holds it: being read, failed, or the answer.
export type WhoState = 'loading' | 'failed' | WhoReacted

// A press on a chip or a picker button.
export type ReactPress = (id: string, kind: ReactionKind, on: boolean, from: 'chip' | 'picker') => void

// A kind's mark: the Like mark, or the device's own emoji. Decorative inside a
// control its name says; an image named by its kind where it stands alone.
function ReactionMark({ kind, named = false }: { kind: ReactionKind; named?: boolean }) {
  if (kind === 'like') return <LikeMark label={named ? reactionName(kind) : undefined} />
  return named ? (
    <span className="e" role="img" aria-label={reactionName(kind)}>
      {REACTION_EMOJI[kind]}
    </span>
  ) : (
    <span className="e" aria-hidden="true">
      {REACTION_EMOJI[kind]}
    </span>
  )
}

export const ChatMessage = memo(function ChatMessage({
  item,
  zone,
  act,
  rows,
  onAct,
  open = false,
  busy = false,
  line = null,
  who,
  me = null,
  onReactOpen,
  onReact,
  onPanelKey,
  children,
}: {
  item: ChatItem
  zone: string
  act: Act | null
  rows: ChatRows
  onAct: (id: string) => void
  // The panel beneath this message is open.
  open?: boolean
  // A press on one of its reactions is waiting.
  busy?: boolean
  // What the last press that failed left beneath the chips.
  line?: string | null
  who?: WhoState
  // The caller's own display name, taken once out of the names of a kind
  // that is theirs.
  me?: string | null
  onReactOpen?: (id: string) => void
  onReact?: ReactPress
  onPanelKey?: (id: string, event: KeyboardEvent) => void
  children?: ReactNode
}) {
  const reactions = reactionsOf(item)
  const reacts = reactions !== null && onReactOpen !== undefined && onReact !== undefined
  const mine = (kind: ReactionKind) => reactions?.some((one) => one.kind === kind && one.mine) ?? false
  const whoRows = typeof who === 'object' ? who.reactions.filter((one) => one.names.length > 0) : []
  return (
    <MessageParts
      item={item}
      time={formatTime(item.created_at, zone)}
      rowRef={rows.row.ref(item.id)}
      act={
        <>
          {reacts && (
            <button
              ref={rows.react.ref(item.id)}
              type="button"
              className="rxadd"
              aria-label={reactLabel(item.author)}
              aria-expanded={open}
              data-rx={item.id}
              disabled={busy}
              onClick={() => onReactOpen(item.id)}
            >
              <Icon name="smile" />
            </button>
          )}
          {act !== null && (
            <button
              ref={rows.word.ref(item.id)}
              type="button"
              className="act"
              aria-label={act === 'delete' ? DELETE_YOUR_MESSAGE : removeLabel(item.author.display_name)}
              onClick={() => onAct(item.id)}
            >
              {act === 'delete' ? DELETE : REMOVE}
            </button>
          )}
        </>
      }
    >
      {reacts && open && (
        <div className="rxpanel" data-rx={item.id} onKeyDown={(event) => onPanelKey?.(item.id, event)}>
          <div className="picker" role="group" aria-label={CHOOSE_A_REACTION}>
            {REACTION_KINDS.map((kind) => (
              <button
                key={kind}
                ref={rows.pick.ref(`${item.id}:${kind}`)}
                type="button"
                className={mine(kind) ? 'mine' : undefined}
                aria-label={reactionName(kind)}
                aria-pressed={mine(kind)}
                disabled={busy}
                onClick={() => onReact(item.id, kind, !mine(kind), 'picker')}
              >
                <ReactionMark kind={kind} />
              </button>
            ))}
          </div>
          {who === 'failed' && <p className="who-failed">{WHO_FAILED}</p>}
          {whoRows.length > 0 && (
            <div className="who">
              <b>{WHO_REACTED}</b>
              {whoRows.map(({ kind, names }) => (
                <div key={kind}>
                  <ReactionMark kind={kind} named />
                  {whoNames(names, mine(kind), me)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {reacts && reactions.length > 0 && (
        <div className="rx" data-rx={item.id}>
          {reactions.map(({ kind, count, mine: theirs }) => (
            <button
              key={kind}
              ref={rows.chip.ref(`${item.id}:${kind}`)}
              type="button"
              className={theirs ? 'rxchip mine' : 'rxchip'}
              aria-label={chipLabel(kind, count)}
              aria-pressed={theirs}
              disabled={busy}
              onClick={() => onReact(item.id, kind, !theirs, 'chip')}
            >
              <ReactionMark kind={kind} />
              {count}
            </button>
          ))}
        </div>
      )}
      {reacts && line !== null && (
        <p className="form-error rxline" role="alert">
          {line}
        </p>
      )}
      {children}
    </MessageParts>
  )
})

// The step beneath a message: a group labelled by its sentence, which takes
// focus, with the red word and Keep it. `hadFocus` is told, as the step goes,
// whether focus was inside it.
export function ChatStep({
  item,
  act,
  busy,
  line,
  stepRef,
  redRef,
  hadFocus,
  onConfirm,
  onKeep,
}: {
  item: ChatItem
  act: Act
  busy: boolean
  line: string | null
  stepRef: RefObject<HTMLDivElement | null>
  redRef: RefObject<HTMLButtonElement | null>
  hadFocus: RefObject<boolean>
  onConfirm: () => void
  onKeep: () => void
}) {
  const sentence = useId()
  // Read while the step is still in the page: a layout effect's cleanup runs
  // before the elements it stood over are taken out.
  useLayoutEffect(() => {
    const step = stepRef.current
    return () => {
      hadFocus.current = step !== null && step.contains(document.activeElement)
    }
  }, [stepRef, hadFocus])
  return (
    <div ref={stepRef} className="step" role="group" aria-labelledby={sentence} tabIndex={-1}>
      <p id={sentence}>{act === 'delete' ? DELETE_SENTENCE : removeSentence(item.author.display_name)}</p>
      <div>
        <button ref={redRef} type="button" className="btn btn-small danger-button" disabled={busy} onClick={onConfirm}>
          {act === 'delete' ? DELETE : REMOVE}
        </button>
        <button type="button" className="btn btn-small" disabled={busy} onClick={onKeep}>
          {KEEP_IT}
        </button>
      </div>
      {line !== null && (
        <p className="form-error" role="alert">
          <span aria-hidden="true">⚠ </span>
          {line}
        </p>
      )}
    </div>
  )
}

// A line the chat wrote itself.
export function ChatLine({ words, rowRef }: { words: string; rowRef?: (element: HTMLLIElement | null) => void }) {
  return (
    <li ref={rowRef} className="sysline">
      {words}
    </li>
  )
}

// A held message, as whoever runs the chat is sent it (look B): what happened,
// and Show it. Its words are drawn while it is shown and not before.
export function HeldRow({
  item,
  zone,
  now,
  shown,
  rows,
  onToggle,
}: {
  item: ChatItem
  zone: string
  now: number
  shown: boolean
  rows: ChatRows
  onToggle: (id: string) => void
}) {
  const line = useId()
  const left = item.removed === null ? null : daysLeftWords(item.removed.at, now)
  return (
    <li ref={rows.row.ref(item.id)} className="heldrow">
      <span id={line}>{heldWords(item)}</span>
      <button
        ref={rows.toggle.ref(item.id)}
        type="button"
        className="act"
        aria-describedby={line}
        onClick={() => onToggle(item.id)}
      >
        {shown ? HIDE_IT : SHOW_IT}
      </button>
      {shown && (
        <div className="heldshown">
          <span>
            <time dateTime={item.created_at}>{formatTime(item.created_at, zone)}</time>
            {left !== null && ` · ${left}`}
          </span>
          <p>
            <Words words={item.body ?? ''} />
          </p>
        </div>
      )}
    </li>
  )
}
