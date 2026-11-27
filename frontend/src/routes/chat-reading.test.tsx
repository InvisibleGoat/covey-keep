// CK-105 — where a chat opens and what holds it still, the button to the
// newest, reading on below, the reading place and typing (THE DESIGN §1 to §6,
// §9 and §10 of its kickoff, approved by Steven on 2026-11-26), through the
// app's real route table with the REAL AuthProvider over the real session
// store. jsdom has no layout, so the thread's geometry is stubbed (an entry
// 100 tall unless a test says otherwise, in a view 400 tall) and so is the
// IntersectionObserver, calling back only after `observe()`. The device's
// clock is stopped and the profile's zone is forced to differ from the
// runner's.
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ChatItem } from '../lib/chat'
import { chatsNewNow, isNew } from '../lib/chatsNew'
import { chatChanges } from '../test-support/chat'
import {
  asked,
  box,
  chatOf,
  check,
  CHECKED,
  endWorld,
  go,
  live,
  marksAsked,
  mine,
  NOW,
  observers,
  openChatAt,
  quiet,
  renderApp,
  said,
  say,
  sendButton,
  setHidden,
  stage,
  startWorld,
  stubGeometry,
  stubObservers,
  stubScreen,
  takeOut,
  thread,
  type,
  world,
} from '../test-support/chatWorld'
import { gate } from '../test-support/focus'

const GROUP = '/groups/g-1/chat'
const g1 = () => chatOf('group:g-1')
const rowOf = (id: string) => screen.getByText(`The words of ${id}`).closest('li')!
const line = () => thread().querySelector('.newline')
const jump = () => screen.queryByRole<HTMLButtonElement>('button', { name: /^Go to the newest message/ })
const header = () => screen.getByRole('heading', { level: 1 }).nextElementSibling!
const flat = (words: string | null | undefined) => (words ?? '').replace(/\s+/g, ' ').trim()
const told = () => [...(live()?.querySelectorAll('p') ?? [])].map((p) => flat(p.textContent))

const ten = () => Array.from({ length: 10 }, (_, n) => said(`a${n}`, 60 - n))
const thirty = () => Array.from({ length: 30 }, (_, n) => said(`a${n}`, 60 - n))

// A message as the server now sends it, changed in place: the next check brings it.
function change(key: string, item: ChatItem) {
  const chat = chatOf(key)
  chat.items = chat.items.map((one) => (one.id === item.id ? item : one))
  chat.changes = [...chat.changes.filter((one) => one.id !== item.id), item]
}

beforeEach(() => startWorld())

afterEach(() => {
  cleanup()
  endWorld()
})

// --- §1 and §2: where a chat opens ------------------------------------------------------

describe('where a chat opens', () => {
  test('at the first message not yet read: the line above it at the top of the view, the read ones above it', async () => {
    g1().items = thirty()
    g1().firstUnread = 'a20'
    const scroll = stubGeometry()
    await openChatAt(GROUP)
    expect(asked(/^\/groups\/g-1\/chat/).map((call) => call.path)).toEqual(['/groups/g-1/chat?open=true'])
    expect(thread().querySelectorAll('.newline')).toHaveLength(1)
    expect(flat(line()?.textContent)).toBe('New messages')
    expect(line()!.tagName).toBe('LI')
    expect(rowOf('a19').nextElementSibling).toBe(line())
    expect(line()!.nextElementSibling).toBe(rowOf('a20'))
    expect(scroll.place(line()!).top).toBe(0)
    expect(scroll.top).toBe(2200)
    expect(screen.getByText('The words of a0')).toBeTruthy()
  })

  test('at the foot, where what is below the line is too short to put the line at the top', async () => {
    g1().items = ten()
    g1().firstUnread = 'a8'
    const scroll = stubGeometry()
    await openChatAt(GROUP)
    expect(line()).not.toBeNull()
    expect(scroll.top).toBe(scroll.bottom())
  })

  test('at the newest, with no line, where nothing is unread', async () => {
    g1().items = ten()
    const scroll = stubGeometry()
    await openChatAt(GROUP)
    expect(line()).toBeNull()
    expect(scroll.top).toBe(scroll.bottom())
  })

  test('the line stays where it was drawn: an arrival neither moves it nor draws another', async () => {
    g1().items = thirty()
    g1().firstUnread = 'a20'
    const scroll = stubGeometry()
    await openChatAt(GROUP)
    say('group:g-1', said('new', 0))
    await check()
    expect(thread().querySelectorAll('.newline')).toHaveLength(1)
    expect(line()!.nextElementSibling).toBe(rowOf('a20'))
    expect(scroll.place(line()!).top).toBe(0)
  })

  test('a first read afresh draws the line where it says, or none, and keeps the topmost entry where it was', async () => {
    g1().items = thirty()
    g1().firstUnread = 'a20'
    const scroll = stubGeometry()
    await openChatAt(GROUP)
    await scroll.at(1530)
    const before = scroll.place(rowOf('a14')).top
    g1().firstUnread = null
    stage('GET', CHECKED, { status: 200, body: chatChanges([], { truncated: true }) })
    await check()
    await quiet()
    expect(asked(/\?open=true$/)).toHaveLength(2)
    expect(line()).toBeNull()
    expect(scroll.place(rowOf('a14')).top).toBe(before)
  })
})

