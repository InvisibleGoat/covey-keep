// CK-95 — focus after an answer in Change cover's panel (components/PageCover.tsx,
// on a gathering's page and a group's) and in a group's photos
// (components/GroupPhotos.tsx), through the app's REAL route table with the
// REAL AuthProvider, focus dropped to the body while each answer waits, as
// Chrome drops it from a disabled control (test-support/focus.ts). The values
// under test (the kickoff's §5, its last two tables):
// - Upload a picture: the picture ready, failed, superseded or refused, focus
//   back on Upload a picture;
// - Remove cover opens its step with focus on the step, a group labelled by
//   its sentence, never on its Remove cover; Keep it and a refusal put focus
//   back on Remove cover; a success, once Remove cover has gone with the
//   re-read, on Upload a picture;
// - a group's photos' Try again: the reads landing on the section's heading,
//   a second failure on the new Try again;
// - a person who moved outside the panel or the section while it waited keeps
//   their place.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from '../App'
import { AuthProvider } from '../auth/AuthContext'
import { CHANGE_COVER, clearCoverPictures, KEEP_IT, REMOVE_COVER, REMOVE_UPLOADED_SENTENCE, UPLOAD_A_PICTURE } from '../lib/covers'
import { POLL_INTERVAL_MS } from '../lib/media'
import { setToken } from '../lib/session'
import { dropFocusToBody, gate, pressHeld, settle } from '../test-support/focus'
import {
  conflict,
  GROUP,
  invalid,
  labelledName,
  photo,
  photosWorld,
  resetPhotosWorld,
  stubPhotosServer,
  type Key,
} from '../test-support/photos'

const UPLOADED = () => ({ source: 'upload', set_at: new Date().toISOString() })

beforeEach(() => {
  clearCoverPictures()
  localStorage.clear()
  setToken('token-ada')
  resetPhotosWorld([photo('p1'), photo('p2')], { group: GROUP })
  stubPhotosServer()
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

const GATHERING = '/gatherings/g-1'
const GROUP_PAGE = `/groups/${GROUP.id}`

async function open(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  )
  await screen.findByRole('heading', { level: 1, name: path === GATHERING ? 'The Party' : GROUP.name })
  await settle()
  await settle()
}

const panel = () => document.querySelector('.cover-panel') as HTMLElement
const inPanel = (name: string) => within(panel()).getByRole('button', { name })

async function openPanel(path: string) {
  await open(path)
  fireEvent.click(screen.getByRole('button', { name: CHANGE_COVER }))
  await settle()
}

// Choose a picture as a person does: Upload a picture pressed, a file picked.
// The upload starts on the pick; the button is disabled while it runs, and
// Chrome drops focus to the body (or the person moves it to `movedTo`).
async function choosePicture(movedTo?: HTMLElement, waitPoll = true) {
  const button = inPanel(UPLOAD_A_PICTURE)
  button.focus()
  fireEvent.click(button)
  const input = panel().querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File([new Uint8Array([1, 2, 3])], 'IMG_0569.jpg', { type: 'image/jpeg' })] } })
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true))
  if (movedTo) movedTo.focus()
  else dropFocusToBody()
  await settle()
  await settle()
  if (waitPoll) await settle(POLL_INTERVAL_MS + 100)
  await settle()
  await settle()
}

async function held(key: Key, control: HTMLElement, movedTo?: HTMLElement) {
  photosWorld.hold[key] = gate()
  await pressHeld(control, photosWorld.hold[key]!, movedTo)
  await settle()
  await settle()
}

// ---------------------------------------------------------------------------
// Upload a picture
// ---------------------------------------------------------------------------

test('Upload a picture, the picture ready and the cover read again, puts focus back on Upload a picture', async () => {
  await openPanel(GATHERING)
  await choosePicture()
  // the cover read again: Remove cover is offered beside it now
  expect(inPanel(REMOVE_COVER)).toBeTruthy()
  expect(document.activeElement).toBe(inPanel(UPLOAD_A_PICTURE))
})

test('Upload a picture, the picture failed, puts focus back on Upload a picture beside its alert', async () => {
  photosWorld.coverImageStatus = 'failed'
  await openPanel(GATHERING)
  await choosePicture()
  expect(within(panel()).getByRole('alert')).toBeTruthy()
  expect(document.activeElement).toBe(inPanel(UPLOAD_A_PICTURE))
})

test('Upload a picture, superseded, puts focus back on Upload a picture beside its alert', async () => {
  photosWorld.answer.coverConfirm = conflict('superseded')
  await openPanel(GATHERING)
  await choosePicture(undefined, false)
  expect(within(panel()).getByRole('alert')).toBeTruthy()
  expect(document.activeElement).toBe(inPanel(UPLOAD_A_PICTURE))
})

test('Upload a picture, refused, puts focus back on Upload a picture beside its alert', async () => {
  photosWorld.answer.coverUpload = invalid('content_type')
  await openPanel(GATHERING)
  await choosePicture(undefined, false)
  expect(within(panel()).getByRole('alert')).toBeTruthy()
  expect(document.activeElement).toBe(inPanel(UPLOAD_A_PICTURE))
})

test("Upload a picture on a group's page, the picture ready, puts focus back on Upload a picture", async () => {
  await openPanel(GROUP_PAGE)
  await choosePicture()
  expect(inPanel(REMOVE_COVER)).toBeTruthy()
  expect(document.activeElement).toBe(inPanel(UPLOAD_A_PICTURE))
})

