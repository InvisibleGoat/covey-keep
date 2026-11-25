// The chat (CK-103 — the surface for CK-102's backend;
// decisions/2026-11-21-the-chat-who-reads-it-and-what-it-keeps.md §2, §4, §6,
// §7, §9, §10). Shapes mirror backend/app/api/chat.py's answers exactly — see
// reference/backend/api-reference.md, the Chat router. lib/outsideInvitations.ts
// is the model: calls answering an outcome, never the server's wording, and
// every line of copy here, the approved words as written.
//
// THE ANSWER DECIDES. Who runs the chat is `may_moderate`, on each answer;
// whether a removed message is drawn at all is whether the server sent one;
// nothing here compares roles or account ids.
//
// THE MERGE is one pure function over a map by id (`mergeChat`): the server's
// order, an id that left never coming back, a held message never replaced by a
// live copy of itself, and a check never adding something older than what is
// loaded.
//
// NOTHING IS STORED ON THE DEVICE and nothing is logged: no words, no name and
// no chat's id leave the page's own memory.
import { authFetch } from './api'
import { formatDay, formatDayWithYear, formatTime, instantToWallClock } from './datetime'
import { networkErrors } from './formErrors'
import type { GatheringWithOccurrences } from './gatherings'
import { memberCountLabel } from './groups'
import { REVOKE_REFUSED } from './invitations'
import { binDaysLeft } from './media'
import { possessive } from './possessive'
import { safeHttpUrl } from './url'

// --- types --------------------------------------------------------------------

export type ChatPlace = { kind: 'group' | 'gathering'; id: string }

export function placeKey(place: ChatPlace): string {
  return `${place.kind}:${place.id}`
}

// A removed message, for the people who run the chat alone: when, by whom,
// whether its writer deleted it, and whether the remover is the caller.
// `by_self` is optional because an older API answers without it (CK-103's
// deploy window).
export interface HeldBody {
  at: string
  by: string
  by_writer: boolean
  by_self?: boolean
}

export interface ChatItem {
  id: string
  kind: string
  created_at: string
  author: { display_name: string; is_self: boolean }
  body: string | null
  removed: HeldBody | null
}

// The first read and each page back, oldest first.
export interface ChatPage {
  items: ChatItem[]
  older: string | null
  as_of: string
  may_moderate: boolean
}

// A check: what is new or changed since, and the ids that left.
export interface ChatChanges {
  items: ChatItem[]
  removed: string[]
  truncated: boolean
  as_of: string
  may_moderate: boolean
}

// --- the checks' pace ----------------------------------------------------------

// Two seconds after an answer, five after one that failed; never two at once.
export const CHAT_POLL_MS = 2000
export const CHAT_RETRY_MS = 5000
// What a card reads once, to draw the newest three live entries.
export const PREVIEW_LIMIT = 20
export const PREVIEW_ENTRIES = 3

// --- the merge -----------------------------------------------------------------

type Position = { created_at: string; id: string }

export interface ChatList {
  byId: ReadonlyMap<string, ChatItem>
  // The ids that have left: no later answer brings one back.
  left: ReadonlySet<string>
  // The cursor for the page before, while there is one.
  older: string | null
  // Where what is loaded begins, while there is an earlier page: everything
  // at or after it is here. Kept apart from the items, so it stands when the
  // oldest one loaded is removed.
  from: Position | null
}

export const EMPTY_CHAT: ChatList = { byId: new Map(), left: new Set(), older: null, from: null }

export type ChatChange =
  // A first read, in place of whatever was there. `forgetLeft` where the
  // caller has come to run the chat: a message that left their view before
  // may be in this one as a held one.
  | { type: 'first'; items: ChatItem[]; older: string | null; forgetLeft?: boolean }
  | { type: 'check'; items: ChatItem[]; removed: string[] }
  | { type: 'earlier'; items: ChatItem[]; older: string | null }
  | { type: 'sent'; item: ChatItem }
  | { type: 'left'; id: string }
  // The caller no longer runs the chat: every held message goes.
  | { type: 'heldGone' }

