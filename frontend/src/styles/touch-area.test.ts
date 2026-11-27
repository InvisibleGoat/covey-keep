// CK-99 — the touch area, pinned at the source. Every control a person
// presses is at least 44 by 44 CSS pixels to the touch: where it is drawn
// smaller, a transparent ::after reaches 44 by 44 about its centre (and is its
// own box exactly where it is drawn larger, which gives a round control its
// square's corners), on the control's own positioned box. Nothing is seen —
// the mechanism names no colour and draws nothing — and the focus ring stays
// on the control. Where two controls sit closer than 44, neither reaches past
// the midpoint (the day buttons, Map). Steven's rulings of 2026-11-19 add the
// rows drawn 44 tall, Who it's for's columns, and the two 2px gaps.
//
// jsdom has no layout: these pins prove the stylesheet says the rule, not that
// a press lands. The measure — elementFromPoint at the corners and edge
// midpoints of the 44-by-44 square, every width 320 to 1440, both themes — is
// the harness's, in a browser (the CK-99 report).
import { expect, test } from 'vitest'
import appCss from '../App.css?raw'

type Rule = { selectors: string[]; body: string }

// Comments out, then every rule at any depth as its selector list and body
// (an @media's inner rules included; the at-rule itself skipped).
function rules(source: string): Rule[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: Rule[] = []
  const walk = (text: string) => {
    let i = 0
    while (i < text.length) {
      const open = text.indexOf('{', i)
      if (open === -1) return
      const prelude = text.slice(i, open).trim()
      let depth = 1
      let j = open + 1
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth++
        else if (text[j] === '}') depth--
        j++
      }
      const inner = text.slice(open + 1, j - 1)
      if (prelude.startsWith('@')) walk(inner)
      else out.push({ selectors: splitList(prelude), body: inner })
      i = j
    }
  }
  walk(css)
  return out
}

// A selector list split at its top-level commas, whitespace collapsed.
function splitList(prelude: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let k = 0; k < prelude.length; k++) {
    const ch = prelude[k]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      parts.push(prelude.slice(start, k))
      start = k + 1
    }
  }
  parts.push(prelude.slice(start))
  return parts.map((part) => part.replace(/\s+/g, ' ').trim()).filter(Boolean)
}

const all = rules(appCss)
const declarations = (body: string) =>
  Object.fromEntries(
    [...body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1], match[2].replace(/\s+/g, ' ').trim()]),
  )
// Every declaration a selector receives, in source order, from every rule
// that lists it.
function declared(selector: string): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const rule of all) if (rule.selectors.includes(selector)) Object.assign(merged, declarations(rule.body))
  return merged
}

