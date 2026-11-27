// CK-105 — reactions in the chat (THE DESIGN §7 of its kickoff, approved by
// Steven on 2026-11-26): the chips in the server's order, React and its panel —
// the picker and Who reacted — and what a press does, through the app's real
// route table with the REAL AuthProvider over the real session store, against
// the fake server in test-support/chatWorld.ts.
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ChatItem } from '../lib/chat'
import { chatItem, heldItem } from '../test-support/chat'
import {
  address,
  asked,
  chatOf,
  check,
  CHECKED,
  endWorld,
  gatheringBody,
  live,
  ME,
  mine,
  openChatAt,
  quiet,
  renderApp,
  said,
  stage,
  startWorld,
  takeOut,
  thread,
  world,
} from '../test-support/chatWorld'
import { gate } from '../test-support/focus'

const GROUP = '/groups/g-1/chat'
const g1 = () => chatOf('group:g-1')
const rowOf = (words: string) => screen.getByText(words).closest('li')!
const flat = (words: string | null | undefined) => (words ?? '').replace(/\s+/g, ' ').trim()
const told = () => [...(live()?.querySelectorAll('p') ?? [])].map((p) => flat(p.textContent))
const active = () => document.activeElement
const chips = (row: HTMLElement) => [...row.querySelectorAll<HTMLButtonElement>('.rx .rxchip')]
const chip = (row: HTMLElement, name: string) => within(row).getByRole<HTMLButtonElement>('button', { name })
const react = (row: HTMLElement) => within(row).getByRole<HTMLButtonElement>('button', { name: /^React to / })
const picker = (row: HTMLElement) => within(row).getByRole('group', { name: 'Choose a reaction' })
const reactionsAsked = (method: string) => asked(/^\/messages\/[^/]+\/reactions$/, method)
const whoOf = (row: HTMLElement) =>
  waitFor(() => {
    const who = row.querySelector<HTMLElement>('.who')
    if (who === null) throw new Error('Who reacted is not drawn')
    return who
  })

// Leo's message with Kelly's like and the caller's, and Leo's own heart.
function theirs(over: Partial<ChatItem> = {}): ChatItem {
  return said('theirs', 6, {
    body: 'Their words',
    reactions: [
      { kind: 'like', count: 2, mine: true },
      { kind: 'heart', count: 1, mine: false },
    ],
    ...over,
  })
}

beforeEach(() => {
  startWorld()
  g1().items = [theirs(), mine('own', 5, { body: 'My words', reactions: [] })]
  world.who.theirs = [
    { kind: 'like', names: ['Kelly Brandt', ME] },
    { kind: 'heart', names: ['Leo Brandt'] },
  ]
})

afterEach(() => {
  cleanup()
  endWorld()
})

// --- the chips ------------------------------------------------------------------------------