// --- §4: what holds the thread still -------------------------------------------------------

describe('what holds the thread still', () => {
  test('nothing another person does moves what is on screen', async () => {
    g1().moderate = true
    g1().page = 12
    g1().firstUnread = 'a0'
    g1().items = [...ten(), said('a10', 49), said('a11', 48), said('a12', 47)]
    g1().items[0] = said('a0', 60, { reactions: [] } as Partial<ChatItem>)
    const scroll = stubGeometry((li) => (li.querySelector('.rx') ? 150 : li.classList.contains('heldrow') ? 60 : 100))
    stubObservers()
    await openChatAt(GROUP)
    // a0 and a1 wholly above the view, a2 the topmost entry, its top 30px above it.
    await scroll.at(530)
    const anchor = () => scroll.place(rowOf('a3')).top
    const was = anchor()
    // A message arriving below.
    say('group:g-1', said('new', 0))
    await check()
    expect(anchor()).toBe(was)
    // Reactions growing a row above the view.
    change('group:g-1', said('a0', 60, { reactions: [{ kind: 'heart', count: 1, mine: false }] } as Partial<ChatItem>))
    await check()
    expect(rowOf('a0').querySelector('.rx')).not.toBeNull()
    expect(anchor()).toBe(was)
    // A held row appearing above it.
    takeOut('group:g-1', 'a1', { by: 'Kelly Brandt', by_self: false })
    await check()
    expect(anchor()).toBe(was)
    // Typing.
    g1().typing = ['Kelly Brandt']
    await check()
    expect(anchor()).toBe(was)
  })

  test('a row that grows without a render (a picture, a font) puts the view back too: the list is watched', async () => {
    // ResizeObserver as the browser has it, calling back for what it watches.
    const watching: { callback: ResizeObserverCallback; targets: Set<Element> }[] = []
    class FakeResize {
      private readonly watch: { callback: ResizeObserverCallback; targets: Set<Element> }
      constructor(callback: ResizeObserverCallback) {
        this.watch = { callback, targets: new Set() }
        watching.push(this.watch)
      }
      observe(target: Element) {
        this.watch.targets.add(target)
      }
      unobserve(target: Element) {
        this.watch.targets.delete(target)
      }
      disconnect() {
        this.watch.targets.clear()
      }
    }
    vi.stubGlobal('ResizeObserver', FakeResize)
    const grown = new Set<string>()
    g1().page = 12
    g1().firstUnread = 'a0'
    g1().items = [...ten(), said('a10', 49), said('a11', 48), said('a12', 47)]
    const scroll = stubGeometry((li) => (grown.has(li.textContent ?? '') ? 160 : 100))
    stubObservers()
    await openChatAt(GROUP)
    await scroll.at(530)
    const anchor = () => scroll.place(rowOf('a3')).top
    const was = anchor()
    // a0, above the view, grows by 60 with nothing rendered.
    grown.add(rowOf('a0').textContent ?? '')
    const list = thread().querySelector('ul.msgs')!
    await act(async () => {
      for (const watch of watching) {
        if (watch.targets.has(list)) watch.callback([], {} as ResizeObserver)
      }
    })
    expect(anchor()).toBe(was)
    expect(scroll.top).toBe(590)
  })

  test('a newer page below moves nothing on screen', async () => {
    g1().page = 5
    g1().items = Array.from({ length: 12 }, (_, n) => said(`a${n}`, 60 - n))
    g1().firstUnread = 'a3'
    const scroll = stubGeometry()
    stubObservers()
    await openChatAt(GROUP)
    await waitFor(() => expect(screen.getByText('The words of a9')).toBeTruthy())
    await quiet()
    expect(scroll.top).toBe(400)
  })

  test('your own send brings the whole of it into view where it fits, its foot at the view’s foot', async () => {
    g1().items = ten()
    const scroll = stubGeometry()
    await openChatAt(GROUP)
    await scroll.at(200)
    type('Mine')
    fireEvent.click(sendButton())
    await waitFor(() => expect(box().value).toBe(''))
    expect(scroll.top).toBe(scroll.bottom())
  })

  test('and where it is taller than the view, its top at the view’s top', async () => {
    g1().items = ten()
    const scroll = stubGeometry((li) => (li.textContent?.includes('Long words') ? 600 : 100))
    await openChatAt(GROUP)
    await scroll.at(200)
    type('Long words that run on and on')
    fireEvent.click(sendButton())
    await waitFor(() => expect(box().value).toBe(''))
    const sent = screen.getByText('Long words that run on and on').closest('li')!
    expect(scroll.place(sent).top).toBe(0)
    expect(scroll.top).toBe(1200)
    expect(scroll.top).toBeLessThan(scroll.bottom())
  })

  test('a send while a gap is below reads the newest page first, then brings its message into view', async () => {
    g1().page = 5
    g1().items = Array.from({ length: 12 }, (_, n) => said(`a${n}`, 60 - n))
    g1().firstUnread = 'a3'
    const scroll = stubGeometry()
    await openChatAt(GROUP)
    type('Mine')
    fireEvent.click(sendButton())
    await waitFor(() => expect(screen.getByText('Mine')).toBeTruthy())
    await quiet()
    expect(asked(/^\/groups\/g-1\/chat$/).map((call) => call.path)).toEqual(['/groups/g-1/chat'])
    expect(screen.queryByText('The words of a0')).toBeNull()
    expect(screen.getByText('The words of a11')).toBeTruthy()
    expect(line()).toBeNull()
    expect(scroll.top).toBe(scroll.bottom())
  })
})

