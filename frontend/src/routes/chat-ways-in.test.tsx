// CK-103 — the ways into the two chats (THE DESIGN §10 and §11): the Chat card
// on a group's page and on a gathering's, read once, the newest three live
// entries, its empty, failed and 404 states and no control of its own; the Chat
// pill for everyone in the full view; nothing of any of it in the photos-only
// view, the line about who can see the gathering still in its Photos; the
// group's panel's row; and the moves between two groups' pages.
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { formatTime } from '../lib/datetime'
import { heldItem } from '../test-support/chat'
import {
  asked,
  chatOf,
  endWorld,
  gatheringBody,
  go,
  LEO,
  mine,
  quiet,
  renderApp,
  said,
  stage,
  startWorld,
  stubScreen,
  world,
  ZONE,
} from '../test-support/chatWorld'
import { gate, pressHeld, settle } from '../test-support/focus'

const flat = (words: string) => words.replace(/\s+/g, ' ').trim()
const text = (element: Element | null | undefined) => flat(element?.textContent ?? '')
const card = () => screen.getByRole('region', { name: 'Chat' })
const noCard = () => screen.queryByRole('region', { name: 'Chat' })
const entries = () => within(card()).queryAllByRole('listitem').map(text)
const inOrder = (...elements: Element[]) =>
  elements.every(
    (element, n) =>
      n === 0 || Boolean(elements[n - 1].compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING),
  )
const CLOSED_LINE =
  "Only people in The Lees can see this gathering for now. If people outside The Lees are invited, they'll see everything in it, including what's already there."

beforeEach(() => startWorld())

afterEach(() => {
  cleanup()
  endWorld()
})

async function openGroup(id = 'g-1', name = 'The Lees') {
  renderApp(`/groups/${id}`)
  await screen.findByRole('heading', { level: 1, name })
  await quiet()
}

async function openGathering(id = 'x-1', title = 'Dinner') {
  renderApp(`/gatherings/${id}`)
  await screen.findByRole('heading', { level: 1, name: title })
  await quiet()
}

// --- the group's card ---------------------------------------------------------------