describe('the chips', () => {
  test('in the server’s order, each a button named by its kind and count, pressed where the caller’s is there', async () => {
    g1().items = [
      said('theirs', 6, {
        body: 'Their words',
        reactions: [
          { kind: 'sad', count: 1, mine: false },
          { kind: 'like', count: 3, mine: true },
          { kind: 'thumbs_up', count: 2, mine: false },
        ],
      }),
    ]
    await openChatAt(GROUP)
    const row = rowOf('Their words')
    expect(chips(row).map((one) => [one.getAttribute('aria-label'), one.getAttribute('aria-pressed')])).toEqual([
      ['Sad, 1', 'false'],
      ['Like, 3', 'true'],
      ['Thumbs up, 2', 'false'],
    ])
    // Like's mark is drawn; the rest are the emoji.
    expect(chip(row, 'Like, 3').querySelector('svg')).not.toBeNull()
    expect(flat(chip(row, 'Like, 3').textContent)).toBe('3')
    expect(flat(chip(row, 'Sad, 1').textContent)).toBe('😢1')
    expect(flat(chip(row, 'Thumbs up, 2').textContent)).toBe('👍2')
    // Beneath the bubble, and no total anywhere.
    const bubble = within(row).getByText('Their words')
    expect(bubble.compareDocumentPosition(row.querySelector('.rx')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test('in a memorial’s chat, the kinds and whose, and no number anywhere', async () => {
    world.gatherings['x-5'] = gatheringBody('x-5', 'For Rose', {
      gathering_type: 'memorial',
      memorial_decedent_name: 'Rose Lee',
    })
    chatOf('gathering:x-5').items = [
      said('m', 6, {
        body: 'Remembering her',
        reactions: [
          { kind: 'heart', count: null, mine: true },
          { kind: 'sad', count: null, mine: false },
        ],
      }),
    ]
    world.who.m = [
      { kind: 'heart', names: [ME, 'Kelly Brandt', 'Leo Brandt'] },
      { kind: 'sad', names: ['Kelly Brandt'] },
    ]
    await openChatAt('/gatherings/x-5/chat')
    const row = rowOf('Remembering her')
    expect(chips(row).map((one) => [one.getAttribute('aria-label'), one.getAttribute('aria-pressed')])).toEqual([
      ['Heart', 'true'],
      ['Sad', 'false'],
    ])
    expect(row.querySelector('.rx')!.textContent).not.toMatch(/\d/)
    fireEvent.click(react(row))
    const who = await whoOf(row)
    await waitFor(() => expect(flat(who.textContent)).toContain('You, Kelly Brandt and Leo Brandt'))
    expect(who.textContent).not.toMatch(/\d/)
    // A press keeps it numberless. With no number a chip and the picker's
    // button share a name, so the chip is found among the chips.
    const rx = () => row.querySelector<HTMLElement>('.rx')!
    fireEvent.click(chip(rx(), 'Sad'))
    await waitFor(() => expect(chip(rx(), 'Sad').getAttribute('aria-pressed')).toBe('true'))
    expect(row.querySelector('.rx')!.textContent).not.toMatch(/\d/)
  })

  test('none, and no React, on a line the chat wrote, a held row, a message the server sent none for, or the Chat card', async () => {
    g1().moderate = true
    g1().items = [
      // Reactions on a line, as no server sends: drawn as a line, it has none.
      chatItem('joined-1', {
        kind: 'joined',
        body: null,
        created_at: new Date(Date.now() - 9 * 60_000).toISOString(),
        author: { display_name: 'Kelly Brandt', is_self: false },
        reactions: [{ kind: 'heart', count: 1, mine: false }],
      } as Partial<ChatItem>),
      heldItem(said('gone', 8, { body: 'Gone words', reactions: [{ kind: 'heart', count: 1, mine: false }] })),
      said('plain', 7, { body: 'Plain words' }),
      theirs(),
    ]
    await openChatAt(GROUP)
    expect(thread().querySelectorAll('.rx')).toHaveLength(1)
    expect(within(thread()).getAllByRole('button', { name: /^React to / })).toHaveLength(1)
    expect(within(rowOf('Plain words')).queryByRole('button', { name: /^React to / })).toBeNull()
    expect(within(rowOf('Kelly Brandt joined the group. Kelly Brandt sees the chat from today on.')).queryByRole('button', { name: /^React/ })).toBeNull()
    cleanup()
    renderApp('/groups/g-1')
    await screen.findByText('Their words')
    await quiet()
    expect(document.querySelector('.rx')).toBeNull()
    expect(screen.queryByRole('button', { name: /^React to / })).toBeNull()
  })
})

// --- React and its panel ----------------------------------------------------------------------

describe('React and its panel', () => {
  test('named by whose message it is, after the time and before Delete or Remove', async () => {
    g1().moderate = true
    g1().items = [
      theirs(),
      said('former', 5, { body: 'Old words', author: { display_name: 'a former member', is_self: false }, reactions: [] }),
      mine('own', 4, { body: 'My words', reactions: [] }),
    ]
    await openChatAt(GROUP)
    expect(react(rowOf('Their words')).getAttribute('aria-label')).toBe("React to Leo Brandt's message")
    expect(react(rowOf('Old words')).getAttribute('aria-label')).toBe("React to a former member's message")
    expect(react(rowOf('My words')).getAttribute('aria-label')).toBe('React to your message')
    const own = rowOf('My words')
    const remove = within(rowOf('Their words')).getByRole('button', { name: "Remove Leo Brandt's message" })
    expect(react(rowOf('Their words')).compareDocumentPosition(remove) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const del = within(own).getByRole('button', { name: 'Delete your message' })
    expect(react(own).compareDocumentPosition(del) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(react(own).getAttribute('aria-expanded')).toBe('false')
    expect(react(own).classList.contains('rxadd')).toBe(true)
  })

  test('opens the picker — seven, Like first, pressed where the caller’s is there — on its first button', async () => {
    await openChatAt(GROUP)
    const row = rowOf('Their words')
    react(row).focus()
    fireEvent.click(react(row))
    expect(react(row).getAttribute('aria-expanded')).toBe('true')
    const buttons = within(picker(row)).getAllByRole<HTMLButtonElement>('button')
    expect(buttons.map((one) => [one.getAttribute('aria-label') ?? flat(one.textContent), one.getAttribute('aria-pressed')])).toEqual([
      ['Like', 'true'],
      ['Heart', 'false'],
      ['Laughing', 'false'],
      ['Surprised', 'false'],
      ['Sad', 'false'],
      ['Thumbs up', 'false'],
      ['Celebrate', 'false'],
    ])
    await waitFor(() => expect(active()).toBe(buttons[0]))
    // The panel between the bubble and the chips.
    const bubble = within(row).getByText('Their words')
    const panel = picker(row)
    expect(bubble.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(panel.compareDocumentPosition(row.querySelector('.rx')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test('reads who reacted once as it opens, draws nothing of it until it lands, then each kind and the names', async () => {
    const hold = gate()
    stage('GET', /^\/messages\/theirs\/reactions$/, { hold })
    await openChatAt(GROUP)
    const row = rowOf('Their words')
    fireEvent.click(react(row))
    await waitFor(() => expect(reactionsAsked('GET')).toHaveLength(1))
    expect(row.querySelector('.who')).toBeNull()
    await act(async () => hold.release())
    const who = await whoOf(row)
    expect(flat(who.querySelector('b')?.textContent)).toBe('Who reacted')
    // Its rows are no entries of the thread's: never an li.
    expect(who.querySelector('li')).toBeNull()
    const rows = [...who.querySelectorAll(':scope > div')]
    expect(rows.map((one) => [within(one as HTMLElement).getByRole('img').getAttribute('aria-label'), flat(one.textContent)])).toEqual([
      ['Like', 'You and Kelly Brandt'],
      ['Heart', '❤️Leo Brandt'],
    ])
    expect(who.textContent).not.toMatch(/\d/)
    expect(picker(row).compareDocumentPosition(who) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(reactionsAsked('GET').map((call) => call.path)).toEqual(['/messages/theirs/reactions'])
  })

  test('says quietly when who reacted could not be read', async () => {
    stage('GET', /^\/messages\/theirs\/reactions$/, { status: 500 })
    await openChatAt(GROUP)
    const row = rowOf('Their words')
    fireEvent.click(react(row))
    const failed = await within(row).findByText("Who reacted couldn't be loaded just now.")
    expect(failed.closest('[role="alert"]')).toBeNull()
    expect(picker(row)).toBeTruthy()
  })

  test('a picker press leaves or takes back that kind, closes the panel and puts focus on React', async () => {
    await openChatAt(GROUP)
    const row = rowOf('Their words')
    fireEvent.click(react(row))
    fireEvent.click(within(picker(row)).getByRole('button', { name: 'Heart' }))
    await waitFor(() => expect(within(row).queryByRole('group', { name: 'Choose a reaction' })).toBeNull())
    expect(reactionsAsked('PUT').map((call) => [call.path, call.body])).toEqual([
      ['/messages/theirs/reactions', { kind: 'heart', on: true }],
    ])
    await waitFor(() => expect(chip(row, 'Heart, 2').getAttribute('aria-pressed')).toBe('true'))
    expect(react(row).getAttribute('aria-expanded')).toBe('false')
    expect(active()).toBe(react(row))
    // Like is the caller's already: the picker takes it back.
    fireEvent.click(react(row))
    fireEvent.click(within(picker(row)).getByRole('button', { name: 'Like' }))
    await waitFor(() => expect(chip(row, 'Like, 1').getAttribute('aria-pressed')).toBe('false'))
    expect(reactionsAsked('PUT').at(-1)!.body).toEqual({ kind: 'like', on: false })
  })

  test('Escape closes it, and so does React again, focus on React', async () => {
    await openChatAt(GROUP)
    const row = rowOf('Their words')
    fireEvent.click(react(row))
    fireEvent.keyDown(within(picker(row)).getByRole('button', { name: 'Like' }), { key: 'Escape' })
    expect(within(row).queryByRole('group', { name: 'Choose a reaction' })).toBeNull()
    await waitFor(() => expect(active()).toBe(react(row)))
    fireEvent.click(react(row))
    expect(picker(row)).toBeTruthy()
    fireEvent.click(react(row))
    expect(within(row).queryByRole('group', { name: 'Choose a reaction' })).toBeNull()
    expect(react(row).getAttribute('aria-expanded')).toBe('false')
    await waitFor(() => expect(active()).toBe(react(row)))
  })

  test('one panel at a time, and never beside a step', async () => {
    await openChatAt(GROUP)
    const one = rowOf('Their words')
    const own = rowOf('My words')
    fireEvent.click(react(one))
    fireEvent.click(react(own))
    expect(within(one).queryByRole('group', { name: 'Choose a reaction' })).toBeNull()
    expect(picker(own)).toBeTruthy()
    // Delete's step closes the panel, and React closes the step.
    fireEvent.click(within(own).getByRole('button', { name: 'Delete your message' }))
    expect(within(own).queryByRole('group', { name: 'Choose a reaction' })).toBeNull()
    expect(within(own).getByRole('group', { name: 'Delete this message? It will leave the chat at once.' })).toBeTruthy()
    fireEvent.click(react(own))
    expect(within(own).queryByRole('group', { name: 'Delete this message? It will leave the chat at once.' })).toBeNull()
    expect(picker(own)).toBeTruthy()
  })
})

// --- a press -----------------------------------------------------------------------------------

describe('a press', () => {
  test('on a chip: that kind on or off, every control of the message waiting, one at a time, then focus on that kind’s chip', async () => {
    await openChatAt(GROUP)
    const row = rowOf('Their words')
    const own = rowOf('My words')
    const hold = gate()
    stage('PUT', /^\/messages\/theirs\/reactions$/, { hold })
    chip(row, 'Heart, 1').focus()
    fireEvent.click(chip(row, 'Heart, 1'))
    await waitFor(() => expect(chip(row, 'Heart, 1').disabled).toBe(true))
    expect(chip(row, 'Like, 2').disabled).toBe(true)
    fireEvent.click(chip(row, 'Like, 2'))
    expect(react(own).disabled).toBe(false)
    expect(reactionsAsked('PUT')).toHaveLength(1)
    await act(async () => hold.release())
    await waitFor(() => expect(chip(row, 'Heart, 2').disabled).toBe(false))
    expect(chip(row, 'Heart, 2').getAttribute('aria-pressed')).toBe('true')
    expect(reactionsAsked('PUT').map((call) => call.body)).toEqual([{ kind: 'heart', on: true }])
    expect(active()).toBe(chip(row, 'Heart, 2'))
  })

  test('the chip gone with the last of its kind: focus on React', async () => {
    g1().items = [said('theirs', 6, { body: 'Their words', reactions: [{ kind: 'laugh', count: 1, mine: true }] })]
    await openChatAt(GROUP)
    const row = rowOf('Their words')
    chip(row, 'Laughing, 1').focus()
    fireEvent.click(chip(row, 'Laughing, 1'))
    await waitFor(() => expect(row.querySelector('.rxchip')).toBeNull())
    expect(reactionsAsked('PUT').map((call) => call.body)).toEqual([{ kind: 'laugh', on: false }])
    await waitFor(() => expect(active()).toBe(react(row)))
  })

  test('a 404 checks at once: the message gone, focus on the thread', async () => {
    await openChatAt(GROUP)
    const before = asked(CHECKED).length
    takeOut('group:g-1', 'theirs')
    const row = rowOf('Their words')
    chip(row, 'Heart, 1').focus()
    fireEvent.click(chip(row, 'Heart, 1'))
    await waitFor(() => expect(asked(CHECKED).length).toBe(before + 1))
    await waitFor(() => expect(screen.queryByText('Their words')).toBeNull())
    await quiet()
    expect(active()).toBe(thread())
  })

  test('a 404 on a message still there: a check, and focus on React', async () => {
    stage('PUT', /^\/messages\/theirs\/reactions$/, { status: 404 })
    await openChatAt(GROUP)
    const before = asked(CHECKED).length
    const row = rowOf('Their words')
    chip(row, 'Heart, 1').focus()
    fireEvent.click(chip(row, 'Heart, 1'))
    await waitFor(() => expect(asked(CHECKED).length).toBe(before + 1))
    await quiet()
    await waitFor(() => expect(active()).toBe(react(rowOf('Their words'))))
    expect(within(rowOf('Their words')).queryByRole('alert')).toBeNull()
  })

  test('any other refusal says so beneath the chips, an alert, gone on the next press; focus on the chip', async () => {
    stage('PUT', /^\/messages\/theirs\/reactions$/, { status: 409, body: { detail: { code: 'not_a_message' } } })
    stage('PUT', /^\/messages\/theirs\/reactions$/, { network: true })
    await openChatAt(GROUP)
    const row = rowOf('Their words')
    chip(row, 'Heart, 1').focus()
    fireEvent.click(chip(row, 'Heart, 1'))
    const refused = await within(row).findByRole('alert')
    expect(flat(refused.textContent)).toBe('Something went wrong. Nothing changed — try again.')
    expect(row.querySelector('.rx')!.compareDocumentPosition(refused) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(chip(row, 'Heart, 1').getAttribute('aria-pressed')).toBe('false')
    await waitFor(() => expect(active()).toBe(chip(row, 'Heart, 1')))
    fireEvent.click(chip(row, 'Heart, 1'))
    await waitFor(() =>
      expect(flat(within(row).getByRole('alert').textContent)).toBe(
        "Couldn't reach the server. Check your connection and try again.",
      ),
    )
    fireEvent.click(chip(row, 'Heart, 1'))
    await waitFor(() => expect(chip(row, 'Heart, 2')).toBeTruthy())
    expect(within(row).queryByRole('alert')).toBeNull()
  })
})

// --- a check --------------------------------------------------------------------------------------

describe('a check', () => {
  test('changes the chips and says nothing of it, and leaves an open panel open, read once', async () => {
    await openChatAt(GROUP)
    const row = rowOf('Their words')
    fireEvent.click(react(row))
    await whoOf(row)
    const changed = theirs({
      reactions: [
        { kind: 'like', count: 2, mine: true },
        { kind: 'heart', count: 4, mine: false },
        { kind: 'celebrate', count: 1, mine: false },
      ],
    })
    g1().items[0] = changed
    g1().changes.push(changed)
    await check()
    expect(chips(row).map((one) => one.getAttribute('aria-label'))).toEqual(['Like, 2', 'Heart, 4', 'Celebrate, 1'])
    expect(told()).toEqual([])
    expect(picker(row)).toBeTruthy()
    expect(reactionsAsked('GET')).toHaveLength(1)
  })

  test('begun before a press’s answer, never overwrites it', async () => {
    await openChatAt(GROUP)
    const row = rowOf('Their words')
    // The check asks first and is answered last, with what the server held before the press.
    const checkHold = gate()
    stage('GET', CHECKED, {
      hold: checkHold,
      status: 200,
      body: {
        items: [theirs()],
        removed: [],
        truncated: false,
        as_of: '2026-11-24T15:00:00.000900+00:00',
        may_moderate: false,
        typing: [],
      },
    })
    const before = asked(CHECKED).length
    await act(async () => void document.dispatchEvent(new Event('visibilitychange')))
    await waitFor(() => expect(asked(CHECKED).length).toBe(before + 1))
    fireEvent.click(chip(row, 'Heart, 1'))
    await waitFor(() => expect(chip(row, 'Heart, 2').getAttribute('aria-pressed')).toBe('true'))
    await act(async () => checkHold.release())
    await quiet()
    expect(chip(row, 'Heart, 2').getAttribute('aria-pressed')).toBe('true')
  })

  test('takes focus out of a panel whose message has gone, to the thread', async () => {
    await openChatAt(GROUP)
    const row = rowOf('Their words')
    fireEvent.click(react(row))
    await waitFor(() => expect(active()).toBe(within(picker(row)).getByRole('button', { name: 'Like' })))
    takeOut('group:g-1', 'theirs')
    await check()
    expect(screen.queryByText('Their words')).toBeNull()
    expect(active()).toBe(thread())
  })
})

describe('what is kept', () => {
  test('no kind in the address, the device’s storage or the console', async () => {
    const logged = vi.spyOn(console, 'log')
    const warned = vi.spyOn(console, 'warn')
    const errored = vi.spyOn(console, 'error')
    await openChatAt(GROUP)
    const row = rowOf('Their words')
    fireEvent.click(react(row))
    fireEvent.click(within(picker(row)).getByRole('button', { name: 'Celebrate' }))
    await waitFor(() => expect(chip(row, 'Celebrate, 1')).toBeTruthy())
    expect(address).toBe(GROUP)
    const stored = [localStorage, sessionStorage].flatMap((store) =>
      Object.keys(store).map((key) => `${key}=${store.getItem(key)}`),
    )
    expect(stored.filter((one) => /celebrate|reaction|theirs/i.test(one))).toEqual([])
    const printed = [...logged.mock.calls, ...warned.mock.calls, ...errored.mock.calls].map((call) => call.join(' '))
    expect(printed.filter((line) => /celebrate|reaction/i.test(line))).toEqual([])
  })
})
