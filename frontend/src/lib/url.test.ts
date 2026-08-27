// CK-21 pins for the render-side scheme guard. The rejection cases mirror the
// backend validator's test set (javascript:, data:, vbscript:, scheme-relative,
// tab-obfuscated) so the two halves of the belt and braces cannot drift apart
// silently.
import { expect, test } from 'vitest'
import { safeHttpUrl } from './url'

test('non-http(s) and unparseable values are rejected', () => {
  const rejected = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'java\tscript:alert(1)', // the URL parser strips the tab, exposing the real scheme
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    '//evil.example/map', // scheme-relative — unparseable without a base
    '/gatherings', // relative — a map link is absolute or nothing
    'maps.example.com/park', // no scheme at all
    '',
  ]
  for (const value of rejected) {
    expect(safeHttpUrl(value), value).toBeNull()
  }
})

test('absolute http and https URLs pass through unchanged', () => {
  expect(safeHttpUrl('https://maps.example.com/park')).toBe('https://maps.example.com/park')
  expect(safeHttpUrl('http://maps.example.com/park')).toBe('http://maps.example.com/park')
  // Scheme matching is case-insensitive, and the ORIGINAL value is returned —
  // the guard decides link-or-text, it does not rewrite what is stored.
  expect(safeHttpUrl('HTTPS://maps.example.com/park')).toBe('HTTPS://maps.example.com/park')
})