describe('a group’s page', () => {
  test('the card stands after the actions and before the strip', async () => {
    await openGroup()
    // Within the page: the bottom bar has a Calendar of its own.
    const page = within(screen.getByRole('main'))
    expect(
      inOrder(
        page.getByRole('link', { name: 'New gathering' }),
        page.getByRole('link', { name: 'People' }),
        page.getByRole('link', { name: 'Calendar' }),
        card(),
        screen.getByRole('heading', { name: 'Gatherings' }),
      ),
    ).toBe(true)
    expect(within(card()).getByRole('heading', { level: 2 }).textContent).toBe('Chat')
    expect(within(card()).getByRole('link', { name: 'Open chat' }).getAttribute('href')).toBe('/groups/g-1/chat')
    expect(within(card()).getByRole('link', { name: 'Message The Lees' }).getAttribute('href')).toBe('/groups/g-1/chat')
  })

  test('the newest three that are live, messages and lines, oldest first, in one read', async () => {
    const chat = chatOf('group:g-1')
    chat.moderate = true
    chat.items = [
      said('a', 60),
      said('b', 50, { body: 'Ten o’clock?' }),
      said('j', 40, { kind: 'joined', body: null, author: { display_name: 'Kelly Brandt', is_self: false } }),
      heldItem(said('held', 30, { body: 'Bring the long table.' })),
      mine('c', 20, { body: 'I have the truck.' }),
    ]
    await openGroup()
    // MOVED AT CK-105, with its reason: the menu's GET /chats/new (THE DESIGN §8) is no
    // read of a chat's; the pattern names a chat's own address alone.
    expect(asked(/\/chat(?!s)/).map((call) => call.path)).toEqual(['/groups/g-1/chat?limit=20'])
    expect(entries()).toEqual([
      flat(`LB${LEO}${formatTime(chat.items[1].created_at, ZONE)}Ten o’clock?`),
      'Kelly Brandt joined the group. Kelly Brandt sees the chat from today on.',
      flat(`You${formatTime(chat.items[4].created_at, ZONE)}I have the truck.`),
    ])
    // Never a held one, whoever it is sent to, and no control.
    expect(document.body.innerHTML).not.toContain('Bring the long table.')
    expect(within(card()).queryAllByRole('button')).toEqual([])
    expect(within(card()).queryByText(/Delete|Remove|Show it/)).toBeNull()
  })

  test('it does not check again', async () => {
    chatOf('group:g-1').items = [said('a', 5)]
    await openGroup()
    await act(async () => void document.dispatchEvent(new Event('visibilitychange')))
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 2300))))
    // MOVED AT CK-105, with its reason: the menu's GET /chats/new (THE DESIGN §8) is no
    // read of a chat's; the pattern names a chat's own address alone.
    expect(asked(/\/chat(?!s)/)).toHaveLength(1)
  })

  test('a time is alone today, and has its day otherwise', async () => {
    const day = 24 * 60
    chatOf('group:g-1').items = [said('old', 400 * day), said('yesterday', day), said('today', 1)]
    await openGroup()
    const [old, yesterday, today] = chatOf('group:g-1').items.map((item) => formatTime(item.created_at, ZONE))
    expect([...card().querySelectorAll('time')].map(text)).toEqual([
      flat(`${ZONE === 'Pacific/Honolulu' ? 'Oct 20, 2025' : 'Oct 21, 2025'}, ${old}`),
      flat(`Yesterday, ${yesterday}`),
      flat(today),
    ])
  })

  test('empty, and only once the read has landed', async () => {
    // MOVED AT CK-105, with its reason: the menu's GET /chats/new (THE DESIGN §8) is no
    // read of a chat's; the card's read is staged by a chat's own address alone.
    const hold = gate()
    stage('GET', /\/chat(?!s)/, { hold })
    renderApp('/groups/g-1')
    await screen.findByRole('heading', { level: 1, name: 'The Lees' })
    await settle()
    expect(within(card()).getByRole('link', { name: 'Open chat' })).toBeTruthy()
    expect(within(card()).queryByText('No messages yet.')).toBeNull()
    await act(async () => hold.release())
    expect(await within(card()).findByText('No messages yet.')).toBeTruthy()
  })

  test('a failure says so, Open chat and the box still there, and Try again reads it again', async () => {
    // MOVED AT CK-105, with its reason: the menu's GET /chats/new (THE DESIGN §8) is no
    // read of a chat's; the card's read is staged by a chat's own address alone.
    chatOf('group:g-1').items = [said('a', 5)]
    stage('GET', /\/chat(?!s)/, { status: 500 })
    await openGroup()
    expect(text(within(card()).getByRole('alert'))).toContain("The chat couldn't be loaded just now.")
    expect(within(card()).getByRole('link', { name: 'Open chat' })).toBeTruthy()
    expect(within(card()).getByRole('link', { name: 'Message The Lees' })).toBeTruthy()
    const again = () => within(card()).getByRole<HTMLButtonElement>('button', { name: 'Try again' })
    // Failing again: the new Try again.
    const first = again()
    let hold = gate()
    stage('GET', /\/chat(?!s)/, { hold, status: 500 })
    await pressHeld(first, hold)
    expect(document.activeElement).toBe(again())
    // Landing: the heading.
    hold = gate()
    stage('GET', /\/chat(?!s)/, { hold })
    await pressHeld(again(), hold)
    expect(within(card()).getByText('The words of a')).toBeTruthy()
    expect(document.activeElement).toBe(within(card()).getByRole('heading', { level: 2 }))
    expect(within(card()).queryByRole('alert')).toBeNull()
  })

  test('Try again leaves a person who moved on where they are', async () => {
    // MOVED AT CK-105, with its reason: the menu's GET /chats/new (THE DESIGN §8) is no
    // read of a chat's; the card's read is staged by a chat's own address alone.
    stage('GET', /\/chat(?!s)/, { status: 500 })
    await openGroup()
    const hold = gate()
    stage('GET', /\/chat(?!s)/, { hold })
    const people = screen.getByRole('link', { name: 'People' })
    await pressHeld(within(card()).getByRole('button', { name: 'Try again' }), hold, people)
    expect(document.activeElement).toBe(people)
  })

  test('a 404 is no card', async () => {
    // MOVED AT CK-105, with its reason: the menu's GET /chats/new (THE DESIGN §8) is no
    // read of a chat's; the card's read is staged by a chat's own address alone.
    stage('GET', /\/chat(?!s)/, { status: 404, always: true })
    await openGroup()
    expect(noCard()).toBeNull()
    expect(screen.queryByText('Open chat')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Gatherings' })).toBeTruthy()
  })

  test('a former member: capitalised, no letters', async () => {
    chatOf('group:g-1').items = [said('a', 5, { author: { display_name: 'a former member', is_self: false } })]
    await openGroup()
    expect(text(card().querySelector('.by'))).toBe('A former member')
    expect(text(card().querySelector('.avatar'))).toBe('')
  })

  test('moving between two groups draws nothing of the last', async () => {
    chatOf('group:g-1').items = [said('a', 5)]
    chatOf('group:g-2').items = [said('z', 5)]
    stubScreen({ wide: true })
    await openGroup()
    expect(within(card()).getByText('The words of a')).toBeTruthy()
    const hold = gate()
    stage('GET', /\/groups\/g-2\/chat/, { hold })
    await go('/groups/g-2')
    await screen.findByRole('heading', { level: 1, name: 'Finch' })
    await settle()
    expect(screen.queryByText('The words of a')).toBeNull()
    expect(within(card()).getByRole('link', { name: 'Message Finch' }).getAttribute('href')).toBe('/groups/g-2/chat')
    await act(async () => hold.release())
    expect(await within(card()).findByText('The words of z')).toBeTruthy()
    // MOVED AT CK-105, with its reason: the menu's GET /chats/new (THE DESIGN §8) is no
    // read of a chat's; the pattern names a chat's own address alone.
    expect(asked(/\/chat(?!s)/)).toHaveLength(2)
  })

  test('a late answer for the group left behind is ignored', async () => {
    chatOf('group:g-1').items = [said('a', 5)]
    chatOf('group:g-2').items = [said('z', 5)]
    const hold = gate()
    stage('GET', /\/groups\/g-1\/chat/, { hold })
    stubScreen({ wide: true })
    renderApp('/groups/g-1')
    await screen.findByRole('heading', { level: 1, name: 'The Lees' })
    await go('/groups/g-2')
    expect(await within(await screen.findByRole('region', { name: 'Chat' })).findByText('The words of z')).toBeTruthy()
    await act(async () => hold.release())
    await settle()
    expect(entries()).toHaveLength(1)
    expect(within(card()).queryByText('The words of a')).toBeNull()
  })

  test('a press on Open chat opens it, and Back comes back to the page', async () => {
    await openGroup()
    fireEvent.click(within(card()).getByRole('link', { name: 'Open chat' }), { detail: 1 })
    await screen.findByRole('region', { name: 'Messages' })
    fireEvent.click(screen.getByRole('link', { name: 'Back to The Lees' }), { detail: 1 })
    expect(await screen.findByRole('heading', { name: 'Gatherings' })).toBeTruthy()
  })
})

