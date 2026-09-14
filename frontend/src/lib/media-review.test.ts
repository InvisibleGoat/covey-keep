// CK-43.1 pins on the helpers the review surface rests on. The value under
// test: THE STRING — the pending line is conditional on the gathering
// resolving gated (the-hosts-review §8), and it is pinned byte for byte both
// ways, because a conditional wired backwards looks completely normal on
// one gathering; the queue is the same list path with the flag; a refused
// act's copy switches on the server's CODE and never its wording; and the
// batch's error keys cover every sent index.
import { expect, test } from 'vitest'
import { networkErrors } from './formErrors'
import {
  awaitingReview,
  MAX_PUBLISH_BATCH,
  mediaListPath,
  mediaStateMessage,
  publishBatchErrorFields,
  reviewRefusalMessage,
} from './media'

const pending = { status: 'ready', publication_state: 'pending' }
const own = { ...pending, is_own: true, uploader_display_name: 'Steven' }
const theirs = { ...pending, is_own: false, uploader_display_name: 'grandma' }

test('THE STRING, gated: the same pending row says what it waits on, from each seat — and the host is told it waits for them', () => {
  // The uploader, who is not the host.
  expect(mediaStateMessage(own, { isHost: false, gated: true })).toBe(
    'Only you and the host can see this. Waiting for the host to publish or decline it.',
  )
  // The host reading their OWN photograph — the common case in a family
  // gathering (STEP 5's edge, decided): never a person waiting on "the
  // host", which would be themselves.
  expect(mediaStateMessage(own, { isHost: true, gated: true })).toBe(
    'Only you can see this. Waiting for you to publish or decline it.',
  )
  // The host reading someone else's.
  expect(mediaStateMessage(theirs, { isHost: true, gated: true })).toBe(
    'Only grandma and you can see this. Waiting for you to publish or decline it.',
  )
  // A non-host reading someone else's pending photograph cannot happen
  // under the audience rule; the function still answers honestly.
  expect(mediaStateMessage(theirs, { isHost: false, gated: true })).toBe(
    'Only grandma and the host can see this. Waiting for the host to publish or decline it.',
  )
})

test('THE STRING, open: the pending line is exactly what CK-38 wrote — nothing about what it waits on, because nothing waits', () => {
  for (const gated of [false, undefined]) {
    expect(mediaStateMessage(own, { isHost: false, gated })).toBe('Only you and the host can see this.')
    expect(mediaStateMessage(own, { isHost: true, gated })).toBe('Only you can see this.')
    expect(mediaStateMessage(theirs, { isHost: true, gated })).toBe('Only grandma and you can see this.')
  }
  // And no other rung or state changes with the gate: gated or not, the
  // in-flight lines, the live line, the bin and the failure read the same.
  for (const row of [
    { status: 'pending_upload', publication_state: 'pending' },
    { status: 'uploaded', publication_state: 'pending' },
    { status: 'processing', publication_state: 'pending' },
    { status: 'ready', publication_state: 'live' },
    { status: 'ready', publication_state: 'removed' },
    { status: 'failed', publication_state: 'pending' },
  ]) {
    for (const isHost of [true, false]) {
      const item = { ...row, is_own: true, uploader_display_name: 'Steven' }
      expect(mediaStateMessage(item, { isHost, gated: true })).toBe(
        mediaStateMessage(item, { isHost, gated: false }),
      )
    }
  }
})

test('no copy for an open gathering names a reviewer, an approval, a queue, or what a photograph waits on', () => {
  for (const row of [own, theirs]) {
    for (const isHost of [true, false]) {
      const line = mediaStateMessage(row, { isHost, gated: false })
      expect(line).not.toMatch(/approv|review|queue|publish|declin|waiting for/i)
    }
  }
})

