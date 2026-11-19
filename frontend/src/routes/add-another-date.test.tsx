// CK-99 rider 1 — on the New gathering form, Add another date puts focus on
// the new date's Starts, through the shared focus hook with the form as its
// container (CK-97's rule: a press that replaces itself with a form, or adds
// one, puts focus on its first field). Through the app's REAL route table with
// the REAL AuthProvider, on the fake server of test-support/world96.ts. jsdom
// moves no focus on a click, so each press focuses its button first, as a
// person's press does.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from '../App'
import { AuthProvider } from '../auth/AuthContext'
import { setToken } from '../lib/session'
import { settle } from '../test-support/focus'
import { GROUP, resetWorld96, stubWidth, stubWorld96, world96 } from '../test-support/world96'

vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
  startRegistration: async () => ({}),
  startAuthentication: async () => ({}),
}))

beforeEach(() => {
  localStorage.clear()
  resetWorld96()
  stubWorld96()
  stubWidth(false)
  setToken('tok-ada')
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function newGathering(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  )
  await screen.findByRole('heading', { level: 1, name: /New gathering/ })
  await waitFor(() => expect(world96.inflight).toBe(0))
  await settle()
}

const starts = () => screen.getAllByLabelText('Starts') as HTMLInputElement[]

async function addDate() {
  const add = screen.getByRole('button', { name: 'Add another date' })
  add.focus()
  fireEvent.click(add)
  await settle()
}

test("Add another date puts focus on the new date's Starts", async () => {
  await newGathering('/gatherings/new')
  expect(starts()).toHaveLength(1)
  await addDate()
  expect(starts()).toHaveLength(2)
  expect(document.activeElement).toBe(starts()[1])
})

test("a third date: focus on the third date's Starts, the first two untouched", async () => {
  await newGathering('/gatherings/new')
  fireEvent.change(starts()[0], { target: { value: '2026-12-01T18:00' } })
  await addDate()
  fireEvent.change(starts()[1], { target: { value: '2026-12-02T18:00' } })
  await addDate()
  expect(starts().map((input) => input.value)).toEqual(['2026-12-01T18:00', '2026-12-02T18:00', ''])
  expect(document.activeElement).toBe(starts()[2])
})

test("the group's New gathering form takes the same rule", async () => {
  await newGathering(`/groups/${GROUP.id}/gatherings/new`)
  await addDate()
  expect(starts()).toHaveLength(2)
  expect(document.activeElement).toBe(starts()[1])
})

test('Add another date moves nothing when the person is elsewhere', async () => {
  await newGathering('/gatherings/new')
  const stand = document.createElement('button')
  document.body.append(stand)
  // A press from a pointer that left focus outside the form.
  stand.focus()
  fireEvent.click(screen.getByRole('button', { name: 'Add another date' }))
  await settle()
  expect(starts()).toHaveLength(2)
  expect(document.activeElement).toBe(stand)
  stand.remove()
})