// --- a gathering's card and pill ------------------------------------------------------

describe('a gathering’s page, in full', () => {
  test('the card stands between When and Photos, with the line about who can see it for a group’s member', async () => {
    chatOf('gathering:x-1').items = [said('a', 5)]
    await openGathering()
    expect(
      inOrder(screen.getByRole('heading', { name: 'When' }), card(), screen.getByRole('heading', { name: 'Photos' })),
    ).toBe(true)
    expect(text(card().querySelector('.gline'))).toBe(CLOSED_LINE)
    const heading = within(card()).getByRole('heading', { level: 2 })
    expect(inOrder(heading, card().querySelector('.gline')!, within(card()).getByRole('listitem'))).toBe(true)
    expect(within(card()).getByRole('link', { name: 'Message Dinner' }).getAttribute('href')).toBe('/gatherings/x-1/chat')
    // MOVED AT CK-105, with its reason: the menu's GET /chats/new (THE DESIGN §8) is no
    // read of a chat's; the pattern names a chat's own address alone.
    expect(asked(/\/chat(?!s)/).map((call) => call.path)).toEqual(['/gatherings/x-1/chat?limit=20'])
    // It is nowhere else on the page: not in Photos.
    expect(screen.getAllByText(CLOSED_LINE)).toHaveLength(1)
  })

  test('outsiders and a standalone gathering have the card and no line', async () => {
    for (const [id, title] of [
      ['x-4', 'Picnic'],
      ['x-2', 'Book Club'],
    ]) {
      await openGathering(id, title)
      expect(within(card()).getByRole('link', { name: 'Open chat' }).getAttribute('href')).toBe(`/gatherings/${id}/chat`)
      expect(document.querySelector('.gline')).toBeNull()
      cleanup()
    }
  })

  test('the pill is there for everyone in the full view, between Add photos and Edit gathering', async () => {
    const pill = () => screen.getByRole('link', { name: 'Chat' })
    await openGathering()
    expect(pill().getAttribute('href')).toBe('/gatherings/x-1/chat')
    expect(inOrder(screen.getByRole('button', { name: 'Add photos' }), pill())).toBe(true)
    cleanup()
    world.gatherings['x-1'] = gatheringBody('x-1', 'Dinner', { caller_role: 'host' })
    await openGathering()
    expect(
      inOrder(
        screen.getByRole('button', { name: 'Add photos' }),
        pill(),
        screen.getByRole('button', { name: 'Edit gathering' }),
      ),
    ).toBe(true)
    cleanup()
    await openGathering('x-4', 'Picnic')
    expect(pill()).toBeTruthy()
  })

  test('moving between two gatherings draws nothing of the last, nor its late answer', async () => {
    chatOf('gathering:x-1').items = [said('a', 5)]
    chatOf('gathering:x-2').items = [said('z', 5)]
    stubScreen({ wide: true })
    await openGathering()
    expect(within(card()).getByText('The words of a')).toBeTruthy()
    // The next one's read is held: the card has its own names and no entries.
    const hold = gate()
    stage('GET', /\/gatherings\/x-2\/chat/, { hold })
    await go('/gatherings/x-2')
    await screen.findByRole('heading', { level: 1, name: 'Book Club' })
    await settle()
    expect(within(card()).getByRole('link', { name: 'Message Book Club' })).toBeTruthy()
    expect(screen.queryByText('The words of a')).toBeNull()
    // Left before it answers: its answer draws nothing on the next.
    await go('/gatherings/x-1')
    await screen.findByRole('heading', { level: 1, name: 'Dinner' })
    expect(await within(card()).findByText('The words of a')).toBeTruthy()
    await act(async () => hold.release())
    await settle()
    expect(entries()).toHaveLength(1)
    expect(within(card()).getByText('The words of a')).toBeTruthy()
  })

  test('the setting follows into the card', async () => {
    world.gatherings['x-1'].outside_invitations = { on: true, since: 'x', by: LEO, may_change: false }
    await openGathering()
    expect(text(card().querySelector('.gline'))).toBe(
      'People outside The Lees can see this gathering and everything in it.',
    )
  })
})