// ---------------------------------------------------------------------------
// Remove cover
// ---------------------------------------------------------------------------

async function removeStep(path: string) {
  if (path === GATHERING) photosWorld.detail = { ...photosWorld.detail, cover: UPLOADED() }
  else photosWorld.groupCover = UPLOADED()
  await openPanel(path)
  const opener = inPanel(REMOVE_COVER)
  opener.focus()
  fireEvent.click(opener)
  await settle()
}

test('Remove cover opens its step with focus on the step, never on its Remove cover, and a second press sends nothing', async () => {
  await removeStep(GATHERING)
  const active = document.activeElement as HTMLElement
  expect(active.getAttribute('role')).toBe('group')
  expect(labelledName(active)).toBe(REMOVE_UPLOADED_SENTENCE)
  const before = photosWorld.writes.length
  fireEvent.click(active)
  await settle()
  expect(photosWorld.writes.slice(before)).toEqual([])
})

test("Remove cover's step on a group's page is named by its sentence and takes focus", async () => {
  await removeStep(GROUP_PAGE)
  const active = document.activeElement as HTMLElement
  expect(active.getAttribute('role')).toBe('group')
  expect(labelledName(active)).toBe(REMOVE_UPLOADED_SENTENCE)
})

test('Keep it puts focus back on Remove cover', async () => {
  await removeStep(GATHERING)
  inPanel(KEEP_IT).focus()
  fireEvent.click(inPanel(KEEP_IT))
  await settle()
  expect(document.activeElement).toBe(inPanel(REMOVE_COVER))
})

test("the step's Remove cover, refused, the step closed, puts focus back on Remove cover", async () => {
  await removeStep(GATHERING)
  photosWorld.answer.clearCover = conflict('not_found')
  await held('clearCover', inPanel(REMOVE_COVER))
  expect(within(panel()).queryByRole('group')).toBeNull()
  expect(within(panel()).getByRole('alert')).toBeTruthy()
  expect(document.activeElement).toBe(inPanel(REMOVE_COVER))
})

test("the step's Remove cover, landing, puts focus on Upload a picture once Remove cover has gone", async () => {
  await removeStep(GATHERING)
  await held('clearCover', inPanel(REMOVE_COVER))
  expect(within(panel()).queryByRole('button', { name: REMOVE_COVER })).toBeNull()
  expect(document.activeElement).toBe(inPanel(UPLOAD_A_PICTURE))
})

test("the step's Remove cover on a group's page, landing, puts focus on Upload a picture", async () => {
  await removeStep(GROUP_PAGE)
  await held('clearCover', inPanel(REMOVE_COVER))
  expect(within(panel()).queryByRole('button', { name: REMOVE_COVER })).toBeNull()
  expect(document.activeElement).toBe(inPanel(UPLOAD_A_PICTURE))
})

// ---------------------------------------------------------------------------
// A group's photos: Try again
// ---------------------------------------------------------------------------

const photosHeading = () => screen.getByRole('heading', { level: 2, name: 'Photos' })
const section = () => photosHeading().closest('section') as HTMLElement

test("a group's photos' Try again, the reads landing, puts focus on the section's heading", async () => {
  photosWorld.failGroupMedia = 1
  await open(GROUP_PAGE)
  await held('groupMedia', within(section()).getByRole('button', { name: 'Try again' }))
  expect(within(section()).queryByRole('alert')).toBeNull()
  expect(document.activeElement).toBe(photosHeading())
})

test("a group's photos' Try again, failing again, puts focus on the new Try again", async () => {
  photosWorld.failGroupMedia = 2
  await open(GROUP_PAGE)
  await held('groupMedia', within(section()).getByRole('button', { name: 'Try again' }))
  expect(document.activeElement).toBe(within(section()).getByRole('button', { name: 'Try again' }))
})

// ---------------------------------------------------------------------------
// A person who moved on
// ---------------------------------------------------------------------------

test("a person who moved outside Change cover's panel while it waited keeps their place, refused or landed", async () => {
  await openPanel(GATHERING)
  const elsewhere = screen.getByRole('button', { name: CHANGE_COVER })
  photosWorld.answer.coverUpload = invalid('content_type')
  await choosePicture(elsewhere, false)
  expect(within(panel()).getByRole('alert')).toBeTruthy()
  expect(document.activeElement).toBe(elsewhere)
  delete photosWorld.answer.coverUpload
  await choosePicture(elsewhere)
  expect(inPanel(REMOVE_COVER)).toBeTruthy()
  expect(document.activeElement).toBe(elsewhere)
})

test("a person who moved outside a group's photos while Try again waited keeps their place, refused or landed", async () => {
  photosWorld.failGroupMedia = 2
  await open(GROUP_PAGE)
  const elsewhere = screen.getByRole('link', { name: /New gathering/ })
  await held('groupMedia', within(section()).getByRole('button', { name: 'Try again' }), elsewhere)
  expect(document.activeElement).toBe(elsewhere)
  await held('groupMedia', within(section()).getByRole('button', { name: 'Try again' }), elsewhere)
  expect(within(section()).queryByRole('alert')).toBeNull()
  expect(document.activeElement).toBe(elsewhere)
})

// keep `act` in use for the linter's sake where a test releases by hand
void act