// An instant as its whole second, in milliseconds, and its fraction to the
// microsecond as text. `Date.parse` alone keeps milliseconds, and the server
// writes a whole second with no fraction at all, so neither it nor a plain
// text comparison has the server's order.
const INSTANT = /^(.*?)(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/
const FRACTION = 9

function splitInstant(instant: string): { second: number; fraction: string } {
  const parts = INSTANT.exec(instant)
  if (parts === null) return { second: Date.parse(instant), fraction: '0'.repeat(FRACTION) }
  return {
    second: Date.parse(`${parts[1]}${parts[3]}`),
    fraction: (parts[2] ?? '').slice(0, FRACTION).padEnd(FRACTION, '0'),
  }
}

function textOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// The server's order: the instant, then the id.
export function compareEntries(a: Position, b: Position): number {
  const left = splitInstant(a.created_at)
  const right = splitInstant(b.created_at)
  return (
    left.second - right.second || textOrder(left.fraction, right.fraction) || textOrder(a.id, b.id)
  )
}

function oldestOf(items: ChatItem[]): Position | null {
  return items.reduce<ChatItem | null>(
    (oldest, item) => (oldest === null || compareEntries(item, oldest) < 0 ? item : oldest),
    null,
  )
}

// The one merge. It changes nothing it is given.
export function mergeChat(list: ChatList, change: ChatChange): ChatList {
  const byId = new Map(list.byId)
  const left = new Set(list.left)
  const put = (item: ChatItem) => {
    if (left.has(item.id)) return
    // A held message is never replaced by a live copy of itself: an answer
    // asked for before the removal can land after one asked for since.
    if (byId.get(item.id)?.removed && item.removed === null) return
    byId.set(item.id, item)
  }
  const leave = (id: string) => {
    byId.delete(id)
    left.add(id)
  }
  switch (change.type) {
    case 'first': {
      if (change.forgetLeft) left.clear()
      const fresh = new Set(change.items.map((item) => item.id))
      for (const id of [...byId.keys()]) if (!fresh.has(id)) byId.delete(id)
      change.items.forEach(put)
      return { byId, left, older: change.older, from: change.older === null ? null : oldestOf(change.items) }
    }
    case 'check':
      for (const item of change.items) {
        // Something older than what is loaded, while an earlier page exists,
        // only updates what is here: added, it would stand on its own above a
        // page nobody has asked for.
        if (list.from !== null && !byId.has(item.id) && compareEntries(item, list.from) < 0) continue
        put(item)
      }
      change.removed.forEach(leave)
      return { ...list, byId, left }
    case 'earlier':
      change.items.forEach(put)
      return { byId, left, older: change.older, from: change.older === null ? null : (oldestOf(change.items) ?? list.from) }
    case 'sent':
      put(change.item)
      return { ...list, byId, left }
    case 'left':
      leave(change.id)
      return { ...list, byId, left }
    case 'heldGone':
      for (const item of list.byId.values()) if (item.removed !== null) leave(item.id)
      return { ...list, byId, left }
  }
}

export function entriesOf(list: ChatList): ChatItem[] {
  return [...list.byId.values()].sort(compareEntries)
}

// The kinds this build can draw; anything else draws nothing.
const SETTING_KINDS: readonly string[] = ['outside_invitations_on', 'outside_invitations_off']

export function isMessage(item: ChatItem): boolean {
  return item.kind === 'message'
}
export function isSettingLine(item: ChatItem): boolean {
  return SETTING_KINDS.includes(item.kind)
}
export function canDraw(item: ChatItem): boolean {
  return isMessage(item) || item.kind === 'joined' || isSettingLine(item)
}

// The word a message carries in the chat: Delete on the reader's own, Remove
// on anyone else's for whoever runs it, none otherwise — never on a line, and
// never on a held message. `may_moderate` is the server's, on each answer.
export type Act = 'delete' | 'remove'

export function actOn(item: ChatItem, mayModerate: boolean): Act | null {
  if (!isMessage(item) || item.removed !== null) return null
  if (item.author.is_self) return 'delete'
  return mayModerate ? 'remove' : null
}

// --- the calls -----------------------------------------------------------------

export type ChatAnswer<T> = { status: 'ok'; value: T } | { status: 'notFound' } | { status: 'failed' }

function chatPath(place: ChatPlace): string {
  return place.kind === 'group' ? `/groups/${place.id}/chat` : `/gatherings/${place.id}/chat`
}

async function readAnswer<T>(path: string, notFound: (status: number) => boolean): Promise<ChatAnswer<T>> {
  try {
    const response = await authFetch(path)
    if (notFound(response.status)) return { status: 'notFound' }
    if (!response.ok) return { status: 'failed' }
    return { status: 'ok', value: (await response.json()) as T }
  } catch {
    return { status: 'failed' }
  }
}

// The newest page. A path 422 — an id that cannot name anything — is the same
// screen as a 404 from the reader's side (the house's rule); the read carries
// no other value the server could refuse.
export function readNewest(place: ChatPlace, limit?: number): Promise<ChatAnswer<ChatPage>> {
  const query = limit === undefined ? '' : `?limit=${limit}`
  return readAnswer<ChatPage>(`${chatPath(place)}${query}`, (status) => status === 404 || status === 422)
}

export function readEarlier(place: ChatPlace, before: string): Promise<ChatAnswer<ChatPage>> {
  return readAnswer<ChatPage>(
    `${chatPath(place)}?before=${encodeURIComponent(before)}`,
    (status) => status === 404,
  )
}

// What changed since the server's own instant, encoded: its offset's `+`
// reads as a space in a query.
export function checkChat(place: ChatPlace, since: string): Promise<ChatAnswer<ChatChanges>> {
  return readAnswer<ChatChanges>(
    `${chatPath(place)}?since=${encodeURIComponent(since)}`,
    (status) => status === 404,
  )
}

// The gathering behind a gathering's chat: its name, its cover, who is
// invited, and which view the caller holds.
export function readChatGathering(id: string): Promise<ChatAnswer<GatheringWithOccurrences>> {
  return readAnswer<GatheringWithOccurrences>(
    `/gatherings/${id}`,
    (status) => status === 404 || status === 422,
  )
}

export type SendOutcome =
  | { status: 'sent'; item: ChatItem }
  | { status: 'notFound' }
  | { status: 'refused'; reason: SendRefusal }
  // No answer came back, so it may have been written.
  | { status: 'unreachable' }

export type SendRefusal = 'too_long' | 'too_many' | 'other' | 'unreachable'

export async function sendMessage(place: ChatPlace, words: string): Promise<SendOutcome> {
  try {
    const response = await authFetch(chatPath(place), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: words }),
    })
    if (response.ok) return { status: 'sent', item: (await response.json()) as ChatItem }
    if (response.status === 404) return { status: 'notFound' }
    return { status: 'refused', reason: await refusalOf(response) }
  } catch {
    return { status: 'unreachable' }
  }
}