describe('a gathering’s page, photos only', () => {
  test('no card, no pill and no read; the line still at the top of Photos', async () => {
    await openGathering('x-3', 'Surprise')
    expect(noCard()).toBeNull()
    expect(screen.queryByRole('link', { name: /Chat/ })).toBeNull()
    expect(screen.queryByText('Open chat')).toBeNull()
    // MOVED AT CK-105, with its reason: the menu's GET /chats/new (THE DESIGN §8) is no
    // read of a chat's; the pattern names a chat's own address alone.
    expect(asked(/\/chat(?!s)/)).toEqual([])
    const line = screen.getByText(CLOSED_LINE)
    expect(line.closest('.media-block')).not.toBeNull()
  })
})

// --- the group's panel -----------------------------------------------------------------

describe('the group’s panel in Rail and panel', () => {
  beforeEach(() => {
    localStorage.setItem('covey-keep:menu-layout', 'rail')
    stubScreen({ wide: true })
  })

  const rows = () => {
    const panel = document.querySelector<HTMLElement>('.panel')!
    return [...panel.querySelectorAll('.nrows.d a')].map((link) => [
      text(link.querySelector('b')),
      text(link.querySelector('.t > span')),
      link.getAttribute('href'),
      link.getAttribute('aria-current'),
    ])
  }

  test('the row stands between Group page and Photos, current on the chat’s address', async () => {
    renderApp('/groups/g-1/chat')
    await screen.findByRole('region', { name: 'Messages' })
    await waitFor(() => expect(document.querySelector('.panel .nrows.d')).not.toBeNull())
    expect(rows()).toEqual([
      ['Group page', 'Cover, chat and photos', '/groups/g-1', null],
      ['Chat', "Only the group's members", '/groups/g-1/chat', 'page'],
      ['Photos', 'By gathering', '/groups/g-1#photos', null],
      ['Calendar', "This group's dates", '/calendar?group=g-1', null],
      ['People', '3 people', '/groups/g-1/people', null],
    ])
    expect(within(document.querySelector<HTMLElement>('.panel')!).getByRole('link', { current: 'page' })).toBeTruthy()
  })

  test('and is not current anywhere else', async () => {
    await openGroup()
    expect(rows().map(([name, , , current]) => [name, current])).toEqual([
      ['Group page', 'page'],
      ['Chat', null],
      ['Photos', null],
      ['Calendar', null],
      ['People', null],
    ])
  })

  test('a gathering’s chat shows its group’s panel, and a standalone one’s Home’s', async () => {
    renderApp('/gatherings/x-1/chat')
    await screen.findByRole('region', { name: 'Messages' })
    await waitFor(() => expect(document.querySelector('.panel .nrows.d')).not.toBeNull())
    expect(rows()[1]).toEqual(['Chat', "Only the group's members", '/groups/g-1/chat', null])
    cleanup()
    renderApp('/gatherings/x-2/chat')
    await screen.findByRole('region', { name: 'Messages' })
    await quiet()
    expect(document.querySelector('.panel .nrows.d')).toBeNull()
  })

  test('One list has no such row', async () => {
    localStorage.setItem('covey-keep:menu-layout', 'list')
    vi.resetModules()
    await openGroup()
    const nav = screen.getByRole('navigation', { name: 'Main' })
    expect(within(nav).queryByText('Chat')).toBeNull()
  })
})
