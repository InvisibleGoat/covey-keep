// CK-103 — focus after an answer in the two chats: every row of THE DESIGN
// §12's table, through the real route table with the real AuthProvider, each
// request held on a released promise and focus dropped to the body by hand, as
// Chrome drops it from a disabled control; and a person who moved on keeping
// their place.
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { heldItem } from '../test-support/chat'
import {
  asked,
  box,
  chatOf,
  check,
  endWorld,
  go,
  mine,
  openChatAt,
  quiet,
  renderApp,
  said,
  say,
  sendButton,
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
import { dropFocusToBody, gate, pressHeld, settle } from '../test-support/focus'

const GROUP = '/groups/g-1/chat'
const g1 = () => chatOf('group:g-1')
const row = (text: string) => screen.getByText(text).closest('li')!
const button = (name: string | RegExp) => screen.getByRole<HTMLButtonElement>('button', { name })
const back = () => screen.getByRole('link', { name: 'Back to The Lees' })
const heading = () => screen.getByRole('heading', { level: 1 })
const active = () => document.activeElement

beforeEach(() => {
  startWorld()
  g1().items = [said('theirs', 6), mine('own', 5)]
})

afterEach(() => {
  cleanup()
  endWorld()
})

// Focus dropped to the body while a request waits, unless the person is
// somewhere the browser leaves them.
async function pressAndWait(control: HTMLElement, asking: RegExp, method: string, movedTo?: HTMLElement) {
  const before = asked(asking, method).length
  control.focus()
  fireEvent.click(control)
  await waitFor(() => expect(asked(asking, method).length).toBe(before + 1))
  if (movedTo) movedTo.focus()
  else dropFocusToBody()
}

async function release(hold: { release: () => void }) {
  await act(async () => hold.release())
  await settle()
}

// --- sending --------------------------------------------------------------------

describe('Send', () => {
  test('stays in the box, whether it lands or is refused', async () => {
    await openChatAt(GROUP)
    for (const status of [201, 500, 429]) {
      const hold = gate()
      stage('POST', /chat$/, status === 201 ? { hold } : { hold, status })
      type('Hello')
      box().focus()
      fireEvent.click(sendButton())
      await waitFor(() => expect(sendButton().disabled).toBe(true))
      expect(active()).toBe(box())
      await release(hold)
      expect(active()).toBe(box())
    }
  })

  test('puts a keyboard person’s focus in the box, off the control that goes quiet', async () => {
    const hold = gate()
    stage('POST', /chat$/, { hold })
    await openChatAt(GROUP)
    type('Hello')
    sendButton().focus()
    fireEvent.click(sendButton(), { detail: 0 })
    expect(active()).toBe(box())
    await release(hold)
    expect(active()).toBe(box())
  })

  test('leaves a person who moved on where they are', async () => {
    const hold = gate()
    stage('POST', /chat$/, { hold })
    await openChatAt(GROUP)
    type('Hello')
    box().focus()
    fireEvent.click(sendButton())
    await waitFor(() => expect(sendButton().disabled).toBe(true))
    back().focus()
    await release(hold)
    expect(active()).toBe(back())
  })
})

// --- deleting and removing -------------------------------------------------------

describe('Delete and Remove', () => {
  test('the word opens its step on the step, and Keep it goes back to the word', async () => {
    g1().moderate = true
    await openChatAt(GROUP)
    for (const word of ['Delete your message', "Remove Leo Brandt's message"]) {
      const opener = button(word)
      opener.focus()
      fireEvent.click(opener)
      await settle()
      const step = screen.getByRole('group')
      expect(active()).toBe(step)
      expect(step.getAttribute('tabindex')).toBe('-1')
      fireEvent.click(within(step).getByRole('button', { name: 'Keep it' }))
      await settle()
      expect(active()).toBe(button(word))
    }
  })

  test('a second press on the keyboard confirms nothing', async () => {
    await openChatAt(GROUP)
    const opener = button('Delete your message')
    opener.focus()
    fireEvent.click(opener)
    await settle()
    expect(within(screen.getByRole('group')).queryAllByRole('button').includes(active() as HTMLElement)).toBe(false)
    expect(asked(/remove$/, 'POST')).toEqual([])
  })

  async function openStep(word: string) {
    const opener = button(word)
    opener.focus()
    fireEvent.click(opener)
    await settle()
    return screen.getByRole('group')
  }

  test('landing, for someone who does not run the chat: the thread', async () => {
    const hold = gate()
    stage('POST', /remove$/, { hold })
    await openChatAt(GROUP)
    const step = await openStep('Delete your message')
    await pressHeld(within(step).getByRole('button', { name: 'Delete' }), hold)
    expect(screen.queryByText('The words of own')).toBeNull()
    expect(active()).toBe(thread())
  })

  test('landing, for someone who runs it: the held row’s Show it', async () => {
    g1().moderate = true
    const hold = gate()
    await openChatAt(GROUP)
    const step = await openStep("Remove Leo Brandt's message")
    stage('GET', /since=/, { hold })
    await pressAndWait(within(step).getByRole('button', { name: 'Remove' }), /since=/, 'GET')
    // While it waits, nothing takes focus.
    expect(active()).toBe(document.body)
    await release(hold)
    expect(active()).toBe(button('Show it'))
    expect((active() as HTMLElement).closest('.heldrow')).not.toBeNull()
  })

  test('landing on one someone had already removed: its own Show it, not another’s', async () => {
    g1().moderate = true
    g1().items = [heldItem(said('before', 9)), said('theirs', 6)]
    await openChatAt(GROUP)
    const step = await openStep("Remove Leo Brandt's message")
    takeOut('group:g-1', 'theirs', { by: 'Kelly Brandt', by_self: false })
    // MOVED AT CK-105, with its reason: the answer was not held, so under load
    // it and the check it asks for could land inside pressAndWait's wait,
    // before its drop of focus to the body, which then took focus off the
    // landed Show it (seen with a blur listener); held now, as the file's
    // other tests hold theirs, and a waitFor in place of a fixed 30 ms sleep
    // before what must happen (the Gotcha's rule 3).
    const hold = gate()
    stage('POST', /remove$/, { hold, status: 409, body: { detail: { code: 'already_removed' } } })
    await pressAndWait(within(step).getByRole('button', { name: 'Remove' }), /remove$/, 'POST')
    await release(hold)
    await waitFor(() => expect((active() as HTMLElement).closest('.heldrow')?.textContent).toContain('Kelly Brandt removed'))
  })

  test('a 404: the thread', async () => {
    g1().moderate = true
    const hold = gate()
    stage('POST', /remove$/, { hold, status: 404 })
    await openChatAt(GROUP)
    const step = await openStep("Remove Leo Brandt's message")
    await pressHeld(within(step).getByRole('button', { name: 'Remove' }), hold)
    expect(active()).toBe(thread())
  })

  test.each([
    ['refused', { status: 500 }],
    ['never arriving', { network: true }],
  ])('%s: the step’s red button', async (_name, how) => {
    const hold = gate()
    stage('POST', /remove$/, { hold, ...how })
    await openChatAt(GROUP)
    const step = await openStep('Delete your message')
    const red = within(step).getByRole<HTMLButtonElement>('button', { name: 'Delete' })
    await pressHeld(red, hold)
    expect(active()).toBe(red)
    expect(red.disabled).toBe(false)
  })

  test('a person who moved on keeps their place, landing and failing', async () => {
    for (const how of [{}, { status: 500 }]) {
      const hold = gate()
      stage('POST', /remove$/, { hold, ...how })
      await openChatAt(GROUP)
      const step = await openStep('Delete your message')
      await pressHeld(within(step).getByRole('button', { name: 'Delete' }), hold, box())
      expect(active()).toBe(box())
      cleanup()
      g1().items = [said('theirs', 6), mine('own', 5)]
      g1().removed = []
      g1().changes = []
    }
  })

  test('a person who moved to another message keeps their place', async () => {
    g1().items.push(mine('second', 4))
    const hold = gate()
    stage('POST', /remove$/, { hold, status: 500 })
    await openChatAt(GROUP)
    const opener = within(row('The words of own')).getByRole('button', { name: 'Delete your message' })
    fireEvent.click(opener)
    await settle()
    const other = within(row('The words of second')).getByRole('button')
    await pressHeld(within(screen.getByRole('group')).getByRole('button', { name: 'Delete' }), hold, other)
    expect(active()).toBe(other)
  })

  test('a message that goes while its step is open: focus inside the step to the thread', async () => {
    g1().moderate = true
    await openChatAt(GROUP)
    const step = await openStep("Remove Leo Brandt's message")
    within(step).getByRole('button', { name: 'Keep it' }).focus()
    takeOut('group:g-1', 'theirs', { by: 'Kelly Brandt', by_self: false })
    await check()
    expect(screen.queryByRole('group')).toBeNull()
    expect(active()).toBe(thread())
  })

  test('a message that goes while its step is open: focus anywhere else stays', async () => {
    g1().moderate = true
    await openChatAt(GROUP)
    await openStep("Remove Leo Brandt's message")
    box().focus()
    takeOut('group:g-1', 'theirs', { by: 'Kelly Brandt', by_self: false })
    await check()
    expect(active()).toBe(box())
  })
})

// --- a held message ----------------------------------------------------------------

test('Show it and Hide it stay on the one button', async () => {
  g1().moderate = true
  g1().items = [heldItem(said('a', 30)), said('b', 5)]
  await openChatAt(GROUP)
  const toggle = button('Show it')
  toggle.focus()
  fireEvent.click(toggle)
  await settle()
  expect(active()).toBe(toggle)
  expect(toggle.textContent).toBe('Hide it')
  fireEvent.click(toggle)
  await settle()
  expect(active()).toBe(toggle)
})

// --- earlier messages ----------------------------------------------------------------

describe('Show earlier messages', () => {
  async function open() {
    g1().page = 1
    g1().items = [said('a', 6), said('b', 5), said('c', 4)]
    await openChatAt(GROUP)
    return button('Show earlier messages')
  }

  test('the button while it is there, the thread once it has gone', async () => {
    const show = await open()
    for (const last of [false, true]) {
      const hold = gate()
      stage('GET', /before=/, { hold })
      await pressAndWait(show, /before=/, 'GET')
      expect(show.disabled).toBe(true)
      await release(hold)
      if (last) {
        expect(show.isConnected).toBe(false)
        expect(active()).toBe(thread())
      } else {
        expect(active()).toBe(show)
        expect(show.disabled).toBe(false)
      }
    }
  })

  test('a failure: the button', async () => {
    const show = await open()
    const hold = gate()
    stage('GET', /before=/, { hold, status: 500 })
    await pressHeld(show, hold)
    expect(active()).toBe(show)
  })

  test('a person who moved on keeps their place', async () => {
    const show = await open()
    const hold = gate()
    stage('GET', /before=/, { hold })
    await pressHeld(show, hold, box())
    expect(active()).toBe(box())
  })
})

// --- the screen that could not be read -------------------------------------------------

describe('Try again', () => {
  async function openFailed() {
    // MOVED AT CK-105, with its reason: the first read is `?open=true` (THE DESIGN §1).
    stage('GET', /^\/groups\/g-1\/chat\?open=true$/, { status: 500 })
    renderApp(GROUP)
    await screen.findByRole('heading', { name: 'Something went wrong' })
    await quiet()
    return button('Try again')
  }

  test('landing: the h1', async () => {
    const again = await openFailed()
    const hold = gate()
    // MOVED AT CK-105, with its reason: the first read is `?open=true` (THE DESIGN §1).
    stage('GET', /^\/groups\/g-1\/chat\?open=true$/, { hold })
    await pressHeld(again, hold)
    expect(heading().textContent).toBe('The Lees')
    expect(active()).toBe(heading())
  })

  test('failing again: the new Try again', async () => {
    const again = await openFailed()
    const hold = gate()
    // MOVED AT CK-105, with its reason: the first read is `?open=true` (THE DESIGN §1).
    stage('GET', /^\/groups\/g-1\/chat\?open=true$/, { hold, status: 500 })
    await pressHeld(again, hold)
    expect(button('Try again')).not.toBe(again)
    expect(active()).toBe(button('Try again'))
  })

  test('landing on no chat: the not-found h1', async () => {
    const again = await openFailed()
    const hold = gate()
    // MOVED AT CK-105, with its reason: the first read is `?open=true` (THE DESIGN §1).
    stage('GET', /^\/groups\/g-1\/chat\?open=true$/, { hold, status: 404 })
    await pressHeld(again, hold)
    expect(heading().textContent).toBe('Nothing here')
    expect(active()).toBe(heading())
  })
})

// --- a 404 while it is open -----------------------------------------------------------

describe('a 404 while it is open', () => {
  test('on a check: the not-found h1', async () => {
    await openChatAt(GROUP)
    box().focus()
    delete world.groups['g-1']
    await check()
    await settle()
    expect(heading().textContent).toBe('Nothing here')
    expect(active()).toBe(heading())
  })

  test('on a send: the not-found h1', async () => {
    await openChatAt(GROUP)
    type('Hello')
    box().focus()
    stage('POST', /chat$/, { status: 404 })
    fireEvent.click(sendButton())
    await screen.findByRole('heading', { name: 'Nothing here' })
    await settle()
    expect(active()).toBe(heading())
  })

  test('on an earlier page: the not-found h1', async () => {
    g1().page = 1
    const hold = gate()
    stage('GET', /before=/, { hold, status: 404 })
    await openChatAt(GROUP)
    await pressHeld(button('Show earlier messages'), hold)
    expect(heading().textContent).toBe('Nothing here')
    expect(active()).toBe(heading())
  })

  test('at the first read: the not-found h1', async () => {
    renderApp('/groups/g-none/chat')
    await screen.findByRole('heading', { name: 'Nothing here' })
    await settle()
    expect(active()).toBe(heading())
  })

  test('a person in the menu keeps their place', async () => {
    stubScreen({ wide: true })
    await openChatAt(GROUP)
    const link = within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'You' })
    link.focus()
    delete world.groups['g-1']
    await check()
    await settle()
    expect(active()).toBe(link)
  })
})