// The stable part of a refusal — a 422's type, a 429's code — never its words.
async function refusalOf(response: Response): Promise<SendRefusal> {
  let detail: unknown
  try {
    detail = ((await response.json()) as { detail?: unknown }).detail
  } catch {
    return 'other'
  }
  if (response.status === 422 && Array.isArray(detail)) {
    const tooLong = detail.some((entry) => (entry as { type?: unknown } | null)?.type === 'string_too_long')
    return tooLong ? 'too_long' : 'other'
  }
  return response.status === 429 && codeOf(detail) === 'too_many_messages' ? 'too_many' : 'other'
}

function codeOf(detail: unknown): unknown {
  return typeof detail === 'object' && detail !== null ? (detail as { code?: unknown }).code : undefined
}

// What is in the box once `sent` has landed. The box is open while a send
// waits, so the words that went come out of it, what was typed after them
// stays, and a box the person has rewritten is left as they have it.
export function stillToSend(box: string, sent: string): string {
  const words = box.trimStart()
  return words.startsWith(sent) ? words.slice(sent.length).trimStart() : box
}

// `removed` for a 204, and for the 409 that says someone already had: the same
// landing. `notFound` for a 404, where the message isn't there to remove.
export type RemoveOutcome = 'removed' | 'notFound' | 'refused' | 'unreachable'

