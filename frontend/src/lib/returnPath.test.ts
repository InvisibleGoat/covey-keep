// CK-79 — the sign-in return's store (lib/returnPath.ts). The value under
// test: only a same-origin relative path is ever honoured — every hostile
// shape refused, at park and at take; a fragment is never parked; a parked
// path is taken once and only while fresh; and storage that is missing,
// malformed or throwing answers null rather than breaking sign-in.
import { afterEach, expect, test, vi } from 'vitest'
import {
  clearReturnPath,
  isValidReturnPath,
  MAX_RETURN_PATH_LENGTH,
  parkReturnPath,
  RETURN_PATH_KEY,
  RETURN_PATH_TTL,
  takeReturnPath,
} from './returnPath'
import source from './returnPath.ts?raw'

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

const NOW = Date.UTC(2026, 9, 27, 18, 0, 0)

test('the key, the TTL and the bound: covey-keep:return-path, 30 minutes, 2,000 characters', () => {
  expect(RETURN_PATH_KEY).toBe('covey-keep:return-path')
  expect(RETURN_PATH_TTL).toBe(30 * 60 * 1000)
  expect(MAX_RETURN_PATH_LENGTH).toBe(2000)
})

test('valid paths are kept, with their query', () => {
  for (const path of [
    '/',
    '/home',
    '/groups/g-1',
    '/groups/g-1?x=1',
    '/plan?checkout=complete',
    '/gatherings/2f1c6d0e-0000-4000-8000-000000000001',
    '/groups/join',
    '/invitations/accept',
    '/a/b/c?x=1&y=two%20words',
  ]) {
    expect(isValidReturnPath(path)).toBe(true)
    parkReturnPath(path, NOW)
    expect(takeReturnPath(NOW + 1000)).toBe(path)
  }
})

test('every hostile shape is refused — parked, nothing is stored; stored by hand, nothing is honoured', () => {
  const hostile = [
    '//evil.example',
    '//evil.example/groups/g-1',
    'https://evil.example',
    'https://evil.example/groups/g-1',
    'http:/evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    '/groups\\..\\evil',
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,hi',
    'groups/g-1',
    '',
    ' /groups/g-1',
    '/\t/evil.example',
    '/\n/evil.example',
    '/groups/g 1',
    '/groups/g-1\u0000',
    '/' + 'a'.repeat(MAX_RETURN_PATH_LENGTH),
  ]
  for (const path of hostile) {
    expect(isValidReturnPath(path), JSON.stringify(path)).toBe(false)
    parkReturnPath(path, NOW)
    expect(localStorage.getItem(RETURN_PATH_KEY), JSON.stringify(path)).toBeNull()
    // Written by hand — whatever wrote storage — it is still refused on the
    // way out, and cleared.
    localStorage.setItem(RETURN_PATH_KEY, JSON.stringify({ path, parkedAt: NOW }))
    expect(takeReturnPath(NOW + 1000), JSON.stringify(path)).toBeNull()
    expect(localStorage.getItem(RETURN_PATH_KEY)).toBeNull()
  }
  // A non-string is never a path.
  for (const value of [null, undefined, 42, {}, ['/home']]) {
    expect(isValidReturnPath(value)).toBe(false)
  }
})

test('exactly at the bound is a path; one over is not', () => {
  const atBound = '/' + 'a'.repeat(MAX_RETURN_PATH_LENGTH - 1)
  expect(atBound).toHaveLength(MAX_RETURN_PATH_LENGTH)
  expect(isValidReturnPath(atBound)).toBe(true)
  expect(isValidReturnPath(atBound + 'a')).toBe(false)
})

test('a fragment is never parked: anything from # on is dropped, and a stored fragment is refused', () => {
  parkReturnPath('/groups/g-1?x=1#token=secret-abc', NOW)
  const stored = localStorage.getItem(RETURN_PATH_KEY) ?? ''
  expect(stored).not.toContain('#')
  expect(stored).not.toContain('secret-abc')
  expect(takeReturnPath(NOW + 1000)).toBe('/groups/g-1?x=1')

  parkReturnPath('/groups/join#token=abc', NOW)
  expect(takeReturnPath(NOW + 1000)).toBe('/groups/join')

  // A fragment alone leaves nothing to park.
  parkReturnPath('#token=abc', NOW)
  expect(localStorage.getItem(RETURN_PATH_KEY)).toBeNull()

  localStorage.setItem(RETURN_PATH_KEY, JSON.stringify({ path: '/groups/g-1#frag', parkedAt: NOW }))
  expect(takeReturnPath(NOW + 1000)).toBeNull()
})

test('fresh means within 30 minutes: at the TTL it is honoured, a moment past it is not, and a timestamp from the future reads as stale', () => {
  parkReturnPath('/plan', NOW)
  expect(takeReturnPath(NOW + RETURN_PATH_TTL)).toBe('/plan')

  parkReturnPath('/plan', NOW)
  expect(takeReturnPath(NOW + RETURN_PATH_TTL + 1)).toBeNull()
  expect(localStorage.getItem(RETURN_PATH_KEY)).toBeNull()

  parkReturnPath('/plan', NOW + 60_000)
  expect(takeReturnPath(NOW)).toBeNull()
})

test('takeReturnPath clears what it read — the second take is null', () => {
  parkReturnPath('/groups/g-1', NOW)
  expect(takeReturnPath(NOW + 1)).toBe('/groups/g-1')
  expect(localStorage.getItem(RETURN_PATH_KEY)).toBeNull()
  expect(takeReturnPath(NOW + 2)).toBeNull()
})

test('a newer park replaces the older, and an invalid park leaves what was parked alone', () => {
  parkReturnPath('/groups/g-1', NOW)
  parkReturnPath('/plan', NOW + 1)
  expect(takeReturnPath(NOW + 2)).toBe('/plan')

  parkReturnPath('/groups/g-1', NOW)
  parkReturnPath('//evil.example', NOW + 1)
  expect(takeReturnPath(NOW + 2)).toBe('/groups/g-1')
})

test('malformed storage answers null and is cleared: not JSON, the wrong shape, no timestamp, a non-number timestamp', () => {
  for (const raw of [
    'not json',
    '"/groups/g-1"',
    'null',
    '[]',
    JSON.stringify({ path: '/groups/g-1' }),
    JSON.stringify({ path: '/groups/g-1', parkedAt: 'yesterday' }),
    JSON.stringify({ path: '/groups/g-1', parkedAt: null }),
    JSON.stringify({ parkedAt: NOW }),
  ]) {
    localStorage.setItem(RETURN_PATH_KEY, raw)
    expect(takeReturnPath(NOW + 1), raw).toBeNull()
    expect(localStorage.getItem(RETURN_PATH_KEY)).toBeNull()
  }
})

test('nothing parked answers null', () => {
  expect(takeReturnPath(NOW)).toBeNull()
})

test('clearReturnPath removes what is parked', () => {
  parkReturnPath('/groups/g-1', NOW)
  clearReturnPath()
  expect(localStorage.getItem(RETURN_PATH_KEY)).toBeNull()
})

test('storage that throws: nothing parks, a take answers null, a clear does nothing — and none of them throws', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('QuotaExceededError')
  })
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('SecurityError')
  })
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw new DOMException('SecurityError')
  })
  expect(() => parkReturnPath('/groups/g-1', NOW)).not.toThrow()
  expect(takeReturnPath(NOW)).toBeNull()
  expect(() => clearReturnPath()).not.toThrow()
})

test('the module spells no product name — the brand rule', () => {
  expect(source.toLowerCase()).not.toMatch(/covey ?keep/)
})
