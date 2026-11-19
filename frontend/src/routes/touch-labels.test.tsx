// CK-99, round 2 — the two inputs the second sweep found under 44, through the
// real route table on the photos' fake server: the queue's checkbox and the
// file chooser each sit in a label of their own, which carries no words, so a
// press on its touch area reaches the input and the input keeps its own name.
// Their size is the stylesheet's (styles/touch-area.test.ts) and the browser's
// (the CK-99 report); jsdom has no layout.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from '../App'
import { AuthProvider } from '../auth/AuthContext'
import { clearCoverPictures } from '../lib/covers'
import { setToken } from '../lib/session'
import { settle } from '../test-support/focus'
import { own, photo, resetPhotosWorld, rowOf, stubPhotosServer, waiting } from '../test-support/photos'

const W1 = 'IMG_w1.jpg'

beforeEach(() => {
  clearCoverPictures()
  localStorage.clear()
  setToken('token-ada')
  resetPhotosWorld([photo('w1', waiting), photo('w2', waiting), photo('o1', { ...own, ...waiting }), photo('p1'), photo('p2')])
  stubPhotosServer()
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

async function open() {
  render(
    <MemoryRouter initialEntries={['/gatherings/g-1']}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  )
  await screen.findByRole('heading', { level: 1, name: 'The Party' })
  await settle()
  await settle()
}

const block = () => document.querySelector('.media-block') as HTMLElement

test("the queue's checkbox sits alone in a label with no words: a press on the label ticks it, and it keeps its name", async () => {
  await open()
  fireEvent.click(within(block()).getByRole('button', { name: 'Awaiting your review' }))
  await settle()
  await settle()
  const box = within(rowOf(W1)).getByRole('checkbox', { name: `Select ${W1}` }) as HTMLInputElement
  const label = box.parentElement as HTMLElement
  expect(label.tagName).toBe('LABEL')
  expect(label.classList.contains('media-select-touch')).toBe(true)
  expect(label.children).toHaveLength(1)
  expect(label.textContent).toBe('')
  expect(box.checked).toBe(false)
  fireEvent.click(label)
  expect(box.checked).toBe(true)
  expect(screen.getByRole('button', { name: 'Publish 1 selected photo' })).toBeTruthy()
})

test("the checkbox's label is the queue view's alone", async () => {
  await open()
  expect(block().querySelector('.media-select-touch')).toBeNull()
  expect(within(block()).queryByRole('checkbox')).toBeNull()
})

test('the file chooser sits alone in a label with no words: Add photos still names it, and a press on the label reaches it', async () => {
  await open()
  const chooser = screen.getByLabelText('Add photos') as HTMLInputElement
  expect(chooser.type).toBe('file')
  const label = chooser.parentElement as HTMLElement
  expect(label.tagName).toBe('LABEL')
  expect(label.classList.contains('file-touch')).toBe(true)
  expect(label.children).toHaveLength(1)
  expect(label.textContent).toBe('')
  expect([...(chooser.labels ?? [])].map((l) => l.textContent)).toEqual(['Add photos', ''])
  const pressed = vi.fn()
  chooser.addEventListener('click', pressed)
  fireEvent.click(label)
  expect(pressed).toHaveBeenCalledTimes(1)
})