export async function removeMessage(id: string): Promise<RemoveOutcome> {
  let response: Response
  try {
    response = await authFetch(`/messages/${id}/remove`, { method: 'POST' })
  } catch {
    return 'unreachable'
  }
  if (response.ok) return 'removed'
  if (response.status === 404) return 'notFound'
  if (response.status !== 409) return 'refused'
  try {
    const { detail } = (await response.json()) as { detail?: unknown }
    return codeOf(detail) === 'already_removed' ? 'removed' : 'refused'
  } catch {
    return 'refused'
  }
}

// --- the words: the record's §10, as written -------------------------------------

export const CHAT = 'Chat'
export const OPEN_CHAT = 'Open chat'
export const SEND = 'Send'
export const NO_MESSAGES = 'No messages yet.'
export const GATHERING_NOTICE = 'Everyone invited to this gathering can read this chat.'
export const ONLY_MEMBERS = "Only the group's members"

export function messageLabel(name: string): string {
  return `Message ${name}`
}

export function groupNotice(group: string): string {
  return `Only ${possessive(group)} members can read this chat. People who join later see it from the day they join.`
}

// The header's line: the number, where there is one.
export function groupChatLine(count: number | null | undefined): string {
  return count ? `${memberCountLabel(count)} · ${CHAT}` : CHAT
}
export function gatheringChatLine(invited: number | null | undefined): string {
  return invited ? `${invited} invited · ${CHAT}` : CHAT
}

const SEND_LINES: Record<SendRefusal, string> = {
  too_long: 'That message is too long. Shorten it and send again.',
  too_many: "That's a lot of messages in a minute. Wait a moment, then send it again.",
  other: 'Something went wrong. Nothing was sent — try again.',
  unreachable: networkErrors().form[0],
}
export function sendLine(reason: SendRefusal): string {
  return SEND_LINES[reason]
}

// --- the words: CK-103's kickoff, approved by Steven on 2026-11-24 ----------------

export const YOU = 'You'
export const DELETE = 'Delete'
export const REMOVE = 'Remove'
export const KEEP_IT = 'Keep it'
export const SHOW_IT = 'Show it'
export const HIDE_IT = 'Hide it'
export const DELETE_YOUR_MESSAGE = 'Delete your message'
export const DELETE_SENTENCE = 'Delete this message? It will leave the chat at once.'
export const TRY_AGAIN = 'Try again'
export const NOTHING_HERE = 'Nothing here'
export const NO_CHAT_HERE = "There's no chat to show at this address."
export const CHAT_FAILED = "This chat couldn't be loaded just now."
export const PREVIEW_FAILED = "The chat couldn't be loaded just now."
export const CHECKS_FAILING = "New messages couldn't be loaded just now. Still trying."
export const SHOW_EARLIER = 'Show earlier messages'
export const EARLIER_FAILED = "Earlier messages couldn't be loaded just now."
export const MESSAGES = 'Messages'

export function backTo(name: string): string {
  return `Back to ${name}`
}
export function newMessages(count: number): string {
  return `${count} new messages`
}

// A deleted account's person, as the API names them. In the middle of a line
// the words stand as they are; at the start of one they are capitalised.
export const FORMER_MEMBER = 'a former member'

export function isFormerMember(name: string): boolean {
  return name === FORMER_MEMBER
}
export function atStart(name: string): string {
  return isFormerMember(name) ? 'A former member' : name
}

export function removeSentence(name: string): string {
  return `Remove ${possessive(name)} message? It will leave the chat at once.`
}
export function removeLabel(name: string): string {
  return `Remove ${possessive(name)} message`
}

// A delete or a remove that failed: the house line, one copy, or the house's
// network line for a request that never arrived.
export function removeLine(outcome: 'refused' | 'unreachable'): string {
  return outcome === 'refused' ? REVOKE_REFUSED : networkErrors().form[0]
}

// A line the chat wrote. Null for one this build cannot say: a setting line
// with no group to name.
export function lineWords(item: ChatItem, group: string | null): string | null {
  const { display_name: name, is_self: self } = item.author
  const former = isFormerMember(name)
  if (item.kind === 'joined') {
    if (self) return 'You joined the group. You see the chat from today on.'
    if (former) return 'A former member joined the group.'
    return `${name} joined the group. ${name} sees the chat from today on.`
  }
  if (group === null || !isSettingLine(item)) return null
  const who = self ? YOU : atStart(name)
  const did = item.kind === 'outside_invitations_on' ? 'opened' : 'closed'
  return `${who} ${did} this gathering to people outside ${group}.`
}