// --- §5: the button to the newest ----------------------------------------------------------

describe('the button to the newest', () => {
  test('shows once the newest is more than 48px below the view’s foot, its name plain', async () => {
    g1().items = ten()
    const scroll = stubGeometry()
    await openChatAt(GROUP)
    expect(jump()).toBeNull()
    await scroll.at(scroll.bottom() - 48)
    expect(jump()).toBeNull()
    await scroll.at(scroll.bottom() - 49)
    expect(jump()!.getAttribute('aria-label')).toBe('Go to the newest message')
    expect(jump()!.querySelector('.dot')).toBeNull()
    // Inside the thread's frame, never over the box.
    expect(jump()!.closest('.threadframe')).not.toBeNull()
    expect(jump()!.closest('.thread')).toBeNull()
  })

  test('its dot for a message from someone else below the view, and none for your own', async () => {
    g1().items = ten()
    stubGeometry()
    await openChatAt(GROUP)
    say('group:g-1', mine('from-my-phone', 0))
    await check()
    expect(jump()!.getAttribute('aria-label')).toBe('Go to the newest message')
    say('group:g-1', said('new', 0))
    await check()
    expect(jump()!.getAttribute('aria-label')).toBe('Go to the newest message, new messages below')
    expect(jump()!.querySelector('.dot')?.getAttribute('aria-hidden')).toBe('true')
    // Never said to a screen reader as something a check brought.
    expect(told()).toEqual(['Leo Brandt: The words of new'])
  })

  test('none for what was reached before the chat opened: above the line, or all of a first read with no line', async () => {
    g1().items = ten()
    g1().firstUnread = 'a8'
    const scroll = stubGeometry()
    await openChatAt(GROUP)
    expect(line()).not.toBeNull()
    await scroll.at(0)
    expect(jump()!.getAttribute('aria-label')).toBe('Go to the newest message')
    expect(jump()!.querySelector('.dot')).toBeNull()
    // And still for what came after: a message from someone else arriving now.
    say('group:g-1', said('new', 0))
    await check()
    expect(jump()!.getAttribute('aria-label')).toBe('Go to the newest message, new messages below')
  })

  test('none, with no line, for anything the first read brought', async () => {
    g1().items = ten()
    const scroll = stubGeometry()
    await openChatAt(GROUP)
    expect(line()).toBeNull()
    await scroll.at(0)
    expect(jump()!.getAttribute('aria-label')).toBe('Go to the newest message')
    expect(jump()!.querySelector('.dot')).toBeNull()
  })

  test('a press goes to the newest, and the button goes, focus on the thread', async () => {
    g1().items = ten()
    const scroll = stubGeometry()
    await openChatAt(GROUP)
    say('group:g-1', said('new', 0))
    await check()
    fireEvent.click(jump()!)
    await waitFor(() => expect(jump()).toBeNull())
    expect(scroll.top).toBe(scroll.bottom())
    await waitFor(() => expect(document.activeElement).toBe(thread()))
  })

  test('across a gap: the newest page read first, in place of the list and with no line', async () => {
    g1().page = 5
    g1().items = thirty()
    g1().firstUnread = 'a3'
    const scroll = stubGeometry()
    await openChatAt(GROUP)
    expect(scroll.top).toBe(scroll.bottom())
    expect(jump()!.getAttribute('aria-label')).toBe('Go to the newest message, new messages below')
    fireEvent.click(jump()!)
    await waitFor(() => expect(screen.getByText('The words of a29')).toBeTruthy())
    await quiet()
    expect(asked(/^\/groups\/g-1\/chat$/).map((call) => call.path)).toEqual(['/groups/g-1/chat'])
    expect(screen.queryByText('The words of a0')).toBeNull()
    expect(line()).toBeNull()
    expect(jump()).toBeNull()
    expect(scroll.top).toBe(scroll.bottom())
    await waitFor(() => expect(document.activeElement).toBe(thread()))
  })
})