// --- what never moves focus ---------------------------------------------------------------

describe('a check', () => {
  test('moves no focus, whatever it brings', async () => {
    g1().moderate = true
    await openChatAt(GROUP)
    for (const place of [box(), back(), thread(), button('Delete your message')]) {
      place.focus()
      say('group:g-1', said(`n-${asked(/since=/).length}`, 0))
      await check()
      await settle()
      expect(active()).toBe(place)
    }
    dropFocusToBody()
    takeOut('group:g-1', 'theirs')
    await check()
    await settle()
    expect(active()).toBe(document.body)
  })

  test('that fails moves none either', async () => {
    await openChatAt(GROUP)
    box().focus()
    stage('GET', /since=/, { status: 500 })
    await check()
    await settle()
    expect(active()).toBe(box())
  })
})

test('opening a chat by a link, or by Back, moves no focus', async () => {
  await openChatAt(GROUP)
  await settle()
  expect(active()).toBe(document.body)
  await go('/groups/g-1')
  await screen.findByRole('button', { name: 'Open menu' })
  await go(-1)
  await screen.findByRole('region', { name: 'Messages' })
  await settle()
  expect(active()).toBe(document.body)
})

// --- the drawer's row ------------------------------------------------------------------------

describe('the drawer’s Chat row', () => {
  async function openDrawer() {
    localStorage.setItem('covey-keep:menu-layout', 'rail')
    renderApp('/groups/g-1', { strict: true })
    fireEvent.click(await screen.findByRole('button', { name: 'Open menu' }))
    const dialog = screen.getByRole('dialog', { name: 'Menu' })
    const chat = await within(dialog).findByRole('link', { name: /^Chat/ })
    await quiet()
    return chat
  }

  test('closes the drawer on the chat’s h1, once the chat has landed', async () => {
    const chat = await openDrawer()
    const hold = gate()
    // MOVED AT CK-105, with its reason: the first read is `?open=true` (THE DESIGN §1).
    stage('GET', /^\/groups\/g-1\/chat\?open=true$/, { hold, always: true })
    chat.focus()
    fireEvent.click(chat)
    await screen.findByText('Loading…', { selector: 'main p' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.querySelector('.frame-side')!.contains(active())).toBe(false)
    await release(hold)
    await screen.findByRole('region', { name: 'Messages' })
    await waitFor(() => expect(active()).toBe(heading()))
    expect(heading().textContent).toBe('The Lees')
    expect(heading().getAttribute('tabindex')).toBe('-1')
  })

  test('landing on a chat that could not be read: its h1', async () => {
    const chat = await openDrawer()
    // MOVED AT CK-105, with its reason: the first read is `?open=true` (THE DESIGN §1).
    stage('GET', /^\/groups\/g-1\/chat\?open=true$/, { status: 500, always: true })
    chat.focus()
    fireEvent.click(chat)
    await screen.findByRole('heading', { name: 'Something went wrong' })
    await waitFor(() => expect(active()).toBe(heading()))
  })

  test('a person who moved on before it landed keeps their place, and it is owed to no other chat', async () => {
    const chat = await openDrawer()
    chat.focus()
    fireEvent.click(chat)
    await screen.findByRole('region', { name: 'Messages' })
    await waitFor(() => expect(active()).toBe(heading()))
    dropFocusToBody()
    await go('/groups/g-2/chat')
    await screen.findByRole('textbox', { name: 'Message Finch' })
    await settle()
    expect(active()).toBe(document.body)
  })

  test('any other row still returns focus to the menu button', async () => {
    await openDrawer()
    const people = within(screen.getByRole('dialog', { name: 'Menu' })).getByRole('link', { name: /^People/ })
    people.focus()
    fireEvent.click(people)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(active()).toBe(screen.getByRole('button', { name: 'Open menu' })))
  })
})

