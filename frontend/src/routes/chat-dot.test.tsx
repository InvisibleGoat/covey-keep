// CK-105 — the dot for something new in a chat (THE DESIGN §8 of its kickoff,
// approved by Steven on 2026-11-26): from one store that reads GET /chats/new
// with the menu's reads, drawn in both menu layouts and on both Chat cards,
// through the app's real route table with the REAL AuthProvider over the real
// session store, against the fake server in test-support/chatWorld.ts.
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { chatsNewNow, isNew } from '../lib/chatsNew'
import {
  asked,
  endWorld,
  go,
  quiet,
  renderApp,
  stage,
  startWorld,
  world,
} from '../test-support/chatWorld'

const flat = (words: string | null | undefined) => (words ?? '').replace(/\s+/g, ' ').trim()
const chatsNewAsked = () => asked(/^\/chats\/new$/)
const main = () => screen.getByRole('main')
const menu = () => screen.getByRole('navigation', { name: 'Main' })
const rowIn = (scope: HTMLElement, name: string) =>
  within(scope).getByText(name, { selector: 'b' }).closest('a')!

// A row's dot: the mark, hidden from a screen reader, and the words for one.
function dotOf(element: Element) {
  const mark = element.querySelector('.dot')
  const words = [...element.querySelectorAll('.visually-hidden')].map((one) => one.textContent)
  return { mark: mark?.getAttribute('aria-hidden') ?? null, words }
}

async function openAt(at: string) {
  renderApp(at)
  await screen.findByRole('navigation', { name: 'Main' })
  await quiet()
}

beforeEach(() => {
  startWorld({ wide: true })
  world.chatsNew = { groups: ['g-1'], gatherings: ['x-1', 'x-2'] }
})

afterEach(() => {
  cleanup()
  endWorld()
})

describe('in One list', () => {
  test('on a group’s row and a coming-up gathering’s row with something new, from one read with the menu’s', async () => {
    await openAt('/groups/g-2')
    expect(chatsNewAsked()).toHaveLength(1)
    const lees = rowIn(menu(), 'The Lees')
    expect(dotOf(lees)).toEqual({ mark: 'true', words: [' New messages'] })
    expect(flat(lees.textContent)).toContain('The Lees New messages')
    expect(dotOf(rowIn(menu(), 'Finch'))).toEqual({ mark: null, words: [] })
    expect(dotOf(rowIn(menu(), 'Dinner'))).toEqual({ mark: 'true', words: [' New messages'] })
    expect(dotOf(rowIn(menu(), 'Picnic'))).toEqual({ mark: null, words: [] })
  })

  test('read again with the menu’s reads, on each page change', async () => {
    await openAt('/groups/g-2')
    world.chatsNew = { groups: [], gatherings: [] }
    await go('/gatherings')
    await quiet()
    expect(chatsNewAsked()).toHaveLength(2)
    expect(menu().querySelector('.dot')).toBeNull()
  })

  test('beside the menu’s lists and never inside them: a list read that failed still reads it', async () => {
    stage('GET', /^\/groups$/, { status: 500, always: true })
    await openAt('/gatherings')
    expect(await screen.findByText("Your groups and gatherings couldn't be loaded just now.")).toBeTruthy()
    expect(chatsNewAsked()).toHaveLength(1)
    expect(isNew(chatsNewNow(), { kind: 'group', id: 'g-1' })).toBe(true)
  })

  test('a read that failed draws nothing', async () => {
    stage('GET', /^\/chats\/new$/, { status: 500 })
    await openAt('/groups/g-2')
    expect(chatsNewAsked()).toHaveLength(1)
    expect(document.querySelector('.dot')).toBeNull()
  })
})

describe('in Rail and panel', () => {
  beforeEach(() => localStorage.setItem('covey-keep:menu-layout', 'rail'))

  test('on a group’s tile, named for it, and on Home’s gathering rows', async () => {
    await openAt('/groups')
    const rail = screen.getByRole('navigation', { name: 'Your groups' })
    const lees = within(rail).getByRole('link', { name: 'The Lees, new messages' })
    expect(lees.querySelector('.dot')?.getAttribute('aria-hidden')).toBe('true')
    expect(within(rail).getByRole('link', { name: 'Finch' }).querySelector('.dot')).toBeNull()
    expect(dotOf(rowIn(menu(), 'Dinner'))).toEqual({ mark: 'true', words: [' New messages'] })
    expect(dotOf(rowIn(menu(), 'Picnic'))).toEqual({ mark: null, words: [] })
    expect(dotOf(rowIn(menu(), 'Book Club'))).toEqual({ mark: 'true', words: [' New messages'] })
  })

  test('on a group panel’s Chat row and its gathering rows', async () => {
    await openAt('/groups/g-1')
    expect(dotOf(rowIn(menu(), 'Chat'))).toEqual({ mark: 'true', words: [' New messages'] })
    expect(dotOf(rowIn(menu(), 'People'))).toEqual({ mark: null, words: [] })
    expect(dotOf(rowIn(menu(), 'Dinner'))).toEqual({ mark: 'true', words: [' New messages'] })
    expect(dotOf(rowIn(menu(), 'Picnic'))).toEqual({ mark: null, words: [] })
    await go('/groups/g-2')
    await quiet()
    expect(dotOf(rowIn(menu(), 'Chat'))).toEqual({ mark: null, words: [] })
  })
})

describe('on the Chat cards', () => {
  test('a group’s and a gathering’s, read from the store and never asked for', async () => {
    await openAt('/groups/g-1')
    const card = () => screen.getByRole('heading', { level: 2, name: /^Chat/ })
    expect(dotOf(card())).toEqual({ mark: 'true', words: [' New messages'] })
    await go('/gatherings/x-1')
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Dinner' })).toBeTruthy())
    await quiet()
    expect(dotOf(card())).toEqual({ mark: 'true', words: [' New messages'] })
    await go('/gatherings/x-4')
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Picnic' })).toBeTruthy())
    await quiet()
    expect(dotOf(card())).toEqual({ mark: null, words: [] })
    // The menu's three reads alone: the cards ask nothing of their own.
    expect(chatsNewAsked()).toHaveLength(3)
  })
})

describe('nowhere else', () => {
  test('not on the lists’ cards, nor the bottom bar’s tabs', async () => {
    cleanup()
    endWorld()
    startWorld()
    world.chatsNew = { groups: ['g-1', 'g-2'], gatherings: ['x-1', 'x-2'] }
    renderApp('/groups')
    await screen.findByRole('heading', { level: 1, name: 'Groups' })
    await quiet()
    expect(main().querySelector('.dot')).toBeNull()
    expect(document.querySelector('.tabbar')!.querySelector('.dot')).toBeNull()
    await go('/gatherings')
    await screen.findByRole('heading', { level: 1, name: 'Your gatherings' })
    await quiet()
    expect(main().querySelector('.dot')).toBeNull()
  })
})

describe('the session', () => {
  test('signing out empties it', async () => {
    await openAt('/you')
    expect(isNew(chatsNewNow(), { kind: 'group', id: 'g-1' })).toBe(true)
    await act(async () => void fireEvent.click(screen.getByText('Sign out').closest('button')!))
    await waitFor(() => expect(isNew(chatsNewNow(), { kind: 'group', id: 'g-1' })).toBe(false))
    expect(isNew(chatsNewNow(), { kind: 'gathering', id: 'x-1' })).toBe(false)
  })
})