test('the queue is the same list path with the flag, composing with q, and the flag never goes as false', () => {
  expect(mediaListPath('g-1', '', { awaitingReview: true })).toBe(
    '/gatherings/g-1/media?awaiting_review=true',
  )
  expect(mediaListPath('g-1', ' yard ', { awaitingReview: true })).toBe(
    '/gatherings/g-1/media?awaiting_review=true&q=yard',
  )
  // Not the queue: the path CK-40 pinned, unchanged — no `awaiting_review`
  // at all, never `=false`.
  expect(mediaListPath('g-1', '', { awaitingReview: false })).toBe('/gatherings/g-1/media')
  expect(mediaListPath('g-1', 'yard', {})).toBe('/gatherings/g-1/media?q=yard')
  expect(mediaListPath('g-1', 'yard')).toBe('/gatherings/g-1/media?q=yard')
})

test('what the host may act on is a ready row that is pending, and nothing else', () => {
  expect(awaitingReview({ status: 'ready', publication_state: 'pending' })).toBe(true)
  expect(awaitingReview({ status: 'ready', publication_state: 'live' })).toBe(false)
  expect(awaitingReview({ status: 'ready', publication_state: 'removed' })).toBe(false)
  expect(awaitingReview({ status: 'failed', publication_state: 'pending' })).toBe(false)
  expect(awaitingReview({ status: 'processing', publication_state: 'pending' })).toBe(false)
  expect(awaitingReview({ status: 'uploaded', publication_state: 'pending' })).toBe(false)
})

test("a refused act's copy switches on the code and never the wording — the same code reads the same whatever the server said", () => {
  // The codes are the contract (record §3); no server message is passed
  // through, and none is consulted.
  expect(reviewRefusalMessage('publish', { code: 'already_live', publication_state: 'live', status: 'ready' })).toBe(
    'This photo is already published — everyone in this gathering can see it.',
  )
  // not_pending carries the state that won: removed, or live on a decline.
  expect(reviewRefusalMessage('publish', { code: 'not_pending', publication_state: 'removed', status: 'ready' })).toBe(
    "This photo was declined or removed, so it can't be published.",
  )
  expect(reviewRefusalMessage('decline', { code: 'not_pending', publication_state: 'removed', status: 'ready' })).toBe(
    'This photo was already declined or removed.',
  )
  expect(reviewRefusalMessage('decline', { code: 'not_pending', publication_state: 'live', status: 'ready' })).toBe(
    "This photo is already published, and taking a published photo down isn't possible here yet.",
  )
  // not_ready carries the rung: failed has nothing to publish, ever.
  expect(reviewRefusalMessage('publish', { code: 'not_ready', publication_state: 'pending', status: 'failed' })).toBe(
    "This photo couldn't be processed, so there's nothing to publish.",
  )
  expect(reviewRefusalMessage('decline', { code: 'not_ready', publication_state: 'pending', status: 'processing' })).toBe(
    "This photo isn't ready yet — it can't be published or declined until it is.",
  )
  // The 404: the row moved out of the host's sight (the bin is the uploader's).
  expect(reviewRefusalMessage('publish', { code: 'not_found' })).toBe(
    "This photo isn't here any more — refresh the list to see what's waiting.",
  )
  // The request that never reached the server is the mapper's own line.
  expect(reviewRefusalMessage('publish', { code: 'unreachable' })).toBe(networkErrors().form[0])
  // A code this build does not know is named as a failure, never blank.
  expect(reviewRefusalMessage('publish', { code: 'someday_code' })).toBe(
    'Something went wrong. Nothing changed — try again.',
  )
  // Nothing claims destruction: a declined photograph is in its uploader's bin.
  for (const act of ['publish', 'decline'] as const) {
    for (const code of ['already_live', 'not_pending', 'not_ready', 'not_found', 'other']) {
      expect(reviewRefusalMessage(act, { code, publication_state: 'removed' })).not.toMatch(/delet|destroy|gone forever/i)
    }
  }
})

test('the batch error fields cover the list and every sent index, and the batch bound is the API\'s', () => {
  expect(publishBatchErrorFields(2)).toEqual(['media_ids', 'media_ids.0', 'media_ids.1'])
  expect(publishBatchErrorFields(0)).toEqual(['media_ids'])
  expect(MAX_PUBLISH_BATCH).toBe(50)
})