// --- the second pair (CK-105; THE DESIGN §12's new rows) --------------------------------------

describe('reactions', () => {
  const theirsRow = () => row('The words of theirs')
  const react = () => within(theirsRow()).getByRole<HTMLButtonElement>('button', { name: /^React to / })
  const pickerButton = (name: string) =>
    within(within(theirsRow()).getByRole('group', { name: 'Choose a reaction' })).getByRole<HTMLButtonElement>('button', {
      name,
    })
  const chip = (name: string | RegExp) => within(theirsRow()).getByRole<HTMLButtonElement>('button', { name })

  beforeEach(() => {
    g1().items = [
      said('theirs', 6, {
        reactions: [
          { kind: 'like', count: 2, mine: true },
          { kind: 'heart', count: 1, mine: false },
        ],
      }),
      mine('own', 5, { reactions: [] }),
    ]
  })

  test('React opens on the picker’s first button, and React again goes back to React', async () => {
    await openChatAt(GROUP)
    react().focus()
    fireEvent.click(react())
    await waitFor(() => expect(active()).toBe(pickerButton('Like')))
    fireEvent.click(react())
    await waitFor(() => expect(active()).toBe(react()))
  })

  test('a picker button: landing, React; failing, the button, the picker still open', async () => {
    await openChatAt(GROUP)
    fireEvent.click(react())
    let hold = gate()
    stage('PUT', /reactions$/, { hold })
    await pressAndWait(pickerButton('Heart'), /reactions$/, 'PUT')
    await release(hold)
    expect(active()).toBe(react())
    fireEvent.click(react())
    hold = gate()
    stage('PUT', /reactions$/, { hold, status: 500 })
    await pressAndWait(pickerButton('Laughing'), /reactions$/, 'PUT')
    await release(hold)
    expect(active()).toBe(pickerButton('Laughing'))
  })

  test('a chip: landing, the same kind’s chip, or React where it went; failing, the chip', async () => {
    await openChatAt(GROUP)
    let hold = gate()
    stage('PUT', /reactions$/, { hold })
    await pressAndWait(chip('Heart, 1'), /reactions$/, 'PUT')
    await release(hold)
    expect(active()).toBe(chip('Heart, 2'))
    hold = gate()
    stage('PUT', /reactions$/, { hold, network: true })
    await pressAndWait(chip('Like, 2'), /reactions$/, 'PUT')
    await release(hold)
    expect(active()).toBe(chip('Like, 2'))
    // The caller's alone on that kind: taken back, its chip goes.
    const alone = said('theirs', 6, { reactions: [{ kind: 'sad', count: 1, mine: true }] })
    g1().items[0] = alone
    g1().changes.push(alone)
    delete world.tables.theirs
    await check()
    hold = gate()
    stage('PUT', /reactions$/, { hold })
    await pressAndWait(chip('Sad, 1'), /reactions$/, 'PUT')
    await release(hold)
    expect(active()).toBe(react())
  })

  test('a 404: React where the message stays, the thread where it has gone', async () => {
    await openChatAt(GROUP)
    let hold = gate()
    stage('PUT', /reactions$/, { hold, status: 404 })
    await pressAndWait(chip('Heart, 1'), /reactions$/, 'PUT')
    await release(hold)
    await quiet()
    expect(active()).toBe(react())
    takeOut('group:g-1', 'theirs')
    hold = gate()
    stage('PUT', /reactions$/, { hold, status: 404 })
    await pressAndWait(chip('Heart, 1'), /reactions$/, 'PUT')
    await release(hold)
    await quiet()
    expect(screen.queryByText('The words of theirs')).toBeNull()
    expect(active()).toBe(thread())
  })

  test('a person who moved on keeps their place, landing and failing', async () => {
    await openChatAt(GROUP)
    for (const how of [{}, { status: 500 }]) {
      const hold = gate()
      stage('PUT', /reactions$/, { hold, ...how })
      await pressAndWait(chip(/^Heart/), /reactions$/, 'PUT', back())
      await release(hold)
      expect(active()).toBe(back())
    }
  })
})