const REACH = 'min(0px, calc(50% - 22px))'
const COLOUR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\bcolor\b|background|border|outline|box-shadow|var\(/

// Each control the sweep found drawn under 44, or round and missing its
// square's corners, by the selector the mechanism names it with.
const CONTROLS = [
  '.brand', // the top bar's brand link, 36 tall
  '.crumb .nrow', // the crumb, 40 tall
  '.link-button', // 36 tall (40 in the photos' view switch)
  '.btn-small', // See all N photos, Today: 40 tall
  ':where(.update-notice, .newer-version, .member-actions, .media-review, .media-batch, .passkey-row, .companion-row, .vacts) button:where(:not(.link-button))', // the row pills: 40 tall
  '.switch button', // Cards / Calendar: 42 tall
  '.auth-screen > a:not([class])', // Back to settings, Back to your gatherings…: 24 tall
  '.auth-card > a:not([class])', // See your plan: 24 tall
  '.plainhead h3 a', // a group's photos' plain section heads: 28 tall
  ".auth-card label:has(> input[type='checkbox'], > input[type='radio'])", // a checkbox's or radio's label: 22.5 tall
  '.iconbtn', // round, 48
  '.ck-switch', // round ends, 52 by 44
  '.day', // the calendar's days: rounded, 36.3 wide at 320
  '.occurrence-where a', // Map, 30.7 by 20
  '.act', // a message's Delete or Remove and a held row's Show it (CK-103): 28 tall
  '.sendbtn', // the chat's Send (CK-103): round, 46
  '.rxadd', // a message's React (CK-105): 32 by 28
  '.rxchip', // a reaction's chip (CK-105): 30 tall, at least 44 wide
  '.picker button', // the picker's seven (CK-105): round, 42
  '.jump', // the button to the newest (CK-105): round, 44
  '.varrow', // the photo viewer's arrows: round
  '.rail-item', // the rail's tiles and its +: round
]

test.each(CONTROLS)('%s carries the touch area: a transparent ::after reaching 44 by 44 about its centre', (control) => {
  const after = declared(`${control}::after`)
  expect(after.content, `${control}::after has no content`).toBe("''")
  expect(after.position).toBe('absolute')
  for (const side of ['top', 'right', 'bottom', 'left']) {
    expect(after[side], `${control}::after ${side}`).toMatch(/min\(0px, calc\(50% - 22px\)\)/)
  }
})

test.each(CONTROLS)('%s is a positioned box for its ::after', (control) => {
  // Named inside :where() so a control positioned already keeps its own
  // position (the viewer's arrows are absolute, a rail tile relative).
  const where = all.find((rule) =>
    rule.selectors.some((s) => /^:where\(.*\)$/.test(s) && splitList(s.slice(7, -1)).includes(control)),
  )
  const own = declared(control).position
  expect(where !== undefined || own !== undefined, `${control} is not positioned`).toBe(true)
  if (where) expect(declarations(where.body).position).toBe('relative')
  else expect(['relative', 'absolute']).toContain(own)
})

test('the mechanism names no colour and draws nothing', () => {
  for (const rule of all) {
    if (!rule.selectors.some((s) => s.endsWith('::after') && CONTROLS.some((c) => s === `${c}::after`))) continue
    expect(rule.body, rule.selectors.join(', ')).not.toMatch(COLOUR)
    expect(declarations(rule.body)['z-index']).toBeUndefined()
  }
})

test('the midpoint rule: a day reaches 1px toward the next, and Map 4.5px toward RSVP', () => {
  const day = declared('.day::after')
  expect(day.left).toBe(`max(-1px, ${REACH})`)
  expect(day.right).toBe(`max(-1px, ${REACH})`)
  expect(declared('.occurrence-where a::after').bottom).toBe(`max(-4.5px, ${REACH})`)
})

test("the notice's link stays above its label's touch area", () => {
  const link = declared('.tos-row a')
  expect(link.position).toBe('relative')
  expect(link['z-index']).toBe('1')
})

test("a box of choices draws each radio row 44 tall, the radio centred, the rows' gap taken off (Steven, A and B)", () => {
  const row = ".occurrence-fields > label:has(> input[type='radio'])"
  expect(declared(row)['min-height']).toBe('44px')
  expect(declared(row)['align-items']).toBe('center')
  expect(declared(`${row} > input`).margin).toBe('0')
  expect(declared(`${row} + label:has(> input[type='radio'])`)['margin-top']).toBe('-0.625rem')
  // The gap it takes off is the box's own.
  expect(declared('.occurrence-fields').gap).toBe('0.625rem')
})

test("Who it's for's member boxes sit in columns at least 18rem wide, 12px apart, auto-fill (Steven, rider 2)", () => {
  const grid = declared('.places-grid')
  expect(grid.display).toBe('grid')
  expect(grid['grid-template-columns']).toBe('repeat(auto-fill, minmax(min(18rem, 100%), 1fr))')
  expect(grid.gap).toBe('12px')
})

test("the Photos view switch's wrapped rows sit 4px apart, and a photo's two rows of acts 8px (Steven, E and F)", () => {
  expect(declared('.media-view').gap).toBe('4px 2px')
  expect(declared('.media-item').gap).toBe('0.375rem')
  expect(
    declared('.media-item > :is(.link-button, .media-review) + :is(.link-button, .media-review)')['margin-top'],
  ).toBe('2px')
})

// The second sweep (CK-99, round 2): two inputs no ::after draws on, each in a
// label of its own whose box is the input's.
test("the file chooser's label is its touch area: 44 tall, beneath the chooser, the form's type and stretch kept", () => {
  const where = all.find((rule) =>
    rule.selectors.some((s) => /^:where\(.*\)$/.test(s) && splitList(s.slice(7, -1)).includes('.file-touch')),
  )
  expect(where && declarations(where.body).position).toBe('relative')
  const after = declared('.file-touch::after')
  expect(after.content).toBe("''")
  expect(after.position).toBe('absolute')
  for (const side of ['top', 'right', 'bottom', 'left']) expect(after[side], side).toBe(REACH)
  // Beneath the chooser, so a press on the chooser is its own.
  expect(after['z-index']).toBe('-1')
  const label = declared('label.file-touch')
  expect(label['z-index']).toBe('0')
  expect(label.display).toBe('flex')
  expect(label['flex-direction']).toBe('column')
  expect(label.font).toBe('inherit')
  for (const rule of all) {
    if (rule.selectors.some((s) => s.includes('file-touch'))) expect(rule.body, rule.selectors.join(', ')).not.toMatch(COLOUR)
  }
})

test("the queue's checkbox label hugs it, its margin moved onto the label, and 7px more room beneath (Steven, 2026-11-19)", () => {
  // The checkbox labels' rule gives it its ::after (CONTROLS above).
  expect(CONTROLS).toContain(".auth-card label:has(> input[type='checkbox'], > input[type='radio'])")
  const label = declared('.media-select-touch')
  expect(label['align-self']).toBe('flex-start')
  expect(label['margin-top']).toBe('2px')
  expect(label['margin-bottom']).toBe('7px')
  expect(declared('.media-select-touch > .media-select').margin).toBe('0')
})

// CK-105: a chip is at least 44 wide as drawn; rows of chips that wrap stand
// 14px apart and the last 2px above its message's foot, so a chip's touch area
// (7px out) and the next message's React or word (8px out) meet at the
// midpoints; and the newer messages' Try again is a small pill, whose touch
// area is the .btn-small rule's.
test('the chips: 44 wide, their rows 14px apart, 2px above the foot; the newer Try again a small pill', async () => {
  expect(declared('.rxchip')['min-width']).toBe('44px')
  expect(declared('.rxchip')['min-height']).toBe('30px')
  expect(declared('.rx').gap).toBe('14px 4px')
  expect(declared('.rx').margin).toBe('5px 0 2px')
  expect(declared('.picker').gap).toBe('2px')
  expect(declared('.picker button').width).toBe('42px')
  expect(declared('.jump').width).toBe('44px')
  expect(declared('.jump').height).toBe('44px')
  const view = (await import('../components/ChatView.tsx?raw')).default
  expect(view).toMatch(/className="chat-later"[\s\S]*?className="btn btn-small"[\s\S]*?\{TRY_AGAIN\}/)
})
