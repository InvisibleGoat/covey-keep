// CK-17 pins on the one 422→errors code path every form shares.
import { expect, test } from 'vitest'
import { errorsFromResponse } from './formErrors'

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