describe('the button to the newest', () => {
  const jump = () => screen.getByRole<HTMLButtonElement>('button', { name: /^Go to the newest message/ })

  beforeEach(() => {
    g1().page = 5
    g1().items = Array.from({ length: 12 }, (_, n) => said(`a${n}`, 60 - n))
    g1().firstUnread = 'a3'
  })

  test('landing: the thread', async () => {
    await openChatAt(GROUP)
    const hold = gate()
    stage('GET', /^\/groups\/g-1\/chat$/, { hold })
    await pressAndWait(jump(), /^\/groups\/g-1\/chat$/, 'GET')
    await release(hold)
    expect(active()).toBe(thread())
  })

  test('failing: the button', async () => {
    await openChatAt(GROUP)
    const hold = gate()
    stage('GET', /^\/groups\/g-1\/chat$/, { hold, status: 500 })
    await pressAndWait(jump(), /^\/groups\/g-1\/chat$/, 'GET')
    await release(hold)
    expect(active()).toBe(jump())
  })

  test('a person who moved on keeps their place', async () => {
    await openChatAt(GROUP)
    const hold = gate()
    stage('GET', /^\/groups\/g-1\/chat$/, { hold })
    await pressAndWait(jump(), /^\/groups\/g-1\/chat$/, 'GET', back())
    await release(hold)
    expect(active()).toBe(back())
  })
})

