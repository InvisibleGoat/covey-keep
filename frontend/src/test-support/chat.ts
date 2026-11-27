// The chat, as a test stands it up (CK-103).
//
// withEmptyChat: a group's page and a gathering's read their chat once, for
// the card; a stub that answers everything else by hand answers that read
// empty through this one wrapper. The read never reaches the stub behind it,
// so what that stub records is what it recorded before.
//
// The builders: an entry, a held one, a page and a check's answer, in the
// shapes backend/app/api/chat.py writes.
import type { ChatChanges, ChatItem, ChatPage, HeldBody } from '../lib/chat'

const CHAT_READ = /^\/(?:groups|gatherings)\/[^/]+\/chat(?:\?.*)?$/

export const AS_OF = '2026-11-24T15:00:00.000000+00:00'

export function pathOf(input: unknown): string {
  return String(input).replace(/^https?:\/\/[^/]+/, '')
}

export function isChatRead(input: unknown, init?: { method?: string }): boolean {
  return (init?.method ?? 'GET') === 'GET' && CHAT_READ.test(pathOf(input))
}

// Since CK-105 the frame's menu reads GET /chats/new for the dot beside its
// own reads; this answers it with nothing new, so what the stub behind it
// records is still what it recorded before.
const CHATS_NEW = /^\/chats\/new$/

export function isChatsNewRead(input: unknown, init?: { method?: string }): boolean {
  return (init?.method ?? 'GET') === 'GET' && CHATS_NEW.test(pathOf(input))
}

export function withEmptyChat<A extends unknown[]>(
  stub: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return (...args: A) => {
    const init = args[1] as { method?: string } | undefined
    const body = isChatRead(args[0], init)
      ? chatPage([])
      : isChatsNewRead(args[0], init)
        ? { groups: [], gatherings: [] }
        : null
    if (body === null) return stub(...args)
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  }
}

export function chatItem(id: string, over: Partial<ChatItem> = {}): ChatItem {
  return {
    id,
    kind: 'message',
    created_at: '2026-11-24T14:00:00.000000+00:00',
    author: { display_name: 'Leo Brandt', is_self: false },
    body: `The words of ${id}`,
    removed: null,
    ...over,
  }
}

export function heldItem(item: ChatItem, over: Partial<HeldBody> = {}): ChatItem {
  return {
    ...item,
    removed: {
      at: '2026-11-24T14:30:00.000000+00:00',
      by: 'Ann Mercer',
      by_writer: false,
      by_self: false,
      ...over,
    },
  }
}

export function chatPage(items: ChatItem[], over: Partial<ChatPage> = {}): ChatPage {
  return { items, older: null, as_of: AS_OF, may_moderate: false, ...over }
}

export function chatChanges(items: ChatItem[] = [], over: Partial<ChatChanges> = {}): ChatChanges {
  return { items, removed: [], truncated: false, as_of: AS_OF, may_moderate: false, ...over }
}
