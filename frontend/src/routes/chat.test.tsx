// CK-103 — the two chats, through the app's real route table with the REAL
// AuthProvider over the real session store, the frame around them. The values
// under test: both pages whole, the header by kind and count, the notice by
// seat, the photos-only view asking nothing; no bar under 900px and the menu's
// column from it; what is drawn (days, messages, links, the chat's own lines, a
// former member); sending, each refusal by its code with the words kept, a lost
// answer settled both ways, and Enter by device; Delete and Remove by seat, each
// step's sentence the same in both places; a held message's row in each form,
// its words out of the page until Show it; the live region; nothing of a
// message in the address, storage or the console; and the moves between two
// chats. The device's clock is stopped and the profile's zone is forced to
// differ from the runner's.
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { formatTime } from '../lib/datetime'
import { chatItem, heldItem } from '../test-support/chat'
import {
  address,
  asked,
  box,
  chatOf,
  check,
  endWorld,
  go,
  LEO,
  live,
  ME,
  mine,
  NOW,
  openChatAt,
  quiet,
  renderApp,
  said,
  say,
  sendButton,
  stage,
  startWorld,
  stubScreen,
  takeOut,
  thread,
  type,
  world,
  ZONE,
} from '../test-support/chatWorld'
import { gate } from '../test-support/focus'

const GROUP = '/groups/g-1/chat'
const FINCH = '/groups/g-2/chat'
const DINNER = '/gatherings/x-1/chat'
const BOOK_CLUB = '/gatherings/x-2/chat'
const SURPRISE = '/gatherings/x-3/chat'
const PICNIC = '/gatherings/x-4/chat'

const g1 = () => chatOf('group:g-1')
const main = () => screen.getByRole('main')
const row = (text: string) => screen.getByText(text).closest('li')!
const button = (name: string | RegExp) => screen.getByRole<HTMLButtonElement>('button', { name })
const noButton = (name: string | RegExp) => screen.queryByRole('button', { name })
const flat = (words: string) => words.replace(/\s+/g, ' ').trim()
const text = (element: Element | null | undefined) => flat(element?.textContent ?? '')
const time = (item: { created_at: string }) => formatTime(item.created_at, ZONE)

beforeEach(() => startWorld())

afterEach(() => {
  cleanup()
  endWorld()
})

// --- the page ------------------------------------------------------------------

describe('a group’s chat', () => {
  test('whole: one main, one h1, the way back, the line, the notice, the messages and the box', async () => {
    g1().items = [said('a', 20, { body: 'Ten o’clock?' }), mine('b', 10, { body: 'I have the truck.' })]
    await openChatAt(GROUP)
    expect(screen.getAllByRole('main')).toHaveLength(1)
    const headings = screen.getAllByRole('heading')
    expect(headings.map((heading) => [heading.tagName, heading.textContent])).toEqual([['H1', 'The Lees']])
    expect(screen.getByRole('link', { name: 'Back to The Lees' }).getAttribute('href')).toBe('/groups/g-1')
    expect(screen.getByText('3 people · Chat')).toBeTruthy()
    expect(screen.getByText("Only The Lees' members can read this chat. People who join later see it from the day they join.")).toBeTruthy()
    const region = thread()
    expect(region.getAttribute('tabindex')).toBe('0')
    expect(screen.queryByRole('log')).toBeNull()
    const rows = within(region).getAllByRole('listitem')
    expect(text(rows[0])).toBe('Today')
    const parts = (one: Element) =>
      ['.avatar', '.by', 'time', 'button', '.bubble'].map((part) => {
        const found = one.querySelector(part)
        return found === null ? null : text(found)
      })
    expect(rows.slice(1).map(parts)).toEqual([
      ['LB', LEO, flat(time(g1().items[0])), null, 'Ten o’clock?'],
      [null, 'You', flat(time(g1().items[1])), 'Delete', 'I have the truck.'],
    ])
    expect(box().getAttribute('placeholder')).toBe('Message The Lees')
    expect(screen.getByRole('textbox', { name: 'Message The Lees' })).toBe(box())
    expect(box().hasAttribute('maxlength')).toBe(false)
    expect(sendButton().disabled).toBe(false)
    // Read once, together, and nothing else of the group's.
    expect(asked(/^\/groups\/g-1(\/|\?|$)/).map((call) => call.path)).toEqual(['/groups/g-1', '/groups/g-1/chat'])
  })

  test('its count, and Chat alone where there is none', async () => {
    await openChatAt(FINCH)
    expect(screen.getByText('1 person · Chat')).toBeTruthy()
    cleanup()
    world.groups['g-2'].member_count = 0
    await openChatAt(FINCH)
    expect(text(screen.getByRole('heading', { level: 1 }).nextElementSibling)).toBe('Chat')
  })

  test('a name the length of a screen is the heading’s whole text', async () => {
    const name = 'The Extremely Long Family Name Of Everyone On Both Sides'
    world.groups['g-1'].name = name
    await openChatAt(GROUP)
    expect(text(screen.getByRole('heading', { level: 1 }))).toContain(name)
    expect(screen.getByRole('link', { name: `Back to ${name}` })).toBeTruthy()
  })
})