describe('Try again on newer messages', () => {
  const failedLine = "Newer messages couldn't be loaded just now."
  const tryAgain = () =>
    within(screen.getByText(failedLine).closest('[role="status"]') as HTMLElement).getByRole<HTMLButtonElement>('button', {
      name: 'Try again',
    })

  beforeEach(() => {
    g1().page = 5
    g1().items = Array.from({ length: 12 }, (_, n) => said(`a${n}`, 60 - n))
    g1().firstUnread = 'a3'
    stubGeometry()
    stubObservers()
    stage('GET', /after=/, { status: 500 })
  })

  test('landing: the first newer entry’s row', async () => {
    await openChatAt(GROUP)
    await screen.findByText(failedLine)
    const hold = gate()
    stage('GET', /after=/, { hold })
    await pressAndWait(tryAgain(), /after=/, 'GET')
    await release(hold)
    expect(active()).toBe(row('The words of a5'))
  })

  test('failing again: the new Try again', async () => {
    await openChatAt(GROUP)
    await screen.findByText(failedLine)
    const hold = gate()
    stage('GET', /after=/, { hold, status: 500 })
    await pressAndWait(tryAgain(), /after=/, 'GET')
    await release(hold)
    expect(active()).toBe(tryAgain())
  })

  test('a person who moved on keeps their place', async () => {
    await openChatAt(GROUP)
    await screen.findByText(failedLine)
    const hold = gate()
    stage('GET', /after=/, { hold })
    await pressAndWait(tryAgain(), /after=/, 'GET', back())
    await release(hold)
    expect(active()).toBe(back())
  })
})