// --- §3: reading on, below -------------------------------------------------------------------

describe('reading on, below', () => {
  const twelve = () => Array.from({ length: 12 }, (_, n) => said(`a${n}`, 60 - n))

  test('the page after, asked for as the end nears, one at a time, added below without moving the view', async () => {
    g1().page = 5
    g1().items = twelve()
    g1().firstUnread = 'a3'
    const scroll = stubGeometry()
    stubObservers()
    const hold = gate()
    stage('GET', /after=/, { hold })
    renderApp(GROUP)
    await screen.findByRole('region', { name: 'Messages' })
    await waitFor(() => expect(asked(/after=/)).toHaveLength(1))
    await observers.look()
    await observers.look()
    expect(asked(/after=/)).toHaveLength(1)
    const top = scroll.top
    await act(async () => hold.release())
    await waitFor(() => expect(screen.getByText('The words of a9')).toBeTruthy())
    await quiet()
    expect(scroll.top).toBe(top)
    expect(asked(/after=/)).toHaveLength(1)
    await scroll.at(scroll.bottom())
    await waitFor(() => expect(screen.getByText('The words of a11')).toBeTruthy())
    await quiet()
    expect(asked(/after=/).map((call) => call.path)).toEqual(['/groups/g-1/chat?after=5', '/groups/g-1/chat?after=10'])
    expect(thread().querySelector('.sentinel')).toBeNull()
  })

  test('a page that failed says so at the foot, a status, with Try again', async () => {
    g1().page = 5
    g1().items = twelve()
    g1().firstUnread = 'a3'
    stubGeometry()
    stubObservers()
    stage('GET', /after=/, { status: 500 })
    await openChatAt(GROUP)
    const failed = await screen.findByText("Newer messages couldn't be loaded just now.")
    expect(failed.closest('[role="status"]')).not.toBeNull()
    expect(failed.closest('[role="alert"]')).toBeNull()
    expect(failed.compareDocumentPosition(box()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(within(failed.closest('[role="status"]') as HTMLElement).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getByText('The words of a9')).toBeTruthy())
    expect(screen.queryByText("Newer messages couldn't be loaded just now.")).toBeNull()
  })

  test('a 404 on it is the chat’s 404', async () => {
    g1().page = 5
    g1().items = twelve()
    g1().firstUnread = 'a3'
    stubGeometry()
    stubObservers()
    stage('GET', /after=/, { status: 404 })
    renderApp(GROUP)
    expect(await screen.findByRole('heading', { level: 1, name: 'Nothing here' })).toBeTruthy()
  })

  test('while a gap is below, a check adds nothing across it, and what it takes out still goes', async () => {
    g1().page = 5
    g1().items = twelve()
    g1().firstUnread = 'a3'
    await openChatAt(GROUP)
    say('group:g-1', said('new', 0))
    takeOut('group:g-1', 'a1')
    await check()
    expect(screen.queryByText('The words of new')).toBeNull()
    expect(screen.queryByText('The words of a1')).toBeNull()
    expect(screen.getByText('The words of a2')).toBeTruthy()
  })
})

// --- §6: the reading place ----------------------------------------------------------------------

describe('the reading place', () => {
  test('nothing is marked that was never seen', async () => {
    g1().items = ten()
    await openChatAt(GROUP)
    await quiet()
    expect(marksAsked()).toEqual([])
  })

  test('the newest entry whose foot has been in the view, never one below it, once and then forward', async () => {
    g1().items = thirty()
    g1().firstUnread = 'a20'
    const scroll = stubGeometry()
    stubObservers()
    await openChatAt(GROUP)
    await waitFor(() => expect(marksAsked()).toHaveLength(1))
    expect(marksAsked().map((call) => [call.path, call.body])).toEqual([['/groups/g-1/chat/read', { through: 'a22' }]])
    await scroll.at(2000)
    await scroll.at(2400)
    await waitFor(() => expect(marksAsked()).toHaveLength(2), { timeout: 3000 })
    expect(marksAsked().map((call) => call.body)).toEqual([{ through: 'a22' }, { through: 'a24' }])
    // Back up the thread, past the second's gap: nothing goes back.
    await scroll.at(0)
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 1200))))
    await observers.look()
    expect(marksAsked()).toHaveLength(2)
  })

  test('an entry taller than the view counts once it fills it, not at its top alone', async () => {
    g1().items = [...Array.from({ length: 6 }, (_, n) => said(`a${n}`, 60 - n)), said('long', 30)]
    g1().firstUnread = 'long'
    const scroll = stubGeometry((li) => (li.textContent?.includes('The words of long') ? 600 : 100))
    stubObservers()
    await openChatAt(GROUP)
    await observers.look()
    expect(scroll.top).toBe(800)
    expect(marksAsked()).toEqual([])
    await scroll.at(900)
    await waitFor(() => expect(marksAsked().map((call) => call.body)).toEqual([{ through: 'long' }]))
  })

  test('nothing while the tab is hidden, and what is in view once it returns', async () => {
    g1().items = ten()
    stubGeometry()
    stubObservers()
    await setHidden(true)
    await openChatAt(GROUP)
    await observers.look()
    expect(marksAsked()).toEqual([])
    await setHidden(false)
    await waitFor(() => expect(marksAsked().map((call) => call.body)).toEqual([{ through: 'a9' }]))
  })

  test('one still owed goes with keepalive as the page goes', async () => {
    g1().items = thirty()
    g1().firstUnread = 'a20'
    const scroll = stubGeometry()
    stubObservers()
    await openChatAt(GROUP)
    await waitFor(() => expect(marksAsked()).toHaveLength(1))
    await scroll.at(2400)
    expect(marksAsked()).toHaveLength(1)
    await go('/groups/g-1')
    expect(marksAsked().map((call) => [call.body, call.keepalive])).toEqual([
      [{ through: 'a22' }, false],
      [{ through: 'a24' }, true],
    ])
  })

  test('the open chat’s dot goes once its newest is seen and marked', async () => {
    world.chatsNew = { groups: ['g-1'], gatherings: [] }
    stubScreen({ wide: true })
    g1().items = ten()
    stubGeometry()
    stubObservers()
    await openChatAt(GROUP)
    await waitFor(() => expect(marksAsked().map((call) => call.body)).toEqual([{ through: 'a9' }]))
    await waitFor(() => expect(isNew(chatsNewNow(), { kind: 'group', id: 'g-1' })).toBe(false))
    const menu = screen.getByRole('navigation', { name: 'Main' })
    expect(menu.querySelector('.dot')).toBeNull()
  })
})