describe('a gathering’s chat', () => {
  test('whole, for a member of its group', async () => {
    chatOf('gathering:x-1').items = [said('a', 20)]
    await openChatAt(DINNER)
    expect(screen.getAllByRole('main')).toHaveLength(1)
    expect(text(screen.getByRole('heading', { level: 1 }))).toContain('Dinner')
    expect(screen.getByRole('link', { name: 'Back to Dinner' }).getAttribute('href')).toBe('/gatherings/x-1')
    expect(screen.getByText('4 invited · Chat')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Message Dinner' })).toBeTruthy()
    expect(within(thread()).getByText('The words of a')).toBeTruthy()
    expect(asked(/^\/gatherings\/x-1(\/|\?|$)/).map((call) => call.path)).toEqual([
      '/gatherings/x-1',
      '/gatherings/x-1/chat',
    ])
    // Nothing of the group's is read for it.
    expect(asked(/^\/groups\/g-1/)).toEqual([])
  })

  test.each([
    ['null', null],
    ['0', 0],
    ['absent', undefined],
  ])('Chat alone where the count is %s', async (_name, invited) => {
    world.gatherings['x-1'].invited_count = invited
    await openChatAt(DINNER)
    expect(text(screen.getByRole('heading', { level: 1 }).nextElementSibling)).toBe('Chat')
  })

  test('the notice: a group’s member the line about who can see it, as the setting has it', async () => {
    await openChatAt(DINNER)
    expect(text(thread().querySelector('.notice'))).toBe(
      "Only people in The Lees can see this gathering for now. If people outside The Lees are invited, they'll see everything in it, including what's already there.",
    )
    cleanup()
    world.gatherings['x-1'].outside_invitations = { on: true, since: 'x', by: null, may_change: false }
    await openChatAt(DINNER)
    expect(text(thread().querySelector('.notice'))).toBe(
      'People outside The Lees can see this gathering and everything in it.',
    )
  })

  test('the notice: everyone else that everyone invited can read it', async () => {
    for (const at of [BOOK_CLUB, PICNIC]) {
      await openChatAt(at)
      expect(text(thread().querySelector('.notice'))).toBe('Everyone invited to this gathering can read this chat.')
      expect(text(thread())).not.toContain('The Lees')
      cleanup()
    }
  })

  test('the photos-only view has no chat at its address, and asks for none', async () => {
    renderApp(SURPRISE)
    expect(await screen.findByRole('heading', { level: 1, name: 'Nothing here' })).toBeTruthy()
    await quiet()
    expect(screen.getByText("There's no chat to show at this address.")).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Back to your gatherings' }).getAttribute('href')).toBe('/gatherings')
    expect(asked(/chat/)).toEqual([])
    expect(text(main())).not.toContain('Surprise')
  })
})

describe('no chat, and one that couldn’t be read', () => {
  test('a 404 is the not-found screen, with the way back by kind', async () => {
    renderApp('/groups/g-none/chat')
    expect(await screen.findByRole('heading', { level: 1, name: 'Nothing here' })).toBeTruthy()
    expect(screen.getByText("There's no chat to show at this address.")).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Back to your groups' }).getAttribute('href')).toBe('/groups')
    cleanup()
    renderApp('/gatherings/x-none/chat')
    expect(await screen.findByRole('link', { name: 'Back to your gatherings' })).toBeTruthy()
  })

  test('a failed first read says so, and Try again reads it again', async () => {
    g1().items = [said('a', 20)]
    stage('GET', /^\/groups\/g-1\/chat$/, { status: 500 })
    renderApp(GROUP)
    expect(await screen.findByRole('heading', { level: 1, name: 'Something went wrong' })).toBeTruthy()
    expect(text(screen.getByRole('alert'))).toContain("This chat couldn't be loaded just now.")
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(button('Try again'))
    expect(await screen.findByText('The words of a')).toBeTruthy()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })

  test('a 404 while it is open clears it', async () => {
    g1().items = [said('a', 20)]
    await openChatAt(GROUP)
    delete world.groups['g-1']
    await check()
    expect(text(screen.getByRole('heading', { level: 1 }))).toContain('Nothing here')
    expect(document.body.textContent).not.toContain('The words of a')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  test('a failed check leaves what is there, with a quiet line above the box until one lands', async () => {
    g1().items = [said('a', 20)]
    await openChatAt(GROUP)
    stage('GET', /since=/, { status: 500 })
    await check()
    const line = screen.getByText("New messages couldn't be loaded just now. Still trying.")
    expect(line.closest('[role="status"]')).not.toBeNull()
    expect(line.closest('[role="alert"]')).toBeNull()
    expect(line.compareDocumentPosition(box()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText('The words of a')).toBeTruthy()
    await check()
    expect(screen.queryByText(/Still trying/)).toBeNull()
  })

  test('No messages yet. only once the read has landed', async () => {
    const hold = gate()
    stage('GET', /^\/groups\/g-1\/chat$/, { hold })
    renderApp(GROUP)
    await screen.findByText('Loading…')
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))))
    expect(screen.queryByText('No messages yet.')).toBeNull()
    await act(async () => hold.release())
    expect(await screen.findByText('No messages yet.')).toBeTruthy()
    await quiet()
    say('group:g-1', said('a', 0))
    await check()
    expect(screen.queryByText('No messages yet.')).toBeNull()
  })
})

describe('the frame on a chat address', () => {
  test('under 900px neither bar is there, on either chat, and both are on the page it came from', async () => {
    for (const at of [GROUP, DINNER, `${GROUP}/`]) {
      await openChatAt(at)
      expect(document.querySelector('.topbar')).toBeNull()
      expect(document.querySelector('.tabbar')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Open menu' })).toBeNull()
      expect(screen.queryByRole('navigation', { name: 'Sections' })).toBeNull()
      cleanup()
    }
    await openChatAt(GROUP)
    await go('/groups/g-1')
    expect(await screen.findByRole('button', { name: 'Open menu' })).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'Sections' })).toBeTruthy()
  })

  test('the not-found screen at a chat address has none either', async () => {
    renderApp(SURPRISE)
    await screen.findByRole('heading', { level: 1, name: 'Nothing here' })
    expect(document.querySelector('.topbar')).toBeNull()
    expect(document.querySelector('.tabbar')).toBeNull()
  })

  test('from 900px the menu’s column stays', async () => {
    stubScreen({ wide: true })
    await openChatAt(GROUP)
    const nav = screen.getByRole('navigation', { name: 'Main' })
    expect(within(nav).getByRole('link', { name: 'Groups' }).getAttribute('aria-current')).toBe('page')
    expect(document.querySelector('.frame-side')!.hasAttribute('inert')).toBe(false)
    cleanup()
    await openChatAt(DINNER)
    expect(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Gatherings' }).getAttribute('aria-current')).toBe('page')
  })

  test('a signed-out visit is turned away and comes back to it', async () => {
    const { clearToken } = await import('../lib/session')
    clearToken()
    renderApp(GROUP)
    await waitFor(() => expect(address).toBe('/'))
    expect(JSON.stringify({ ...sessionStorage, ...localStorage })).toContain('/groups/g-1/chat')
  })
})

