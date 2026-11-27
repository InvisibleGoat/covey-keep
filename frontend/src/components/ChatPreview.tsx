// The Chat card on a group's page and on a gathering's in the full view
// (CK-103; THE DESIGN §10): a way into the chat, and its newest three entries.
//
// ONE READ, NEVER A CHECK. `limit=20` once, so three live ones can be found
// among held ones; the chat itself is where anything is followed, sent, deleted
// or removed. Never a held message, whoever runs the chat, and no control but a
// failed read's Try again: the box is a link and not a field.
//
// The answer is the place's own: one for another place counts as loading, so
// moving between two groups' pages draws nothing of the last. A 404 — or the
// 422 an id that names nothing draws — is no card at all.
import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  canDraw,
  CHAT,
  isMessage,
  lineWords,
  messageLabel,
  NO_MESSAGES,
  OPEN_CHAT,
  placeKey,
  PREVIEW_ENTRIES,
  PREVIEW_FAILED,
  PREVIEW_LIMIT,
  previewTime,
  readNewest,
  TRY_AGAIN,
  type ChatAnswer,
  type ChatItem,
  type ChatPage,
  type ChatPlace,
} from '../lib/chat'
import { isNew, useChatsNew } from '../lib/chatsNew'
import { ChatLine, MessageParts } from './ChatEntry'
import { Icon } from './Icons'
import { NewMark, NewWords } from './NewDot'
import { useFocusRequest } from './useFocusRequest'

type Read = { place: string; answer: ChatAnswer<ChatPage>; at: number }

// The newest three this build can draw, oldest first. `group` is the group a
// line may name.
function newest(items: ChatItem[], group: string | null): { item: ChatItem; words: string | null }[] {
  return items
    .filter((item) => item.removed === null && canDraw(item))
    .map((item) => ({ item, words: isMessage(item) ? null : lineWords(item, group) }))
    .filter(({ item, words }) => isMessage(item) || words !== null)
    .slice(-PREVIEW_ENTRIES)
}

export function ChatPreview({
  place,
  name,
  group,
  zone,
  line = null,
}: {
  place: ChatPlace
  name: string
  group: string | null
  zone: string
  // The line about who can see a group's gathering, for its members.
  line?: string | null
}) {
  const headingId = useId()
  const { kind, id } = place
  const lit = useChatsNew()
  const key = placeKey(place)
  const [read, setRead] = useState<Read | null>(null)
  const [attempt, setAttempt] = useState(0)
  const current = read?.place === key ? read : null
  const status = current?.answer.status ?? 'loading'

  useEffect(() => {
    let cancelled = false
    async function load() {
      const answer = await readNewest({ kind, id }, PREVIEW_LIMIT)
      if (!cancelled) setRead({ place: placeKey({ kind, id }), answer, at: Date.now() })
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [kind, id, attempt])

  // Try again (CK-96's rule): landing on the heading, failing again on the new
  // Try again. The marker is set by the press alone.
  const section = useRef<HTMLElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const tryAgain = useRef<HTMLButtonElement>(null)
  const retryOwed = useRef(false)
  const moveFocus = useFocusRequest(section)
  useEffect(() => {
    if (status === 'loading' || !retryOwed.current) return
    retryOwed.current = false
    moveFocus(status === 'failed' ? tryAgain : heading)
  }, [status, moveFocus])

  if (status === 'notFound') return null

  const to = kind === 'group' ? `/groups/${id}/chat` : `/gatherings/${id}/chat`
  const entries = current?.answer.status === 'ok' ? newest(current.answer.value.items, group) : null
  const fresh = isNew(lit, place)

  return (
    <section ref={section} className="auth-card chatprev" aria-labelledby={headingId}>
      <div className="chathead">
        <h2 ref={heading} id={headingId} tabIndex={-1}>
          {CHAT}
          {/* The dot (CK-105): read from the store, which the menu asks. */}
          {fresh && (
            <>
              <NewWords />
              <NewMark />
            </>
          )}
        </h2>
        <Link className="btn btn-small" to={to}>
          {OPEN_CHAT}
        </Link>
      </div>
      {line !== null && <p className="gline">{line}</p>}
      {status === 'loading' && <p>Loading…</p>}
      {status === 'failed' && (
        <div className="list-state">
          <p className="form-error" role="alert">
            <span aria-hidden="true">⚠ </span>
            {PREVIEW_FAILED}
          </p>
          <button
            ref={tryAgain}
            type="button"
            onClick={() => {
              retryOwed.current = true
              setRead(null)
              setAttempt((count) => count + 1)
            }}
          >
            {TRY_AGAIN}
          </button>
        </div>
      )}
      {entries !== null && entries.length === 0 && <p>{NO_MESSAGES}</p>}
      {current !== null && entries !== null && entries.length > 0 && (
        <ul className="msgs">
          {entries.map(({ item, words }) =>
            words === null ? (
              <MessageParts key={item.id} item={item} time={previewTime(item.created_at, zone, current.at)} />
            ) : (
              <ChatLine key={item.id} words={words} />
            ),
          )}
        </ul>
      )}
      <Link className="fakebox" to={to}>
        <Icon name="chat" />
        {messageLabel(name)}
      </Link>
    </section>
  )
}