// --- §9 and §10: typing ---------------------------------------------------------------------------

describe('typing', () => {
  test('the header says who is typing in place of the count, each name kept in its place, never to the live region', async () => {
    await openChatAt(GROUP)
    expect(flat(header().textContent)).toBe('3 people · Chat')
    g1().typing = ['Kelly Brandt']
    await check()
    expect(flat(header().textContent)).toBe('Kelly Brandt is typing…')
    expect(header().classList.contains('typing')).toBe(true)
    expect(header().closest('[aria-live]')).toBeNull()
    g1().typing = ['Kelly Brandt', 'Leo Brandt']
    await check()
    expect(flat(header().textContent)).toBe('Kelly Brandt and Leo Brandt are typing…')
    g1().typing = ['Leo Brandt', 'Kelly Brandt']
    await check()
    expect(flat(header().textContent)).toBe('Kelly Brandt and Leo Brandt are typing…')
    g1().typing = ['Leo Brandt', 'Kelly Brandt', 'Ray Brandt']
    await check()
    expect(flat(header().textContent)).toBe('Several people are typing…')
    expect(told()).toEqual([])
    expect(live()?.textContent).toBe('')
    g1().typing = []
    await check()
    expect(flat(header().textContent)).toBe('3 people · Chat')
    expect(header().classList.contains('typing')).toBe(false)
    expect(told()).toEqual([])
  })

  test('a failed check and a hidden tab take it away', async () => {
    await openChatAt(GROUP)
    g1().typing = ['Kelly Brandt']
    await check()
    stage('GET', CHECKED, { status: 500 })
    await check()
    expect(flat(header().textContent)).toBe('3 people · Chat')
    await check()
    expect(flat(header().textContent)).toBe('Kelly Brandt is typing…')
    await setHidden(true)
    expect(flat(header().textContent)).toBe('3 people · Chat')
  })

  test('the box sends it on a check while its words changed in the last four seconds, and never on a page read', async () => {
    g1().page = 1
    g1().items = [said('a', 6), said('b', 5)]
    await openChatAt(GROUP)
    const lastCheck = () => asked(CHECKED).at(-1)!.path
    type('Hel')
    await check()
    expect(lastCheck()).toMatch(/ typing=1$/)
    vi.setSystemTime(NOW + 3999)
    await check()
    expect(lastCheck()).toMatch(/ typing=1$/)
    vi.setSystemTime(NOW + 4000)
    await check()
    expect(lastCheck()).not.toMatch(/typing/)
    type('Hello')
    fireEvent.click(screen.getByRole('button', { name: 'Show earlier messages' }))
    await screen.findByText('The words of a')
    expect(asked(/before=/).map((call) => call.path)).toEqual(['/groups/g-1/chat?before=1'])
    await check()
    expect(lastCheck()).toMatch(/ typing=1$/)
    type('   ')
    await check()
    expect(lastCheck()).not.toMatch(/typing/)
    type('Hi')
    fireEvent.click(sendButton())
    await waitFor(() => expect(box().value).toBe(''))
    await check()
    expect(lastCheck()).not.toMatch(/typing/)
  })
})
