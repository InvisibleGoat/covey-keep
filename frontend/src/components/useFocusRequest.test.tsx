// CK-94 — the one copy of focus after an answer (components/useFocusRequest.ts):
// - mayTakeFocus: from the body, from inside the container, never from
//   outside it;
// - a request is STATE, spent once, after the render that draws its target;
// - the same target asked twice is moved to twice;
// - a function target, and a function container, read when it is spent.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, expect, test } from 'vitest'
import { dropFocusToBody } from '../test-support/focus'
import { mayTakeFocus, useFocusRequest, useRefMap } from './useFocusRequest'

afterEach(cleanup)

test('mayTakeFocus answers true from the body and from inside the container, and false from outside it', () => {
  render(
    <>
      <section data-testid="box">
        <button type="button">Inside</button>
      </section>
      <button type="button">Outside</button>
    </>,
  )
  const box = screen.getByTestId('box')
  dropFocusToBody()
  expect(document.activeElement).toBe(document.body)
  expect(mayTakeFocus(box)).toBe(true)
  expect(mayTakeFocus(null)).toBe(true)
  screen.getByRole('button', { name: 'Inside' }).focus()
  expect(mayTakeFocus(box)).toBe(true)
  screen.getByRole('button', { name: 'Outside' }).focus()
  expect(mayTakeFocus(box)).toBe(false)
  expect(mayTakeFocus(null)).toBe(false)
})

// A press that draws its target in the same batch as the request: the
// target does not exist until the render that spends it.
function Revealer() {
  const box = useRef<HTMLElement>(null)
  const target = useRef<HTMLButtonElement>(null)
  const requestFocus = useFocusRequest(box)
  const [shown, setShown] = useState(false)
  const [renders, setRenders] = useState(0)
  return (
    <>
      <section ref={box}>
        <button
          type="button"
          onClick={() => {
            setShown(true)
            requestFocus(target)
          }}
        >
          Reveal
        </button>
        <button type="button" onClick={() => requestFocus(target)}>
          Again
        </button>
        <button type="button" onClick={() => setRenders((n) => n + 1)}>
          Render {renders}
        </button>
        {shown && (
          <button ref={target} type="button">
            Target
          </button>
        )}
      </section>
      <button type="button">Elsewhere</button>
    </>
  )
}

test('a request is spent after the render that draws its target, and only once', () => {
  render(<Revealer />)
  const reveal = screen.getByRole('button', { name: 'Reveal' })
  reveal.focus()
  fireEvent.click(reveal)
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Target' }))

  // A later render with focus elsewhere in the container moves nothing.
  const rerender = screen.getByRole('button', { name: /^Render/ })
  rerender.focus()
  fireEvent.click(rerender)
  expect(screen.getByRole('button', { name: 'Render 1' })).toBe(rerender)
  expect(document.activeElement).toBe(rerender)
})

test('the same target asked twice is moved to twice', () => {
  render(<Revealer />)
  fireEvent.click(screen.getByRole('button', { name: 'Reveal' }))
  const target = screen.getByRole('button', { name: 'Target' })
  expect(document.activeElement).toBe(target)
  const again = screen.getByRole('button', { name: 'Again' })
  again.focus()
  fireEvent.click(again)
  expect(document.activeElement).toBe(target)
})

test('a request takes focus from the body but never from outside the container', () => {
  render(<Revealer />)
  fireEvent.click(screen.getByRole('button', { name: 'Reveal' }))
  const target = screen.getByRole('button', { name: 'Target' })
  const again = screen.getByRole('button', { name: 'Again' })

  dropFocusToBody()
  fireEvent.click(again) // a click moves no focus: the body keeps it, as after a disabled press
  expect(document.activeElement).toBe(target)

  const elsewhere = screen.getByRole('button', { name: 'Elsewhere' })
  elsewhere.focus()
  fireEvent.click(again)
  expect(document.activeElement).toBe(elsewhere)
})

// A function target and a function container, read when the request is
// spent: the row a key names, in whichever section holds it.
function Rows() {
  const rows = useRefMap<string>()
  const [where, setWhere] = useState<'a' | 'b'>('a')
  const [list, setList] = useState(['one'])
  const requestFocus = useFocusRequest(() => document.getElementById(`section-${where}`))
  return (
    <>
      {(['a', 'b'] as const).map((id) => (
        <section key={id} id={`section-${id}`}>
          {where === id && (
            <>
              <button
                type="button"
                onClick={() => {
                  setList(['one', 'two'])
                  requestFocus(() => rows.get('two'))
                }}
              >
                Add {id}
              </button>
              {list.map((row) => (
                <button key={row} ref={rows.register(row)} type="button">
                  Row {row}
                </button>
              ))}
            </>
          )}
        </section>
      ))}
      <button type="button" onClick={() => setWhere('b')}>
        Move
      </button>
    </>
  )
}

test('a function target and a function container are read when the request is spent', async () => {
  render(<Rows />)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Move' })))
  const add = screen.getByRole('button', { name: 'Add b' })
  dropFocusToBody()
  fireEvent.click(add)
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Row two' }))
  expect(document.getElementById('section-b')!.contains(document.activeElement)).toBe(true)
})
