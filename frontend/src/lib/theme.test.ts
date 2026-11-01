// CK-82 — the theme, stored on the device. The value under test: the key is
// `covey-keep:theme` and holds `light` or `dark`; exactly `dark` reads as
// dark, and anything else, a missing key or storage that throws reads as
// light; choosing applies the attribute at once and stores it, and a storage
// failure still applies it for this page load. And index.html's pre-paint
// script — the one other place that touches the key — sits in <head> before
// the bundle, reads that key and nothing else, is wrapped in try, and sets
// dark for exactly `dark` and for nothing else, so a person who chose dark
// never sees a flash of light.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import indexHtml from '../../index.html?raw'
import { chooseTheme, readTheme, THEME_KEY } from './theme'

function resetTheme() {
  document.documentElement.setAttribute('data-theme', 'light')
  localStorage.clear()
}

beforeEach(resetTheme)

afterEach(() => {
  vi.restoreAllMocks()
  resetTheme()
})

test('the key is covey-keep:theme', () => {
  expect(THEME_KEY).toBe('covey-keep:theme')
})

test('exactly `dark` reads as dark; light, anything else and a missing key read as light', () => {
  expect(readTheme()).toBe('light')
  localStorage.setItem(THEME_KEY, 'dark')
  expect(readTheme()).toBe('dark')
  for (const value of ['light', 'sepia', 'Dark', 'DARK', ' dark', '', 'true', '{"theme":"dark"}']) {
    localStorage.setItem(THEME_KEY, value)
    expect(readTheme(), JSON.stringify(value)).toBe('light')
  }
})

test('storage that throws reads as light at load', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  expect(readTheme()).toBe('light')
})

test('choosing applies the attribute at once and stores the choice', () => {
  chooseTheme('dark')
  expect(document.documentElement.dataset.theme).toBe('dark')
  expect(localStorage.getItem(THEME_KEY)).toBe('dark')
  chooseTheme('light')
  expect(document.documentElement.dataset.theme).toBe('light')
  expect(localStorage.getItem(THEME_KEY)).toBe('light')
})

test('a storage failure still applies the choice for this page load', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('quota')
  })
  expect(() => chooseTheme('dark')).not.toThrow()
  expect(document.documentElement.dataset.theme).toBe('dark')
  // Storage reads, but holds nothing: the stored choice is still light.
  expect(localStorage.getItem(THEME_KEY)).toBeNull()
})

// ---------------------------------------------------------------------------
// index.html's pre-paint script.
// ---------------------------------------------------------------------------

const scripts = [...indexHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
const inline = scripts.filter(([, attributes]) => !/\bsrc=/.test(attributes))
const prePaint = inline[0]?.[2] ?? ''

function runPrePaint() {
  new Function(prePaint)()
}

test('the pre-paint script: one inline script, in <head>, before the bundle', () => {
  expect(inline).toHaveLength(1)
  const at = indexHtml.indexOf(inline[0][0])
  expect(at).toBeGreaterThan(indexHtml.indexOf('<head>'))
  expect(at).toBeLessThan(indexHtml.indexOf('</head>'))
  // It is the first script in the file, so it runs before the stylesheet or
  // the bundle loads.
  expect(scripts[0][0]).toBe(inline[0][0])
  expect(at).toBeLessThan(indexHtml.indexOf('<script type="module"'))
  // And the static light it refines is on <html> before it.
  expect(indexHtml.indexOf('<html lang="en" data-theme="light">')).toBeLessThan(at)
})

test('the pre-paint script reads only covey-keep:theme, writes nothing, and is wrapped in try', () => {
  expect(prePaint.trim()).toMatch(/^try\s*\{[\s\S]*\}\s*catch\s*\{\s*\}$/)
  const keys = [...prePaint.matchAll(/localStorage\.(\w+)\(\s*'([^']*)'/g)].map(([, method, key]) => `${method} ${key}`)
  expect(keys).toEqual([`getItem ${THEME_KEY}`])
  expect(prePaint).not.toMatch(/setItem|removeItem|clear\(|sessionStorage|prefers-color-scheme|matchMedia/)
})

test('the pre-paint script sets dark for exactly `dark`, and leaves light for anything else', () => {
  localStorage.setItem(THEME_KEY, 'dark')
  runPrePaint()
  expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

  for (const value of [null, 'light', 'sepia', 'Dark', '']) {
    resetTheme()
    if (value !== null) localStorage.setItem(THEME_KEY, value)
    runPrePaint()
    expect(document.documentElement.getAttribute('data-theme'), JSON.stringify(value)).toBe('light')
  }
})

test('the pre-paint script: storage that throws leaves light, and throws nothing', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  expect(runPrePaint).not.toThrow()
  expect(document.documentElement.getAttribute('data-theme')).toBe('light')
})