// --- what is drawn ---------------------------------------------------------------

describe('what is drawn', () => {
  test('day lines before the first entry of each day, in the profile’s zone, following midnight on the next check', async () => {
    const day = 24 * 60
    g1().items = [
      said('old', 400 * day),
      said('weeks', 30 * day),
      said('week', 4 * day),
      said('yesterday', day),
      said('yesterday-too', day - 1),
      said('today', 10),
    ]
    await openChatAt(GROUP)
    const labels = () => [...thread().querySelectorAll('.dayline')].map(text)
    // Kiritimati is the next day's small hours; Honolulu this one's.
    const weekday = ZONE === 'Pacific/Honolulu' ? 'Friday' : 'Saturday'
    const [old, weeks] = ZONE === 'Pacific/Honolulu' ? ['Oct 20, 2025', 'Oct 25'] : ['Oct 21, 2025', 'Oct 26']
    expect(labels()).toEqual([old, weeks, weekday, 'Yesterday', 'Today'])
    vi.setSystemTime(NOW + day * 60_000)
    await check()
    expect(labels()[4]).toBe('Yesterday')
  })

  test('words keep their line breaks and an explicit address is a link, and nothing is HTML', async () => {
    g1().items = [
      said('a', 5, { body: 'First line\nsecond <b>bold</b> https://example.com/a?b=1. (http://example.org)' }),
      said('b', 4, { body: 'javascript:alert(1) example.com www.example.com' }),
    ]
    await openChatAt(GROUP)
    const bubble = thread().querySelectorAll('.bubble')
    expect(bubble[0].textContent).toBe(
      'First line\nsecond <b>bold</b> https://example.com/a?b=1. (http://example.org)',
    )
    expect(bubble[0].querySelector('b')).toBeNull()
    const links = within(thread()).getAllByRole('link')
    expect(links.map((link) => [link.getAttribute('href'), link.getAttribute('target'), link.getAttribute('rel')])).toEqual([
      ['https://example.com/a?b=1', '_blank', 'noreferrer'],
      ['http://example.org', '_blank', 'noreferrer'],
    ])
    expect(bubble[1].querySelector('a')).toBeNull()
  })

  test('the lines the chat wrote, with no word beside them', async () => {
    chatOf('gathering:x-1').moderate = true
    chatOf('gathering:x-1').items = [
      said('on', 9, { kind: 'outside_invitations_on', body: null }),
      said('off', 8, {
        kind: 'outside_invitations_off',
        body: null,
        author: { display_name: ME, is_self: true },
      }),
    ]
    await openChatAt(DINNER)
    expect([...thread().querySelectorAll('.sysline')].map(text)).toEqual([
      'Leo Brandt opened this gathering to people outside The Lees.',
      'You closed this gathering to people outside The Lees.',
    ])
    expect(noButton(/Delete|Remove/)).toBeNull()
    cleanup()
    g1().moderate = true
    g1().items = [
      said('j', 9, { kind: 'joined', body: null }),
      said('m', 8, { kind: 'joined', body: null, author: { display_name: ME, is_self: true } }),
      said('f', 7, { kind: 'joined', body: null, author: { display_name: 'a former member', is_self: false } }),
    ]
    await openChatAt(GROUP)
    expect([...thread().querySelectorAll('.sysline')].map(text)).toEqual([
      'Leo Brandt joined the group. Leo Brandt sees the chat from today on.',
      'You joined the group. You see the chat from today on.',
      'A former member joined the group.',
    ])
    expect(noButton(/Delete|Remove/)).toBeNull()
  })

  test('a former member: capitalised in the head, no letters in the avatar', async () => {
    g1().items = [said('a', 5, { author: { display_name: 'a former member', is_self: false } })]
    await openChatAt(GROUP)
    const message = row('The words of a')
    expect(text(message.querySelector('.by'))).toBe('A former member')
    expect(message.querySelector('.avatar')!.getAttribute('aria-hidden')).toBe('true')
    expect(text(message.querySelector('.avatar'))).toBe('')
  })

  test('your own has no avatar; a time is its own element with its instant', async () => {
    g1().items = [said('a', 6), mine('b', 5)]
    await openChatAt(GROUP)
    expect(text(row('The words of a').querySelector('.avatar'))).toBe('LB')
    expect(row('The words of b').querySelector('.avatar')).toBeNull()
    expect(text(row('The words of b').querySelector('.by'))).toBe('You')
    expect(row('The words of b').querySelector('time')?.getAttribute('datetime')).toBe(g1().items[1].created_at)
  })

  test('a kind this build does not know draws nothing', async () => {
    g1().items = [said('p', 9, { kind: 'photos_added', body: null })]
    await openChatAt(GROUP)
    expect(thread().querySelectorAll('li')).toHaveLength(0)
    expect(screen.getByText('No messages yet.')).toBeTruthy()
  })

  test('a setting line that arrives moves the notice with it', async () => {
    await openChatAt(DINNER)
    world.gatherings['x-1'].outside_invitations = { on: true, since: 'x', by: LEO, may_change: false }
    say('gathering:x-1', said('on', 0, { kind: 'outside_invitations_on', body: null }))
    await check()
    expect(text(thread().querySelector('.notice'))).toBe(
      'People outside The Lees can see this gathering and everything in it.',
    )
  })
})

