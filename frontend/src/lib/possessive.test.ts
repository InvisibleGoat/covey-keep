// CK-99 rider 3 — a name's possessive: an apostrophe alone after a final s,
// 's otherwise (the CK-84 settled line read "The Lees's cover is set.").
import { expect, test } from 'vitest'
import { groupCoverSetLine } from './covers'
import { possessive } from './possessive'

test('a name ending in s takes the apostrophe alone', () => {
  expect(possessive('The Lees')).toBe("The Lees'")
  expect(possessive('Chris')).toBe("Chris'")
  expect(possessive('THE LEES')).toBe("THE LEES'")
})

test("any other name takes 's", () => {
  expect(possessive('Anna')).toBe("Anna's")
  expect(possessive('The Marlowe Family')).toBe("The Marlowe Family's")
})

test("the empty name takes 's, as any name not ending in s", () => {
  expect(possessive('')).toBe("'s")
})

test("the group's settled cover line reads through it", () => {
  expect(groupCoverSetLine('The Lees')).toBe("The Lees' cover is set.")
  expect(groupCoverSetLine('Anna')).toBe("Anna's cover is set.")
})
