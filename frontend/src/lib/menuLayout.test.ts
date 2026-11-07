// CK-89 — the menu layout, stored on the device. The value under test: the key
// is `covey-keep:menu-layout` and holds `list` or `rail`; exactly `rail` is Rail
// and panel, and anything else, a missing key or storage that throws is One
// list; a choice with throwing storage is held for the page load; and every
// subscriber hears a choice at once.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { chooseMenuLayout, MENU_LAYOUT_KEY, readMenuLayout, subscribeMenuLayout } from './menuLayout'

beforeEach(() => localStorage.clear())
afterEach(() => {
  vi.restoreAllMocks()
  // A write that lands lets go of anything held for a page load.
  chooseMenuLayout('list')
  localStorage.clear()
})

test('the key is covey-keep:menu-layout', () => {
  expect(MENU_LAYOUT_KEY).toBe('covey-keep:menu-layout')
})

test('exactly `rail` is Rail and panel; list, anything else and a missing key are One list', () => {
  expect(readMenuLayout()).toBe('list')
  localStorage.setItem(MENU_LAYOUT_KEY, 'rail')
  expect(readMenuLayout()).toBe('rail')
  for (const value of ['list', 'Rail', 'RAIL', ' rail', '', 'discord', 'true']) {
    localStorage.setItem(MENU_LAYOUT_KEY, value)
    expect(readMenuLayout(), JSON.stringify(value)).toBe('list')
  }
})

test('a choice is stored and heard by every subscriber at once, and an unsubscribed one hears nothing', () => {
  const heard = vi.fn()
  const stop = subscribeMenuLayout(heard)
  chooseMenuLayout('rail')
  expect(localStorage.getItem(MENU_LAYOUT_KEY)).toBe('rail')
  expect(heard).toHaveBeenCalledTimes(1)
  expect(readMenuLayout()).toBe('rail')
  chooseMenuLayout('list')
  expect(localStorage.getItem(MENU_LAYOUT_KEY)).toBe('list')
  expect(heard).toHaveBeenCalledTimes(2)
  stop()
  chooseMenuLayout('rail')
  expect(heard).toHaveBeenCalledTimes(2)
})

test('a storage whose write alone throws (a full quota) holds the choice for this page load, and a later write that lands lets go of it', () => {
  // The read still works here, so a read that asked storage first would answer
  // what was stored before and the radio would not move.
  localStorage.setItem(MENU_LAYOUT_KEY, 'list')
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('quota')
  })
  const heard = vi.fn()
  const stop = subscribeMenuLayout(heard)
  chooseMenuLayout('rail')
  expect(heard).toHaveBeenCalledTimes(1)
  expect(readMenuLayout()).toBe('rail')
  // Nothing was stored, so the next page load is One list.
  expect(localStorage.getItem(MENU_LAYOUT_KEY)).toBe('list')
  stop()
  // The write works again: storage is the truth once more.
  write.mockRestore()
  chooseMenuLayout('list')
  expect(readMenuLayout()).toBe('list')
  localStorage.setItem(MENU_LAYOUT_KEY, 'rail')
  expect(readMenuLayout()).toBe('rail')
})

test('storage that throws reads as One list, and a choice is held for this page load', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  const heard = vi.fn()
  const stop = subscribeMenuLayout(heard)
  chooseMenuLayout('list')
  expect(readMenuLayout()).toBe('list')
  chooseMenuLayout('rail')
  expect(readMenuLayout()).toBe('rail')
  expect(heard).toHaveBeenCalledTimes(2)
  stop()
})
