// CK-96 — CK-95's riders in a gathering's Photos section, through the app's
// REAL route table with the REAL AuthProvider, against test-support/photos.ts:
// - a load the page has moved past while its body was read lands nothing and
//   spends nothing: THE ROW GONE's marker stays owed for the read that
//   superseded it;
// - a photo's refusal line goes when a later act on it lands — Use as cover,
//   and the editor's save (on landing, CK-96's choice) — and is not there when
//   the photo is opened again.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from '../App'
import { AuthProvider } from '../auth/AuthContext'
import { clearCoverPictures, USE_AS_COVER } from '../lib/covers'
import { setToken } from '../lib/session'
import { dropFocusToBody, gate, pressHeld, settle, type Gate } from '../test-support/focus'
import { conflict, own, photo, photosWorld, resetPhotosWorld, rowOf, stubPhotosServer, waiting, type Key } from '../test-support/photos'

beforeEach(() => {
  clearCoverPictures()
  localStorage.clear()
  setToken('token-ada')
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

async function held(key: Key, control: HTMLElement) {
  photosWorld.hold[key] = gate()
  await pressHeld(control, photosWorld.hold[key]!)
  await settle()
  await settle()
}

const block = () => document.querySelector('.media-block') as HTMLElement
const heading = () => document.getElementById('photos-heading')

// ---------------------------------------------------------------- the stale load

// Hold the BODY of the next queue read: its response arrives, its json() waits.
function holdQueueBody(): Gate {
  const body = gate()
  const inner = globalThis.fetch
  let armed = true
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const response = await inner(url, init)
      if (!armed || (init?.method ?? 'GET') !== 'GET' || !String(url).includes('awaiting_review=true')) return response
      armed = false
      return {
        ok: response.ok,
        status: response.status,
        headers: response.headers,
        json: async () => {
          await body.promise
          return response.json()
        },
      } as Response
    }),
  )
  return body
}

test('a queue read superseded while its body is read lands nothing and leaves THE ROW GONE owed to the read after it', async () => {
  resetPhotosWorld([photo('w1', waiting), photo('w2', waiting), photo('w3', waiting), photo('p1')])
  stubPhotosServer()
  await open()
  fireEvent.click(within(block()).getByRole('button', { name: 'Awaiting your review' }))
  await settle()
  await settle()
  // Publish w1: the act lands and starts the queue's re-read, whose body waits.
  const body = holdQueueBody()
  const publish = within(rowOf('IMG_w1.jpg')).getByRole('button', { name: 'Publish' })
  await held('publish', publish)
  // The view moves to All photos before the queue's body is read: a new read,
  // begun after the act, supersedes it, and its answer is held too. Focus is
  // on the body, where any landing may take it.
  photosWorld.hold.list = gate()
  fireEvent.click(within(block()).getByRole('button', { name: 'All photos' }))
  dropFocusToBody()
  await settle()
  // The stale body arrives: it lands nothing and spends nothing, so focus
  // stays on the body.
  await act(async () => body.release())
  await settle()
  await settle()
  expect(document.activeElement).toBe(document.body)
  // The read that superseded it lands and spends the marker: in the All view
  // the published photo is a tile, so focus goes to the Photos heading.
  await act(async () => photosWorld.hold.list!.release())
  await settle()
  await settle()
  await waitFor(() => expect(document.activeElement).toBe(heading()))
})

// ---------------------------------------------------------- the refusal line

const dialog = () => screen.getByRole('dialog')
const words = () => dialog().querySelector('.vinfo') as HTMLElement
const inWords = (name: string | RegExp) => within(words()).getByRole('button', { name })

async function viewTile(n: number) {
  const tile = await screen.findByRole('button', { name: new RegExp(`^Photo ${n} of \\d+ in The Party$`) })
  tile.focus()
  fireEvent.click(tile)
  await screen.findByRole('dialog')
  await settle()
  await settle()
}

async function closeAndReopen() {
  fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }))
  await settle()
  await settle()
  await viewTile(1)
}

async function refusedSendToBin() {
  resetPhotosWorld([photo('o1', { ...own }), photo('p1')])
  stubPhotosServer()
  await open()
  await viewTile(1)
  photosWorld.answer.remove = conflict('not_ready')
  await held('remove', inWords('Send to bin'))
  expect(within(words()).getByRole('alert')).toBeTruthy()
  delete photosWorld.answer.remove
}

test("a refused Send to bin's line goes when Use as cover lands, and is not back when the photo is opened again", async () => {
  await refusedSendToBin()
  await held('gatheringCover', inWords(USE_AS_COVER))
  expect(within(words()).queryByRole('alert')).toBeNull()
  await closeAndReopen()
  expect(within(words()).queryByRole('alert')).toBeNull()
})

test("a refused Send to bin's line goes when the editor's save lands, and is not back when the photo is opened again", async () => {
  await refusedSendToBin()
  fireEvent.click(inWords('Edit caption and tags'))
  await settle()
  const editor = within(within(words()).getByRole('form'))
  fireEvent.change(editor.getByLabelText('Caption'), { target: { value: 'At the dock' } })
  await held('patch', editor.getByRole('button', { name: 'Save' }))
  expect(within(words()).queryByRole('alert')).toBeNull()
  await closeAndReopen()
  expect(within(words()).queryByRole('alert')).toBeNull()
})

// A row's own editor (a waiting photo of one's own is a row, not a tile):
// found by the mutation run, which left the row editor's spend untested.
test("a refused Send to bin's line on a row goes when the row's own editor's save lands", async () => {
  resetPhotosWorld([photo('o1', { ...own, ...waiting }), photo('p1')])
  stubPhotosServer()
  await open()
  const row = () => rowOf('IMG_o1.jpg')
  photosWorld.answer.remove = conflict('not_ready')
  await held('remove', within(row()).getByRole('button', { name: 'Send to bin' }))
  expect(within(row()).getByRole('alert')).toBeTruthy()
  delete photosWorld.answer.remove
  fireEvent.click(within(row()).getByRole('button', { name: 'Edit caption and tags' }))
  await settle()
  const editor = within(within(row()).getByRole('form'))
  fireEvent.change(editor.getByLabelText('Caption'), { target: { value: 'At the dock' } })
  await held('patch', editor.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(within(rowOf('At the dock')).queryByRole('form')).toBeNull())
  expect(within(rowOf('At the dock')).queryByRole('alert')).toBeNull()
})