describe('earlier messages', () => {
  test('a press loads the page before, and the button goes with the last of them', async () => {
    g1().page = 2
    g1().items = [said('a', 5), said('b', 4), said('c', 3)]
    await openChatAt(GROUP)
    expect(screen.queryByText('The words of a')).toBeNull()
    const show = button('Show earlier messages')
    // Under the notice and above the messages.
    expect(thread().querySelector('.notice')!.compareDocumentPosition(show) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(show)
    expect(await screen.findByText('The words of a')).toBeTruthy()
    expect(asked(/before=/)).toHaveLength(1)
    expect(noButton('Show earlier messages')).toBeNull()
  })

  test('a failure is a line beside the button', async () => {
    g1().page = 1
    g1().items = [said('a', 5), said('b', 4)]
    stage('GET', /before=/, { status: 500 })
    await openChatAt(GROUP)
    fireEvent.click(button('Show earlier messages'))
    expect(await screen.findByText("Earlier messages couldn't be loaded just now.")).toBeTruthy()
    fireEvent.click(button('Show earlier messages'))
    expect(await screen.findByText('The words of a')).toBeTruthy()
    expect(screen.queryByText(/Earlier messages couldn't/)).toBeNull()
  })
})

// --- sending ----------------------------------------------------------------------

describe('sending', () => {
  test('posts the words, trimmed, waits with them read-only, then clears the box', async () => {
    const hold = gate()
    stage('POST', /chat$/, { hold })
    await openChatAt(GROUP)
    type('  Ten o’clock?\n')
    fireEvent.click(sendButton())
    await waitFor(() => expect(sendButton().disabled).toBe(true))
    expect([box().value, box().readOnly]).toEqual(['  Ten o’clock?\n', true])
    expect(document.activeElement).toBe(box())
    expect(screen.queryByText('Ten o’clock?', { selector: '.bubble' })).toBeNull()
    await act(async () => hold.release())
    await waitFor(() => expect(box().value).toBe(''))
    expect(asked(/chat$/, 'POST').map((call) => call.body)).toEqual([{ body: 'Ten o’clock?' }])
    expect([box().readOnly, sendButton().disabled]).toEqual([false, false])
    expect(row('Ten o’clock?').classList.contains('me')).toBe(true)
    expect(document.activeElement).toBe(box())
  })

  test('blank sends nothing', async () => {
    await openChatAt(GROUP)
    for (const blank of ['', '  \n ']) {
      type(blank)
      fireEvent.click(sendButton())
    }
    await quiet()
    expect(asked(/chat$/, 'POST')).toEqual([])
  })

  test('a press on Send never takes focus from the box', async () => {
    await openChatAt(GROUP)
    box().focus()
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    act(() => void sendButton().dispatchEvent(press))
    expect(press.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(box())
  })

  test.each([
    [422, { detail: [{ type: 'string_too_long', loc: ['body', 'body'] }] }, 'That message is too long. Shorten it and send again.'],
    [422, { detail: [{ type: 'value_error', loc: ['body', 'body'] }] }, 'Something went wrong. Nothing was sent — try again.'],
    [429, { detail: { code: 'too_many_messages', message: 'x' } }, "That's a lot of messages in a minute. Wait a moment, then send it again."],
    [500, {}, 'Something went wrong. Nothing was sent — try again.'],
  ])('a %i keeps the words, with its line beneath the box until the next keystroke', async (status, body, line) => {
    stage('POST', /chat$/, { status, body })
    await openChatAt(GROUP)
    type('Hello')
    fireEvent.click(sendButton())
    const alert = await screen.findByRole('alert')
    expect(text(alert)).toContain(line)
    expect([box().value, box().readOnly]).toEqual(['Hello', false])
    expect(document.activeElement).toBe(box())
    expect(box().getAttribute('aria-describedby')).toBe(alert.id)
    expect(box().compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    type('Hello again')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(box().hasAttribute('aria-describedby')).toBe(false)
  })

  test('one that never arrived checks at once, and was sent where the check brings it', async () => {
    stage('POST', /chat$/, { network: true })
    await openChatAt(GROUP)
    const before = asked(/since=/).length
    say('group:g-1', mine('m', 0, { body: 'Hello' }))
    type('Hello')
    fireEvent.click(sendButton())
    await waitFor(() => expect(box().value).toBe(''))
    expect(asked(/since=/).length).toBe(before + 1)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(within(thread()).getByText('Hello')).toBeTruthy()
  })

  test('one that never arrived, and that the check does not bring, keeps the words with the network’s line', async () => {
    stage('POST', /chat$/, { network: true })
    await openChatAt(GROUP)
    type('Hello')
    fireEvent.click(sendButton())
    expect(text(await screen.findByRole('alert'))).toContain("Couldn't reach the server. Check your connection and try again.")
    expect(box().value).toBe('Hello')
    // A later check that brings it clears both.
    say('group:g-1', mine('m', 0, { body: 'Hello' }))
    await check()
    expect(box().value).toBe('')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  test('and clears neither where the words have been changed', async () => {
    stage('POST', /chat$/, { network: true })
    await openChatAt(GROUP)
    type('Hello')
    fireEvent.click(sendButton())
    await screen.findByRole('alert')
    type('Hello there')
    say('group:g-1', mine('m', 0, { body: 'Hello' }))
    await check()
    expect(box().value).toBe('Hello there')
  })

  const enter = (init: Record<string, unknown> = {}) =>
    fireEvent.keyDown(box(), { key: 'Enter', code: 'Enter', keyCode: 13, ...init })

  test('Enter sends where the pointer hovers and is fine, and Shift+Enter is a line', async () => {
    stubScreen({ hover: true })
    await openChatAt(GROUP)
    type('Hello')
    expect(enter({ shiftKey: true })).toBe(true)
    await quiet()
    expect(asked(/chat$/, 'POST')).toEqual([])
    expect(enter()).toBe(false)
    await waitFor(() => expect(box().value).toBe(''))
    expect(asked(/chat$/, 'POST')).toHaveLength(1)
  })

  test('Enter is a line on a touch device', async () => {
    await openChatAt(GROUP)
    type('Hello')
    expect(enter()).toBe(true)
    await quiet()
    expect(asked(/chat$/, 'POST')).toEqual([])
  })

  test('Enter never sends while an input method is composing', async () => {
    stubScreen({ hover: true })
    await openChatAt(GROUP)
    type('Hello')
    expect(enter({ isComposing: true })).toBe(true)
    expect(enter({ keyCode: 229 })).toBe(true)
    await quiet()
    expect(asked(/chat$/, 'POST')).toEqual([])
  })
})

// --- deleting and removing -----------------------------------------------------------

describe('deleting and removing', () => {
  function both() {
    g1().items = [said('theirs', 6), mine('own', 5)]
  }

  test('Delete on your own alone, for someone who does not run the chat', async () => {
    both()
    await openChatAt(GROUP)
    expect(text(within(row('The words of own')).getByRole('button', { name: 'Delete your message' }))).toContain('Delete')
    expect(within(row('The words of theirs')).queryByRole('button')).toBeNull()
  })

  test('Remove on anyone else’s for whoever runs it, Delete still on your own', async () => {
    both()
    g1().moderate = true
    await openChatAt(GROUP)
    expect(text(within(row('The words of theirs')).getByRole('button', { name: "Remove Leo Brandt's message" }))).toContain('Remove')
    expect(within(row('The words of own')).getByRole('button', { name: 'Delete your message' })).toBeTruthy()
    expect(within(thread()).getAllByRole('button')).toHaveLength(2)
  })

  test.each([
    ['a group’s', GROUP, 'group:g-1'],
    ['a gathering’s', BOOK_CLUB, 'gathering:x-2'],
  ])('each step’s sentence and buttons, in %s chat', async (_name, at, key) => {
    chatOf(key).moderate = true
    chatOf(key).items = [said('theirs', 6, { author: { display_name: 'James', is_self: false } }), mine('own', 5)]
    await openChatAt(at)
    fireEvent.click(button('Delete your message'))
    let step = screen.getByRole('group', { name: 'Delete this message? It will leave the chat at once.' })
    expect(within(step).getAllByRole('button').map(text)).toEqual(['Delete', 'Keep it'])
    expect(text(step)).toBe('Delete this message? It will leave the chat at once.DeleteKeep it')
    // One step at a time.
    fireEvent.click(button("Remove James' message"))
    step = screen.getByRole('group', { name: "Remove James' message? It will leave the chat at once." })
    expect(within(step).getAllByRole('button').map(text)).toEqual(['Remove', 'Keep it'])
    expect(screen.getAllByRole('group')).toHaveLength(1)
    fireEvent.click(within(step).getByRole('button', { name: 'Keep it' }))
    expect(screen.queryByRole('group')).toBeNull()
    await quiet()
    expect(asked(/remove$/, 'POST')).toEqual([])
  })

  test('a former member’s message is removed by those words', async () => {
    g1().moderate = true
    g1().items = [said('a', 5, { author: { display_name: 'a former member', is_self: false } })]
    await openChatAt(GROUP)
    fireEvent.click(button("Remove a former member's message"))
    expect(screen.getByRole('group', { name: "Remove a former member's message? It will leave the chat at once." })).toBeTruthy()
  })

  async function press(word: string, confirm: string) {
    fireEvent.click(button(word))
    const step = screen.getByRole('group')
    fireEvent.click(within(step).getByRole('button', { name: confirm }))
  }

  test('a 204 takes it out at once for someone who does not run the chat, and no check brings it back', async () => {
    both()
    await openChatAt(GROUP)
    const own = g1().items[1]
    await press('Delete your message', 'Delete')
    await waitFor(() => expect(screen.queryByText('The words of own')).toBeNull())
    expect(asked(/remove$/, 'POST').map((call) => call.path)).toEqual(['/messages/own/remove'])
    expect(asked(/since=/)).toEqual([])
    g1().changes.push(own)
    await check()
    expect(screen.queryByText('The words of own')).toBeNull()
    expect(thread().querySelector('.heldrow')).toBeNull()
  })

  test('for someone who runs it the step waits for the check, and the message becomes its held row, closed', async () => {
    both()
    g1().moderate = true
    const hold = gate()
    await openChatAt(GROUP)
    stage('GET', /since=/, { hold })
    await press("Remove Leo Brandt's message", 'Remove')
    await waitFor(() => expect(asked(/since=/)).toHaveLength(1))
    // The check the act asked for has not landed: the step waits.
    const step = screen.getByRole('group')
    expect(within(step).getAllByRole('button').map((one) => (one as HTMLButtonElement).disabled)).toEqual([true, true])
    expect(screen.getByText('The words of theirs')).toBeTruthy()
    await act(async () => hold.release())
    await waitFor(() => expect(screen.queryByRole('group')).toBeNull())
    expect(text(thread().querySelector('.heldrow'))).toBe("You removed Leo Brandt's messageShow it")
    expect(document.body.textContent).not.toContain('The words of theirs')
  })

  test('someone had already removed it: the same landing', async () => {
    both()
    g1().moderate = true
    await openChatAt(GROUP)
    takeOut('group:g-1', 'theirs', { by: 'Kelly Brandt', by_self: false })
    stage('POST', /remove$/, { status: 409, body: { detail: { code: 'already_removed' } } })
    await press("Remove Leo Brandt's message", 'Remove')
    await waitFor(() =>
      expect(text(thread().querySelector('.heldrow'))).toBe("Kelly Brandt removed Leo Brandt's messageShow it"),
    )
  })

  test('a 404 takes it out', async () => {
    both()
    g1().moderate = true
    await openChatAt(GROUP)
    stage('POST', /remove$/, { status: 404 })
    await press("Remove Leo Brandt's message", 'Remove')
    await waitFor(() => expect(screen.queryByText('The words of theirs')).toBeNull())
    expect(thread().querySelector('.heldrow')).toBeNull()
  })

  test.each([
    ['a 500', { status: 500 }, 'Something went wrong. Nothing changed — try again.'],
    ['a 409 of another code', { status: 409, body: { detail: { code: 'not_a_message' } } }, 'Something went wrong. Nothing changed — try again.'],
    ['one that never arrived', { network: true }, "Couldn't reach the server. Check your connection and try again."],
  ])('%s leaves the message, with the line in the step', async (_name, how, line) => {
    both()
    await openChatAt(GROUP)
    stage('POST', /remove$/, how)
    await press('Delete your message', 'Delete')
    const alert = await within(screen.getByRole('group')).findByRole('alert')
    expect(text(alert)).toContain(line)
    expect(screen.getByText('The words of own')).toBeTruthy()
    expect(button('Delete').disabled).toBe(false)
    // Trying again drops the line and lands.
    fireEvent.click(button('Delete'))
    await waitFor(() => expect(screen.queryByText('The words of own')).toBeNull())
  })

  test('a step closes as its message goes, and a check leaves another’s open', async () => {
    both()
    g1().moderate = true
    g1().items.push(said('third', 4))
    await openChatAt(GROUP)
    fireEvent.click(within(row('The words of theirs')).getByRole('button', { name: /^Remove/ }))
    takeOut('group:g-1', 'third', { by: 'Kelly Brandt', by_self: false })
    await check()
    expect(screen.getByRole('group')).toBeTruthy()
    takeOut('group:g-1', 'theirs', { by: 'Kelly Brandt', by_self: false })
    await check()
    expect(screen.queryByRole('group')).toBeNull()
    expect(thread().querySelectorAll('.heldrow')).toHaveLength(2)
  })

  test('Remove goes with the role, and its step with it', async () => {
    both()
    g1().moderate = true
    await openChatAt(GROUP)
    fireEvent.click(button("Remove Leo Brandt's message"))
    g1().moderate = false
    await check()
    expect(screen.queryByRole('group')).toBeNull()
    expect(noButton(/^Remove/)).toBeNull()
    expect(button('Delete your message')).toBeTruthy()
  })
})

// --- a held message --------------------------------------------------------------------

describe('a held message', () => {
  const LIVE = said('a', 30, { body: 'Bring the long table.' })

  async function openHeld(item = heldItem(LIVE), at = GROUP, key = 'group:g-1') {
    chatOf(key).moderate = true
    chatOf(key).items = [item, said('b', 5)]
    await openChatAt(at)
  }
  const held = () => thread().querySelector<HTMLElement>('.heldrow')!

  test.each([
    ['its writer', heldItem(LIVE, { by: LEO, by_writer: true }), 'Leo Brandt deleted a message'],
    ['you, your own', heldItem(mine('a', 30), { by: ME, by_writer: true, by_self: true }), 'You deleted a message'],
    ['you, someone’s', heldItem(LIVE, { by: ME, by_self: true }), "You removed Leo Brandt's message"],
    ['someone, someone’s', heldItem(LIVE, { by: 'Kelly Brandt' }), "Kelly Brandt removed Leo Brandt's message"],
    ['someone, yours', heldItem(mine('a', 30), { by: 'Kelly Brandt' }), 'Kelly Brandt removed your message'],
    [
      'a writer whose account has gone',
      heldItem(said('a', 30, { author: { display_name: 'a former member', is_self: false } }), { by: 'a former member', by_writer: true }),
      'A former member deleted a message',
    ],
    [
      'you, a former member’s',
      heldItem(said('a', 30, { author: { display_name: 'a former member', is_self: false } }), { by: ME, by_self: true }),
      "You removed a former member's message",
    ],
    ['a remover whose account has gone', heldItem(LIVE, { by: 'a former member' }), "A former member removed Leo Brandt's message"],
  ])('by %s: its line, closed, with no word and no avatar', async (_name, item, line) => {
    await openHeld(item)
    expect(text(held())).toBe(`${line}Show it`)
    expect(held().querySelector('.avatar')).toBeNull()
    expect(within(held()).getAllByRole('button').map(text)).toEqual(['Show it'])
    cleanup()
    // The same in a gathering's chat.
    await openHeld(item, BOOK_CLUB, 'gathering:x-2')
    expect(text(held())).toBe(`${line}Show it`)
  })

  test('its words are out of the page until Show it, and out again on Hide it', async () => {
    await openHeld()
    expect(document.body.innerHTML).not.toContain('Bring the long table.')
    const toggle = within(held()).getByRole('button', { name: 'Show it' })
    expect(toggle.getAttribute('aria-describedby')).toBe(
      within(held()).getByText("Ann Mercer removed Leo Brandt's message").id,
    )
    fireEvent.click(toggle)
    expect(within(held()).getByRole('button', { name: 'Hide it' })).toBe(toggle)
    expect(within(held()).getByText('Bring the long table.')).toBeTruthy()
    // The time it was sent with the days left, then the words.
    expect(text(held().querySelector('.heldshown'))).toBe(
      flat(`${time(LIVE)} · 30 days leftBring the long table.`),
    )
    expect(held().querySelector('.heldshown time')!.getAttribute('datetime')).toBe(LIVE.created_at)
    expect(held().querySelector('.bubble')).toBeNull()
    fireEvent.click(toggle)
    expect(text(toggle)).toBe('Show it')
    expect(document.body.innerHTML).not.toContain('Bring the long table.')
  })

  test('its words are drawn as any message’s are: a link, line breaks', async () => {
    await openHeld(heldItem({ ...LIVE, body: 'See https://example.com/x.' }))
    fireEvent.click(button('Show it'))
    expect(within(held()).getByRole('link').getAttribute('href')).toBe('https://example.com/x')
  })

  test.each([
    [29, '1 day left'],
    [29.5, 'Less than a day left'],
    [20, '10 days left'],
  ])('%s days in, what is left', async (daysAgo, words) => {
    await openHeld(heldItem(LIVE, { at: new Date(NOW - daysAgo * 86_400_000).toISOString() }))
    fireEvent.click(button('Show it'))
    expect(text(held().querySelector('.heldshown'))).toContain(`· ${words}`)
  })

  test('a check leaves a shown one shown, and opens none', async () => {
    g1().items.push(said('c', 4))
    await openHeld()
    g1().items.push(said('c', 4))
    fireEvent.click(button('Show it'))
    say('group:g-1', said('new', 0))
    takeOut('group:g-1', 'b')
    await check()
    expect(screen.getByText('Bring the long table.')).toBeTruthy()
    const rows = [...thread().querySelectorAll('.heldrow')]
    expect(rows.map((one) => text(one.querySelector('button')))).toEqual(['Hide it', 'Show it'])
  })

  test('it goes when the role does, its words with it, and is closed where it comes back', async () => {
    await openHeld()
    fireEvent.click(button('Show it'))
    g1().moderate = false
    await check()
    expect(thread().querySelector('.heldrow')).toBeNull()
    expect(document.body.innerHTML).not.toContain('Bring the long table.')
    expect(screen.getByText('The words of b')).toBeTruthy()
    g1().moderate = true
    await check()
    expect(text(held().querySelector('button'))).toBe('Show it')
    expect(document.body.innerHTML).not.toContain('Bring the long table.')
  })

  test('nobody who is not sent one sees anything of it', async () => {
    g1().items = [heldItem(LIVE), said('b', 5)]
    await openChatAt(GROUP)
    expect(thread().querySelector('.heldrow')).toBeNull()
    takeOut('group:g-1', 'b')
    await check()
    expect(thread().querySelectorAll('li')).toHaveLength(0)
    expect(screen.getByText('No messages yet.')).toBeTruthy()
  })

  test('it stands in its place in the order', async () => {
    g1().moderate = true
    g1().items = [said('first', 40), heldItem(LIVE), said('last', 5)]
    await openChatAt(GROUP)
    const rows = [...thread().querySelectorAll('li:not(.dayline)')]
    expect(rows.map((one) => one.className.includes('heldrow'))).toEqual([false, true, false])
  })
})

// --- a screen reader ------------------------------------------------------------------

describe('what a screen reader is told', () => {
  const told = () => [...(live()?.querySelectorAll('p') ?? [])].map(text)

  test('one polite region, there from the first render and empty through the first read, an earlier page and your own send', async () => {
    g1().page = 1
    g1().items = [said('a', 6), said('b', 5)]
    const hold = gate()
    stage('GET', /^\/groups\/g-1\/chat$/, { hold })
    renderApp(GROUP)
    await screen.findByText('Loading…')
    const region = live()
    expect(region).not.toBeNull()
    expect(document.querySelectorAll('[aria-live]')).toHaveLength(1)
    expect(region!.classList.contains('visually-hidden')).toBe(true)
    await act(async () => hold.release())
    await screen.findByText('The words of b')
    expect([live() === region, told()]).toEqual([true, []])
    fireEvent.click(button('Show earlier messages'))
    await screen.findByText('The words of a')
    type('Mine')
    fireEvent.click(sendButton())
    await waitFor(() => expect(box().value).toBe(''))
    await check()
    expect([live() === region, told()]).toEqual([true, []])
  })

  test('what a check brought from other people, once, and a line’s own words', async () => {
    await openChatAt(GROUP)
    say('group:g-1', said('a', 0, { body: 'Ten works.' }))
    say('group:g-1', said('j', 0, { kind: 'joined', body: null, author: { display_name: 'Kelly Brandt', is_self: false } }))
    say('group:g-1', mine('m', 0, { body: 'From my other window' }))
    await check()
    expect(told()).toEqual([
      'Leo Brandt: Ten works.',
      'Kelly Brandt joined the group. Kelly Brandt sees the chat from today on.',
    ])
    const said1 = live()!.querySelector('p')
    await check()
    // The same elements: nothing is said twice.
    expect(live()!.querySelector('p')).toBe(said1)
    say('group:g-1', said('b', 0, { body: 'Bring coffee.' }))
    await check()
    expect(told()).toEqual(['Leo Brandt: Bring coffee.'])
  })

  test('more than three at once is a number', async () => {
    await openChatAt(GROUP)
    for (const n of [1, 2, 3]) say('group:g-1', said(`a${n}`, 0))
    await check()
    expect(told()).toHaveLength(3)
    for (const n of [1, 2, 3, 4]) say('group:g-1', said(`b${n}`, 0))
    await check()
    expect(told()).toEqual(['4 new messages'])
  })

  test('a message that has left is out of it too', async () => {
    await openChatAt(GROUP)
    say('group:g-1', said('a', 0, { body: 'Ten works.' }))
    await check()
    expect(document.body.textContent).toContain('Ten works.')
    takeOut('group:g-1', 'a')
    await check()
    expect(document.body.textContent).not.toContain('Ten works.')
  })
})

// --- what leaves the page ---------------------------------------------------------------

describe('what leaves the page', () => {
  test('no word, name or id of a message in the address, storage or the console', async () => {
    const said1: unknown[] = []
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args) => void said1.push(args))
    }
    g1().moderate = true
    g1().items = [said('secret-id', 6, { body: 'Bring the long table.' }), mine('own-id', 5)]
    await openChatAt(GROUP)
    type('An unsent draft')
    stage('POST', /chat$/, { network: true })
    fireEvent.click(sendButton())
    await screen.findByRole('alert')
    stage('POST', /remove$/, { status: 500 })
    fireEvent.click(button("Remove Leo Brandt's message"))
    fireEvent.click(within(screen.getByRole('group')).getByRole('button', { name: 'Remove' }))
    await within(screen.getByRole('group')).findByRole('alert')
    say('group:g-1', said('third-id', 0, { body: 'Ten works.' }))
    await check()
    const kept = [address, JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage }), JSON.stringify(said1)]
    for (const place of kept) {
      for (const bit of ['long table', 'unsent draft', 'Ten works', 'secret-id', 'own-id', 'third-id', LEO]) {
        expect(place).not.toContain(bit)
      }
    }
    expect(address).toBe(GROUP)
  })

  test('the moves between two chats draw nothing of the last', async () => {
    g1().items = [said('a', 6)]
    chatOf('group:g-2').items = [said('z', 6)]
    stubScreen({ wide: true })
    await openChatAt(GROUP)
    type('Half a thought')
    const hold = gate()
    stage('GET', /^\/groups\/g-2\/chat$/, { hold })
    await go(FINCH)
    expect(text(main())).toContain('Loading…')
    expect(text(main())).not.toContain('The words of a')
    expect(text(main())).not.toContain('The Lees')
    await act(async () => hold.release())
    expect(await screen.findByText('The words of z')).toBeTruthy()
    expect(screen.queryByText('The words of a')).toBeNull()
    expect(box().value).toBe('')
    await go(GROUP)
    await screen.findByText('The words of a')
    expect(box().value).toBe('')
    await go(DINNER)
    await screen.findByRole('textbox', { name: 'Message Dinner' })
    expect(document.body.textContent).not.toContain('The words of a')
  })
})

// --- the scroll, as far as jsdom can say ---------------------------------------------------

describe('the thread', () => {
  // A thread 400 tall over a list that grows 100 with each entry. Where each
  // entry stands is the browser's to say, and is measured there.
  function stubHeights() {
    const isThread = (element: Element) => element.classList.contains('thread')
    const height = (element: Element) => 100 + element.querySelectorAll('li').length * 100
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) {
      return isThread(this) ? height(this) : 0
    })
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
      return isThread(this) ? 400 : 0
    })
    let top = 0
    vi.spyOn(Element.prototype, 'scrollTop', 'get').mockImplementation(function (this: Element) {
      return isThread(this) ? top : 0
    })
    vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation(function (this: Element, value: number) {
      if (isThread(this)) top = Math.max(0, Math.min(value, height(this) - 400))
    })
    return {
      get top() {
        return top
      },
      at: async (value: number) => {
        top = value
        await act(async () => void fireEvent.scroll(thread()))
      },
      bottom: () => height(thread()) - 400,
    }
  }

  const ten = () => Array.from({ length: 10 }, (_, n) => said(`a${n}`, 30 - n))

  test('opens at the newest, and stays there as messages arrive', async () => {
    g1().items = ten()
    const scroll = stubHeights()
    await openChatAt(GROUP)
    expect(scroll.top).toBe(scroll.bottom())
    say('group:g-1', said('new', 0))
    await check()
    expect(scroll.top).toBe(scroll.bottom())
    // Within 48px is the bottom.
    await scroll.at(scroll.bottom() - 48)
    say('group:g-1', said('newer', 0))
    await check()
    expect(scroll.top).toBe(scroll.bottom())
  })

  test('moves for nothing anywhere else, except your own send', async () => {
    g1().items = ten()
    const scroll = stubHeights()
    await openChatAt(GROUP)
    await scroll.at(scroll.bottom() - 49)
    const where = scroll.top
    say('group:g-1', said('new', 0))
    await check()
    expect(scroll.top).toBe(where)
    type('Mine')
    fireEvent.click(sendButton())
    await waitFor(() => expect(box().value).toBe(''))
    expect(scroll.top).toBe(scroll.bottom())
  })

  // Each entry 100 tall under the top 100, so the place of one is arithmetic.
  function stubPlaces(scroll: { top: number }) {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const box = (top: number, height: number) =>
        ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top }) as DOMRect
      if (this.classList.contains('thread')) return box(0, 400)
      const list = this.closest('.thread')
      if (list === null || this.tagName !== 'LI') return box(0, 0)
      return box(100 + [...list.querySelectorAll('li')].indexOf(this as HTMLLIElement) * 100 - scroll.top, 100)
    })
  }
  const where = (words: string) => row(words).getBoundingClientRect().top

  test('an earlier page leaves what is on screen where it was', async () => {
    g1().page = 10
    g1().items = [...Array.from({ length: 6 }, (_, n) => said(`b${n}`, 60 - n)), ...ten()]
    const scroll = stubHeights()
    stubPlaces(scroll)
    await openChatAt(GROUP)
    await scroll.at(300)
    const before = where('The words of a3')
    fireEvent.click(button('Show earlier messages'))
    expect(await screen.findByText('The words of b0')).toBeTruthy()
    await quiet()
    expect(where('The words of a3')).toBe(before)
    expect(scroll.top).toBe(900)
  })

  test('even within 48px of the bottom, where an arrival would go to the newest', async () => {
    g1().page = 3
    g1().items = [...Array.from({ length: 2 }, (_, n) => said(`b${n}`, 60 - n)), ...ten().slice(7)]
    const scroll = stubHeights()
    stubPlaces(scroll)
    await openChatAt(GROUP)
    await scroll.at(scroll.bottom() - 40)
    const before = where('The words of a8')
    fireEvent.click(button('Show earlier messages'))
    expect(await screen.findByText('The words of b0')).toBeTruthy()
    await quiet()
    expect(where('The words of a8')).toBe(before)
    expect(scroll.top).toBe(scroll.bottom() - 40)
  })

  test('a message that goes above what is on screen moves nothing', async () => {
    g1().items = ten()
    const scroll = stubHeights()
    stubPlaces(scroll)
    await openChatAt(GROUP)
    await scroll.at(500)
    const before = where('The words of a6')
    takeOut('group:g-1', 'a1')
    await check()
    expect(screen.queryByText('The words of a1')).toBeNull()
    expect(where('The words of a6')).toBe(before)
  })

  test('showing a held one scrolls nothing', async () => {
    g1().moderate = true
    g1().items = [...ten(), heldItem(said('h', 5, { body: 'Bring the long table.' }))]
    const scroll = stubHeights()
    await openChatAt(GROUP)
    await scroll.at(300)
    fireEvent.click(button('Show it'))
    expect(scroll.top).toBe(300)
    await scroll.at(scroll.bottom())
    const where = scroll.top
    fireEvent.click(button('Hide it'))
    fireEvent.click(button('Show it'))
    expect(scroll.top).toBe(where)
  })
})

test('chatItem stands in for the server’s body', () => {
  expect(Object.keys(chatItem('a')).sort()).toEqual(['author', 'body', 'created_at', 'id', 'kind', 'removed'])
})
