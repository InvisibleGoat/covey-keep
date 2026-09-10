// CK-40 pins on the helpers the words surface rests on: an intent item's
// size comes from the File (the presigned PUT signs Content-Length, which
// fetch will not let the client set — a declared size that disagrees with
// the blob is refused on the signature, nowhere near the real cause) and
// its filename goes trimmed; a row is called by its caption, then its
// filename, then "Photo"; the caption follows the CK-22 clearing rule
// (explicit null clears, blank is never a clear, "" is never sent); and the
// tag list sent is ALWAYS the whole list, because the server replaces the
// set — a partial list is silent data loss.
import { expect, test } from 'vitest'
import {
  captionPatch,
  intentErrorFields,
  intentItem,
  mediaListPath,
  mediaName,
  mediaWordsPatch,
  tagsPatch,
  wordsErrorFields,
} from './media'

test('an intent item takes its size from the File and nothing else, and its filename trimmed', () => {
  const file = new File([new Uint8Array([1, 2, 3, 4, 5])], '  IMG_0571.HEIC  ', { type: '' })
  expect(intentItem(file)).toEqual({
    content_type: 'image/heic',
    size_bytes: 5,
    filename: 'IMG_0571.HEIC',
  })
  // A name that is blank after trimming is left out rather than sent for the
  // server to refuse the whole batch over.
  const nameless = new File([new Uint8Array([1])], '   ', { type: 'image/jpeg' })
  expect(intentItem(nameless)).toEqual({ content_type: 'image/jpeg', size_bytes: 1 })
  expect('filename' in intentItem(nameless)).toBe(false)
})

test('the name precedence is caption, then filename, then Photo', () => {
  expect(mediaName({ caption: 'Safety sign at the yard', filename: 'IMG_0569.HEIC' })).toBe(
    'Safety sign at the yard',
  )
  expect(mediaName({ caption: null, filename: 'IMG_0569.HEIC' })).toBe('IMG_0569.HEIC')
  // Every row uploaded before CK-39, permanently: nothing is backfilled.
  expect(mediaName({ caption: null, filename: null })).toBe('Photo')
})

test('the caption patch: blanking a saved caption clears with null, empty-and-still-empty is omitted, whitespace goes as typed', () => {
  expect(captionPatch('', 'Safety sign')).toBeNull()
  expect(captionPatch('', null)).toBeUndefined()
  // Blank is never a clear: the server's 422 is what renders.
  expect(captionPatch('   ', 'Safety sign')).toBe('   ')
  expect(captionPatch('   ', null)).toBe('   ')
  expect(captionPatch('  New words  ', null)).toBe('New words')
  expect(captionPatch(' Safety sign ', 'Safety sign')).toBeUndefined()
})

test('the tag list sent is the whole list — the second beside the first, the set minus one, [] for none — and nothing when unchanged', () => {
  // The data-loss case: a photograph with one tag gains a second, and BOTH go.
  expect(tagsPatch(['qa', 'cake'], ['qa'])).toEqual(['qa', 'cake'])
  expect(tagsPatch(['cake'], ['cake', 'qa'])).toEqual(['cake'])
  expect(tagsPatch([], ['qa'])).toEqual([])
  expect(tagsPatch(['qa'], ['qa'])).toBeUndefined()
  // Removed and re-added is not a change; a case change is — the server
  // keeps case as typed, and it is the server that says Tommy and tommy are
  // one tag.
  expect(tagsPatch(['qa', 'cake'], ['cake', 'qa'])).toBeUndefined()
  expect(tagsPatch(['QA'], ['qa'])).toEqual(['QA'])
})

test('the words patch is a merge patch: only what changed, and never "" for a caption', () => {
  const saved = { caption: 'Safety sign', tags: ['qa'] }
  expect(mediaWordsPatch({ caption: 'Safety sign', tags: ['qa'] }, saved)).toEqual({})
  expect(mediaWordsPatch({ caption: '', tags: ['qa'] }, saved)).toEqual({ caption: null })
  expect(mediaWordsPatch({ caption: 'Safety sign', tags: ['qa', 'cake'] }, saved)).toEqual({
    tags: ['qa', 'cake'],
  })
  expect(mediaWordsPatch({ caption: '', tags: [] }, { caption: null, tags: [] })).toEqual({})
  for (const form of [
    { caption: '', tags: [] },
    { caption: '', tags: ['qa'] },
    { caption: 'x', tags: [] },
  ]) {
    for (const row of [saved, { caption: null, tags: [] }]) {
      expect(mediaWordsPatch(form, row).caption).not.toBe('')
    }
  }
})

test('the list path carries q only for a real term, encoded, and never an empty one', () => {
  expect(mediaListPath('g-1', '')).toBe('/gatherings/g-1/media')
  expect(mediaListPath('g-1', '   ')).toBe('/gatherings/g-1/media')
  expect(mediaListPath('g-1', 'yard')).toBe('/gatherings/g-1/media?q=yard')
  // The term is literal on the server; on the wire it is just encoded.
  expect(mediaListPath('g-1', ' 100% & more ')).toBe('/gatherings/g-1/media?q=100%25%20%26%20more')
})

test('error fields cover the filename per file and every sent tag by index', () => {
  expect(intentErrorFields(1)).toContain('items.0.filename')
  expect(wordsErrorFields(2)).toEqual(['caption', 'tags', 'tags.0', 'tags.1'])
})
