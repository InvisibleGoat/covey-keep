// CK-81 — the look's load-bearing rules, pinned at the source: the tokens in
// both themes, one home for colour, honey's one use, the theme as the
// attribute, the self-hosted font and its licence, focus and motion, the
// sign-in lockup, and the precache. The values are the design chat's mockup
// (decisions/2026-10-31-the-design-and-how-it-is-merged.md).
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, test, vi } from 'vitest'
import indexHtml from '../../index.html?raw'
import viteConfig from '../../vite.config.ts?raw'
import { AuthContext, type AuthState } from '../auth/context'
import { PRODUCT_NAME } from '../brand'
import authArtSource from '../components/AuthArt.tsx?raw'
import { SignIn } from '../routes/SignIn'
import appCss from '../App.css?raw'
import baseCss from './base.css?raw'
import tokensCss from './tokens.css?raw'

afterEach(() => {
  vi.unstubAllGlobals()
})

const stylesheets = import.meta.glob('../**/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>
const sources = import.meta.glob(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>
// Existence only: the keys are the files, and nothing is loaded.
const publicFonts = Object.keys(import.meta.glob('/public/fonts/*'))

const stripCss = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
// Block comments, then line comments — but never the `//` of a URL.
const stripTs = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/

function block(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`)
  expect(start, `no block for ${selector}`).toBeGreaterThan(-1)
  const body = stripCss(css.slice(css.indexOf('{', start) + 1, css.indexOf('\n}', start)))
  const tokens: Record<string, string> = {}
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) tokens[match[1]] = match[2].trim()
  return tokens
}

const light = block(tokensCss, ':root,\n:root[data-theme="light"]')
const dark = block(tokensCss, ':root[data-theme="dark"]')

test('the tokens: every name in the light block is in the dark block and the reverse', () => {
  const lightNames = Object.keys(light).sort()
  const darkNames = Object.keys(dark).sort()
  expect(lightNames.length).toBeGreaterThan(40)
  expect(darkNames).toEqual(lightNames)
  // Not the prototype's phone frame, nor the landing page's pledge set.
  expect(stripCss(tokensCss)).not.toMatch(/--ck-bezel|--ck-pledge/)
})

test("the tokens: the accent, the page, the text and honey are the mockup's values in both themes", () => {
  expect([light['--pg-events-accent'], dark['--pg-events-accent']]).toEqual(['#217A79', '#3DA8A5'])
  expect([light['--pg-bg'], dark['--pg-bg']]).toEqual(['#FEFEFC', '#141619'])
  expect([light['--pg-text'], dark['--pg-text']]).toEqual(['#363636', '#E8E8E4'])
  expect([light['--pg-events-honey'], dark['--pg-events-honey']]).toEqual(['#F2BE4E', '#E8B64A'])
  // The grain: paper by day, clean by night.
  expect([light['--pg-grain-opacity'], dark['--pg-grain-opacity']]).toEqual(['.09', '0'])
})

test('one home for colour: no colour literal in any stylesheet but the token file, nor in any .ts or .tsx', () => {
  // Exceptions, named: the token file itself, and the test files (which
  // hold literals as assertions — plan.test.tsx's honey pin, this file's
  // own). The grain's data URI names no colour and needs no exception.
  const css = Object.entries(stylesheets).filter(([path]) => path !== './tokens.css')
  expect(css.map(([path]) => path).sort()).toEqual(['../App.css', '../index.css', './base.css'])
  for (const [path, text] of css) expect(stripCss(text), path).not.toMatch(COLOUR_LITERAL)
  expect(Object.keys(sources).length).toBeGreaterThan(40)
  for (const [path, text] of Object.entries(sources)) expect(stripTs(text), path).not.toMatch(COLOUR_LITERAL)
  // The token file is where the colours are.
  expect(tokensCss).toMatch(COLOUR_LITERAL)
})

test("honey's one use: its tokens are referenced only by the recommended plan card's rules", () => {
  const honey = /--pg-events-honey/
  const rules = [...stripCss(appCss).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  const honeyRules = rules.filter(([, , body]) => honey.test(body))
  expect(honeyRules.length).toBeGreaterThan(0)
  for (const [, selector] of honeyRules) {
    for (const part of selector.split(',')) expect(part.trim()).toMatch(/^\.plan-card-recommended\b/)
  }
  // Nowhere else: no other stylesheet reads it, and no source names it.
  for (const [path, text] of Object.entries(stylesheets)) {
    if (path === '../App.css' || path === './tokens.css') continue
    expect(stripCss(text), path).not.toMatch(honey)
  }
  for (const [path, text] of Object.entries(sources)) expect(text, path).not.toMatch(honey)
})

test('the theme is the attribute: index.html paints light statically, no stylesheet asks the device, and only lib/theme.ts and the one pre-paint script touch the stored choice or the attribute', () => {
  expect(indexHtml).toMatch(/<html lang="en" data-theme="light">/)
  for (const [path, text] of Object.entries(stylesheets)) expect(text, path).not.toContain('prefers-color-scheme')
  // MOVED AT CK-82, with its reason: until CK-82 no source stored or read a
  // theme at all — the switch was CK-82's. Since CK-82 a person chooses
  // Light or Dark on You, the choice is stored on the device, and it is
  // applied before the first paint. So the pin moves from "nothing" to "one
  // module and one script": lib/theme.ts is the only source that names the
  // key or the attribute, and index.html's one inline script is the only
  // other place — a second reader or writer would be a second truth about
  // which theme a person chose.
  const touchesTheme = /data-?theme|dataset\.theme|covey-keep:theme|THEME_KEY/i
  const touching = Object.entries(sources)
    .filter(([, text]) => touchesTheme.test(stripTs(text)))
    .map(([path]) => path)
  expect(touching).toEqual(['../lib/theme.ts'])
  const inlineScripts = [...indexHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter(
    ([, attributes]) => !/\bsrc=/.test(attributes),
  )
  expect(inlineScripts).toHaveLength(1)
  expect(inlineScripts[0][2]).toMatch(touchesTheme)
  // Nor does any stylesheet store or read one: a stylesheet only answers the
  // attribute, through the token file's two blocks.
  for (const [path, text] of Object.entries(stylesheets)) {
    if (path === './tokens.css') continue
    expect(stripCss(text), path).not.toMatch(/data-theme/)
  }
})

test('the menu layout (CK-89): only lib/menuLayout.ts names its key, and no stylesheet, no pre-paint script and no other source touches it', () => {
  const touchesLayout = /menu-layout|MENU_LAYOUT_KEY/
  const touching = Object.entries(sources)
    .filter(([, text]) => touchesLayout.test(stripTs(text)))
    .map(([path]) => path)
    // The one reader of the key's NAME is the module; You and the menu call its functions.
    .filter((path) => !/lib\/menuLayout\.ts$/.test(path))
  // You names the radio group `menu-layout` (an input name, not the key).
  expect(touching).toEqual(['../routes/You.tsx'])
  expect(stripTs(sources['../routes/You.tsx'])).not.toContain('covey-keep:menu-layout')
  expect(indexHtml).not.toMatch(/menu-layout/)
  for (const [path, text] of Object.entries(stylesheets)) expect(text, path).not.toMatch(/menu-layout/)
})

test('the gatherings view (CK-91): only lib/gatheringsView.ts names its key, and no stylesheet, no pre-paint script and no other source touches it', () => {
  // The third stored choice, on the theme's and the menu layout's shape: the
  // Cards / Calendar switch on Your gatherings. A second reader or writer of the
  // key would be a second truth about which view a person chose.
  const touchesView = /gatherings-view|GATHERINGS_VIEW_KEY/
  const touching = Object.entries(sources)
    .filter(([, text]) => touchesView.test(stripTs(text)))
    .map(([path]) => path)
  expect(touching).toEqual(['../lib/gatheringsView.ts'])
  expect(indexHtml).not.toMatch(/gatherings-view/)
  for (const [path, text] of Object.entries(stylesheets)) expect(text, path).not.toMatch(/gatherings-view/)
})

test('the calendar (CK-91): its styles name no colour and add no token', () => {
  // Every colour the calendar draws is one the token file already names.
  const start = appCss.indexOf('/* ---------- the calendar (CK-91')
  expect(start).toBeGreaterThan(-1)
  const block = stripCss(appCss.slice(start))
  expect(block).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
  expect(block).not.toMatch(/--[\w-]+\s*:/)
})

test("the calendar (CK-91): its column may shrink below its content at every width, so a long title in the day's list ends in an ellipsis instead of widening the page", () => {
  // Found in the browser, at the width sweep: with no column template below
  // 1180px the calendar's one implicit column took the day's list's widest
  // row — a long title kept on one line — and the page scrolled sideways
  // from 320 to 628px (the mockup's rule has the same gap; its titles were
  // never that long). jsdom has no layout, so the rule is pinned as written.
  const start = appCss.indexOf('/* ---------- the calendar (CK-91')
  const block = stripCss(appCss.slice(start))
  const base = /\.cal\s*\{([^}]*)\}/.exec(block)
  expect(base, 'the .cal rule').not.toBeNull()
  expect(base![1]).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/)
})

test("the calendar (CK-91): a phone's day keeps its covers and its count inside it, wrapping where the day is too narrow for both", () => {
  // Found in the browser, at the width sweep once the page no longer widened:
  // from 320 to 423px a day holding more than two gatherings drew its two
  // covers and *+N* past its own edge, into the next day (the mockup's rule
  // overflows the same way on a 375 phone). jsdom has no layout, so the rule
  // is pinned as written.
  const start = appCss.indexOf('/* ---------- the calendar (CK-91')
  const block = stripCss(appCss.slice(start))
  const marks = /\.marks\s*\{([^}]*)\}/.exec(block)
  expect(marks, 'the .marks rule').not.toBeNull()
  expect(marks![1]).toMatch(/flex-wrap:\s*wrap\s*;/)
  expect(marks![1]).toMatch(/justify-content:\s*center\s*;/)
})

test('the font: Source Serif 4 self-hosted from a file in the repo, its OFL licence beside it', () => {
  const face = /@font-face\s*\{([^}]*)\}/.exec(baseCss)?.[1] ?? ''
  expect(face).toContain('font-family: "Source Serif 4"')
  expect(face).toContain('font-weight: 400 600')
  expect(face).toContain('font-display: swap')
  const url = /url\("([^"]+)"\)/.exec(face)?.[1]
  expect(url).toBe('/fonts/sourceserif.woff2')
  expect(publicFonts).toContain(`/public${url}`)
  expect(publicFonts).toContain('/public/fonts/SourceSerif4-OFL.txt')
  // The display stack and its fallbacks, the body's system stack.
  expect(stripCss(tokensCss)).toContain('--font-display: "Source Serif 4", "Iowan Old Style", Georgia, serif;')
  expect(stripCss(tokensCss)).toMatch(/--font-body: -apple-system, BlinkMacSystemFont,/)
})

test('focus and motion: a 3px accent outline on :focus-visible, and reduced motion turns it all off', () => {
  const css = stripCss(baseCss)
  expect(css).toMatch(/:focus-visible \{\s*outline: 3px solid var\(--pg-events-accent\);\s*outline-offset: 2px;/)
  const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
  expect(reduced).toContain('transition: none !important')
  expect(reduced).toContain('animation: none !important')
})

test('the sign-in lockup: the heading is still the product name, and every image on the screen is decorative', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }))),
  )
  const signedOut: AuthState = {
    status: 'signedOut',
    person: null,
    signIn: () => {},
    signOut: async () => {},
    updatePerson: () => {},
  }
  const { container } = render(
    <MemoryRouter>
      <AuthContext.Provider value={signedOut}>
        <SignIn />
      </AuthContext.Provider>
    </MemoryRouter>,
  )
  const heading = screen.getByRole('heading', { level: 1 })
  expect(heading.textContent).toBe(PRODUCT_NAME)
  expect(heading.querySelector('img')?.getAttribute('alt')).toBe('')
  const images = Array.from(container.querySelectorAll('img'))
  expect(images).toHaveLength(4) // the quail and three prints
  for (const image of images) expect(image.getAttribute('alt')).toBe('')
  expect(container.querySelector('.auth-art')?.getAttribute('aria-hidden')).toBe('true')
  expect(screen.queryAllByRole('img')).toHaveLength(0)
  await screen.findByText('API: ok')
  // Every image the screens before the app draw is decorative, at the source.
  const tags = authArtSource.match(/<img\b[^>]*>/g) ?? []
  expect(tags.length).toBeGreaterThan(0)
  for (const tag of tags) expect(tag).toContain('alt=""')
})

test('the precache: the default pattern kept, the font and the images added, and registration still the provider’s', () => {
  expect(viteConfig).toContain("globPatterns: ['**/*.{js,wasm,css,html}', '**/*.{woff2,webp}']")
  expect(viteConfig).toContain('injectRegister: null,')
  expect(viteConfig).toContain("registerType: 'autoUpdate',")
})

test("the card's Waiting on wraps a long address inside itself, and only inside the card", () => {
  // CK-93's measurement: an address longer than the card at 320px ran past its
  // edge. The rule is the card's alone; a standalone gathering's list is left as
  // it was, so no unscoped rule on the list wraps anywhere.
  const css = stripCss(appCss)
  const scoped = css.match(/\.outside-card \.occurrence-list > li \{([^}]*)\}/)
  expect(scoped?.[1]).toContain('overflow-wrap: anywhere;')
  for (const rule of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!/\.occurrence-list/.test(rule[1]) || !/overflow-wrap/.test(rule[2])) continue
    expect(rule[1].trim()).toBe('.outside-card .occurrence-list > li')
  }
})
