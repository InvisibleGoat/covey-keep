// CK-91 — Your gatherings' view, stored on the device. The value under test:
// the key is `covey-keep:gatherings-view` and holds `cards` or `calendar`;
// exactly `calendar` is the Calendar view, and anything else, a missing key or
// storage that throws is Cards; a choice with throwing storage is held for the
// page load; and every subscriber hears a choice at once.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  chooseGatheringsView,
  GATHERINGS_VIEW_KEY,
  readGatheringsView,
  subscribeGatheringsView,
} from './gatheringsView'

beforeEach(() => localStorage.clear())
afterEach(() => {
  vi.restoreAllMocks()
  // A write that lands lets go of anything held for a page load.
  chooseGatheringsView('cards')
  localStorage.clear()
})

test('the key is covey-keep:gatherings-view', () => {
  expect(GATHERINGS_VIEW_KEY).toBe('covey-keep:gatherings-view')
})

test('exactly `calendar` is the Calendar view; cards, anything else and a missing key are Cards', () => {
  expect(readGatheringsView()).toBe('cards')
  localStorage.setItem(GATHERINGS_VIEW_KEY, 'calendar')
  expect(readGatheringsView()).toBe('calendar')
  for (const value of ['cards', 'Calendar', 'CALENDAR', ' calendar', '', 'grid', 'true']) {
    localStorage.setItem(GATHERINGS_VIEW_KEY, value)
    expect(readGatheringsView(), JSON.stringify(value)).toBe('cards')
  }
})

test('a choice is stored and heard by every subscriber at once, and an unsubscribed one hears nothing', () => {
  const heard = vi.fn()
  const stop = subscribeGatheringsView(heard)
  chooseGatheringsView('calendar')
  expect(localStorage.getItem(GATHERINGS_VIEW_KEY)).toBe('calendar')
  expect(heard).toHaveBeenCalledTimes(1)
  expect(readGatheringsView()).toBe('calendar')
  chooseGatheringsView('cards')
  expect(localStorage.getItem(GATHERINGS_VIEW_KEY)).toBe('cards')
  expect(heard).toHaveBeenCalledTimes(2)
  stop()
  chooseGatheringsView('calendar')
  expect(heard).toHaveBeenCalledTimes(2)
})

test('a storage whose write alone throws (a full quota) holds the choice for this page load, and a later write that lands lets go of it', () => {
  // The read still works here, so a read that asked storage first would answer
  // what was stored before and the switch would not move.
  localStorage.setItem(GATHERINGS_VIEW_KEY, 'cards')
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('quota')
  })
  const heard = vi.fn()
  const stop = subscribeGatheringsView(heard)
  chooseGatheringsView('calendar')
  expect(heard).toHaveBeenCalledTimes(1)
  expect(readGatheringsView()).toBe('calendar')
  // Nothing was stored, so the next page load is Cards.
  expect(localStorage.getItem(GATHERINGS_VIEW_KEY)).toBe('cards')
  stop()
  write.mockRestore()
  chooseGatheringsView('cards')
  expect(readGatheringsView()).toBe('cards')
  localStorage.setItem(GATHERINGS_VIEW_KEY, 'calendar')
  expect(readGatheringsView()).toBe('calendar')
})

test('storage that throws reads as Cards, and a choice is held for this page load', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  const heard = vi.fn()
  const stop = subscribeGatheringsView(heard)
  expect(readGatheringsView()).toBe('cards')
  chooseGatheringsView('calendar')
  expect(readGatheringsView()).toBe('calendar')
  chooseGatheringsView('cards')
  expect(readGatheringsView()).toBe('cards')
  expect(heard).toHaveBeenCalledTimes(2)
  stop()
})