// What happened to a held message. `by_self` is the server's; an older API
// answers without it, and then a removal of someone else's gives the name.
export function heldWords(item: ChatItem): string {
  const removed = item.removed
  if (removed === null) return ''
  const { display_name: name, is_self: own } = item.author
  if (removed.by_writer) return own ? 'You deleted a message' : `${atStart(name)} deleted a message`
  if (removed.by_self) return `You removed ${possessive(name)} message`
  return `${atStart(removed.by)} removed ${own ? 'your message' : `${possessive(name)} message`}`
}

// The days a held message has left, beside the time it was sent; null where
// there is nothing to count from.
export function daysLeftWords(removedAt: string, now: number): string | null {
  const days = binDaysLeft(removedAt, new Date(now))
  if (days === null) return null
  if (days === 0) return 'Less than a day left'
  return days === 1 ? '1 day left' : `${days} days left`
}

// What a check brought, said to a screen reader: a message's words with whose
// they are, or a line's own.
export function spoken(item: ChatItem, group: string | null): string | null {
  if (item.removed !== null) return null
  return isMessage(item) ? `${atStart(item.author.display_name)}: ${item.body ?? ''}` : lineWords(item, group)
}

// --- days, in the profile zone ------------------------------------------------------

// The day an instant falls on in `zone`, as 2026-11-24.
export function localDay(instant: string | number, zone: string): string {
  return instantToWallClock(new Date(instant).toISOString(), zone).slice(0, 10)
}

function dayNumber(day: string): number {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000)
}

// The line before the first entry of a day: Today, Yesterday, the weekday
// within the last six days, the date this year, the date with its year.
export function dayLine(instant: string, zone: string, now: number): string {
  const day = localDay(instant, zone)
  const today = localDay(now, zone)
  const ago = dayNumber(today) - dayNumber(day)
  if (ago === 0) return 'Today'
  if (ago === 1) return 'Yesterday'
  if (ago >= 2 && ago <= 6) {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'long' }).format(new Date(instant))
  }
  return day.slice(0, 4) === today.slice(0, 4) ? formatDay(instant, zone) : formatDayWithYear(instant, zone)
}

// A time in a preview: alone today, the day and the time otherwise.
export function previewTime(instant: string, zone: string, now: number): string {
  const time = formatTime(instant, zone)
  return localDay(instant, zone) === localDay(now, zone) ? time : `${dayLine(instant, zone, now)}, ${time}`
}

// --- links -----------------------------------------------------------------------

export type Piece = { text: string; href?: string }

const ADDRESS = /https?:\/\/[^\s<>"]+/gi
const TRAILING = /[.,;:!?'’”…)\]}]$/
const PAIRS: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

function count(text: string, char: string): number {
  return text.split(char).length - 1
}

// An address's end: punctuation that closes the sentence around it stays
// outside, and a closing bracket belongs to the address only where it opened
// one.
function trimAddress(address: string): string {
  let kept = address
  while (TRAILING.test(kept)) {
    const last = kept.slice(-1)
    const opener = PAIRS[last]
    if (opener !== undefined && count(kept, opener) >= count(kept, last)) break
    kept = kept.slice(0, -1)
  }
  return kept
}

// The words in pieces: an explicit http or https address is a link, through
// the one URL guard; everything else is text. Nothing here sets HTML.
export function linkPieces(words: string): Piece[] {
  const pieces: Piece[] = []
  let from = 0
  for (const match of words.matchAll(ADDRESS)) {
    const address = trimAddress(match[0])
    const href = safeHttpUrl(address)
    if (href === null) continue
    const at = match.index
    if (at > from) pieces.push({ text: words.slice(from, at) })
    pieces.push({ text: address, href })
    from = at + address.length
  }
  if (from < words.length) pieces.push({ text: words.slice(from) })
  return pieces
}
