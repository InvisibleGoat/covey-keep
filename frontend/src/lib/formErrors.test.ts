// CK-17 pins on the one 422→errors code path every form shares.
import { expect, test } from 'vitest'
import { errorsFromResponse, errorType, noErrors } from './formErrors'

function response422(detail: unknown): Response {
  return new Response(JSON.stringify({ detail }), { status: 422 })
}

test('a field error lands on its field, humanized', async () => {
  const errors = await errorsFromResponse(
    response422([
      { loc: ['body', 'title'], msg: 'Value error, title cannot be empty', type: 'value_error' },
    ]),
    ['title'],
  )
  expect(errors.fields.title).toBe('Title cannot be empty')
  expect(errors.form).toEqual([])
})

test('an error outside the visible fields is never swallowed', async () => {
  const errors = await errorsFromResponse(
    response422([{ loc: ['body', 'surprise'], msg: 'mystery failure', type: 'value_error' }]),
    ['title'],
  )
  expect(errors.fields).toEqual({})
  expect(errors.form).toEqual(['Mystery failure (surprise)'])
})

test('nested loc paths key by their full path', async () => {
  const errors = await errorsFromResponse(
    response422([
      { loc: ['body', 'occurrences', 1, 'starts_at'], msg: 'bad timestamp', type: 'value_error' },
    ]),
    ['occurrences.1.starts_at'],
  )
  expect(errors.fields['occurrences.1.starts_at']).toBe('Bad timestamp')
})

test('a string detail renders as a form-level message', async () => {
  const errors = await errorsFromResponse(response422('Nope.'), ['title'])
  expect(errors.form).toEqual(['Nope.'])
})

test('a non-422 failure is a distinct message, never a validation error', async () => {
  const errors = await errorsFromResponse(new Response('boom', { status: 500 }), ['title'])
  expect(errors.fields).toEqual({})
  expect(errors.form).toEqual(['Something went wrong. Nothing was saved — try again.'])
})

test("each field keeps its entry's type beside the message, so a caller can switch on a code and never on wording (CK-74)", async () => {
  const errors = await errorsFromResponse(
    response422([
      {
        loc: ['body', 'items'],
        msg: "this space holds 10,000 photos and has no room left, and you're adding 1",
        type: 'keeper_space_full',
      },
      { loc: ['body', 'items', 0, 'content_type'], msg: 'Value error, nope', type: 'value_error' },
      // A second message on a field already taken: neither its message nor
      // its type displaces the first.
      { loc: ['body', 'items'], msg: 'a later message', type: 'value_error' },
    ]),
    ['items', 'items.0.content_type'],
  )
  expect(errors.fields.items).toBe("This space holds 10,000 photos and has no room left, and you're adding 1")
  expect(errorType(errors, 'items')).toBe('keeper_space_full')
  expect(errorType(errors, 'items.0.content_type')).toBe('value_error')
  expect(errorType(errors, 'title')).toBeUndefined()
  // A body with no type at all: nothing recorded, nothing to switch on.
  const untyped = await errorsFromResponse(response422([{ loc: ['body', 'items'], msg: 'no type' }]), ['items'])
  expect(errorType(untyped, 'items')).toBeUndefined()
  expect(errorType(noErrors(), 'items')).toBeUndefined()
})
