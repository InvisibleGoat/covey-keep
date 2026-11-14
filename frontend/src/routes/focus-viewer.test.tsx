// CK-95 — focus after an answer in the photo viewer (components/PhotoViewer.tsx
// and GatheringMedia's viewerActs), through the app's REAL route table with
// the REAL AuthProvider, each request held on a released promise and focus
// dropped to the body while it waits (test-support/focus.ts). The values under
// test (the kickoff's §5, the viewer's table):
// - THE HAZARD: each of the viewer's three steps — Delete permanently, Remove
//   from gathering, Use as the group's cover — opens with focus on the step,
//   a group labelled by its sentence, never on its acting button, so a second
//   press sends nothing; until CK-95 each confirm carried autoFocus;
// - a refused act puts focus back on the button that opened it, the step
//   closed; Use as cover's success, its button gone, puts focus on Close;
//   Refresh the list, the viewer still open, puts focus on Close;
// - the viewer's editor: a 422 on the caption on the Caption field, a tag's
//   422 or any other failure on Save;
// - Retry, on a gathering's page and a group's: the photo shown puts focus on
//   Full screen, a second failure on the new Retry;
// - the moves that worked before CK-95 still do (Keep it, Leave it, Not now,
//   Cancel, the landings after the viewer closes);
// - a person who moved outside the viewer's words column while it waited, or
//   pressed an arrow, keeps their place.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from '../App'
import { AuthProvider } from '../auth/AuthContext'
import { clearCoverPictures, groupCoverConfirmSentence, USE_AS_COVER, USE_AS_GROUP_COVER } from '../lib/covers'
import { DELETE_PERMANENTLY_CONFIRMATION, takedownSentence } from '../lib/media'
import { setToken } from '../lib/session'
import { dropFocusToBody, gate, pressHeld, settle } from '../test-support/focus'
import {
  conflict,
  GROUP,
  invalid,
  labelledName,
  own,
  photo,
  photosWorld,
  resetPhotosWorld,
  rowOf,
  stubPhotosServer,
  type Key,
  type Row,
} from '../test-support/photos'

const HOST_TAKEDOWN = takedownSentence({ isHost: true, requiresApproval: true })
const GROUP_SENTENCE = groupCoverConfirmSentence(GROUP.name, 'The Party')

// The grid's three tiles, in the list's order: the host's own photo (1),
// then two someone else added (2, 3), on a gathering in the group.
function theWorld(): Row[] {
  return [photo('o1', { ...own, tags: ['dock'] }), photo('p1'), photo('p2')]
}

beforeEach(() => {
  clearCoverPictures()
  localStorage.clear()
  setToken('token-ada')
  resetPhotosWorld(theWorld(), { group: GROUP })
  stubPhotosServer()
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

async function open(path = '/gatherings/g-1') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  )
  if (path.startsWith('/gatherings')) await screen.findByRole('heading', { level: 1, name: 'The Party' })
  else await screen.findByRole('heading', { level: 1, name: GROUP.name })
  await settle()
  await settle()
}

const dialog = () => screen.getByRole('dialog')
const inViewer = (name: string | RegExp) => within(dialog()).getByRole('button', { name })
const words = () => dialog().querySelector('.vinfo') as HTMLElement
const inWords = (name: string | RegExp) => within(words()).getByRole('button', { name })

// Open the viewer on tile `n` (1-based), as a person does.
async function viewTile(n: number) {
  const tile = await screen.findByRole('button', { name: new RegExp(`^Photo ${n} of \\d+ in The Party$`) })
  tile.focus()
  fireEvent.click(tile)
  await screen.findByRole('dialog')
  await settle()
  await settle()
}

async function held(key: Key, control: HTMLElement, movedTo?: HTMLElement) {
  photosWorld.hold[key] = gate()
  await pressHeld(control, photosWorld.hold[key]!, movedTo)
  await settle()
  await settle()
}

function expectStep(sentence: string) {
  const active = document.activeElement as HTMLElement
  expect(active.getAttribute('role')).toBe('group')
  expect(labelledName(active)).toBe(sentence)
}

async function opensStep(opener: HTMLElement) {
  opener.focus()
  fireEvent.click(opener)
  await settle()
}

// THE HAZARD, pinned: the element focus is on once the step opens, pressed
// again, sends nothing.
async function pressFocusedAgain() {
  const before = photosWorld.writes.length
  fireEvent.click(document.activeElement as HTMLElement)
  await settle()
  await settle()
  expect(photosWorld.writes.slice(before)).toEqual([])
}

// ---------------------------------------------------------------------------
// THE HAZARD: the three steps
// ---------------------------------------------------------------------------

test('Delete permanently opens its step with focus on the step, never on its Delete permanently, and a second press sends nothing', async () => {
  await open()
  await viewTile(1)
  await opensStep(inWords('Delete permanently'))
  expectStep(DELETE_PERMANENTLY_CONFIRMATION)
  await pressFocusedAgain()
})

test('Remove from gathering opens its step with focus on the step, never on Remove it, and a second press sends nothing', async () => {
  await open()
  await viewTile(2)
  await opensStep(inWords('Remove from gathering'))
  expectStep(HOST_TAKEDOWN)
  await pressFocusedAgain()
})

test("Use as the group's cover opens its step with focus on the step, never on its confirm, and a second press sends nothing", async () => {
  await open()
  await viewTile(2)
  await opensStep(await within(words()).findByRole('button', { name: USE_AS_GROUP_COVER }))
  expectStep(GROUP_SENTENCE)
  await pressFocusedAgain()
})

// ---------------------------------------------------------------------------
// Delete permanently
// ---------------------------------------------------------------------------

test('Keep it puts focus back on Delete permanently', async () => {
  await open()
  await viewTile(1)
  await opensStep(inWords('Delete permanently'))
  inWords('Keep it').focus()
  fireEvent.click(inWords('Keep it'))
  await settle()
  expect(document.activeElement).toBe(inWords('Delete permanently'))
})

test("the delete step's refusal, the step closed, puts focus on Delete permanently", async () => {
  await open()
  await viewTile(1)
  await opensStep(inWords('Delete permanently'))
  photosWorld.answer.destroy = conflict('not_ready')
  await held('destroy', inWords('Delete permanently'))
  expect(within(words()).queryByRole('group')).toBeNull()
  expect(document.activeElement).toBe(inWords('Delete permanently'))
})

test("the delete step's success closes the viewer and puts focus on the Photos heading", async () => {
  await open()
  await viewTile(1)
  await opensStep(inWords('Delete permanently'))
  await held('destroy', inWords('Delete permanently'))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(document.getElementById('photos-heading'))
})

// ---------------------------------------------------------------------------
// Remove from gathering
// ---------------------------------------------------------------------------

test('Leave it puts focus back on Remove from gathering', async () => {
  await open()
  await viewTile(2)
  await opensStep(inWords('Remove from gathering'))
  inWords('Leave it').focus()
  fireEvent.click(inWords('Leave it'))
  await settle()
  expect(document.activeElement).toBe(inWords('Remove from gathering'))
})

test("Remove it's refusal, the step closed, puts focus on Remove from gathering", async () => {
  await open()
  await viewTile(2)
  await opensStep(inWords('Remove from gathering'))
  photosWorld.answer.remove = conflict('not_ready')
  await held('remove', inWords('Remove it'))
  expect(within(words()).queryByRole('group')).toBeNull()
  expect(document.activeElement).toBe(inWords('Remove from gathering'))
})

test("Remove it's success closes the viewer and puts focus on the Removed view's button", async () => {
  await open()
  await viewTile(2)
  await opensStep(inWords('Remove from gathering'))
  await held('remove', inWords('Remove it'))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Removed from this gathering' }))
})

// ---------------------------------------------------------------------------
// Use as the group's cover
// ---------------------------------------------------------------------------

async function groupStep() {
  await open()
  await viewTile(2)
  await opensStep(await within(words()).findByRole('button', { name: USE_AS_GROUP_COVER }))
}

test("Not now puts focus back on Use as the group's cover", async () => {
  await groupStep()
  inWords('Not now').focus()
  fireEvent.click(inWords('Not now'))
  await settle()
  expect(document.activeElement).toBe(inWords(USE_AS_GROUP_COVER))
})

test("the group step's confirm, landing, puts focus back on Use as the group's cover beside its status line", async () => {
  await groupStep()
  await held('groupCover', inWords(USE_AS_GROUP_COVER))
  expect(within(words()).getByRole('status').textContent).not.toBe('')
  expect(document.activeElement).toBe(inWords(USE_AS_GROUP_COVER))
})

test("the group step's confirm, refused, puts focus back on Use as the group's cover beside its alert", async () => {
  await groupStep()
  photosWorld.answer.groupCover = conflict('not_published')
  await held('groupCover', inWords(USE_AS_GROUP_COVER))
  expect(within(words()).getByRole('alert')).toBeTruthy()
  expect(document.activeElement).toBe(inWords(USE_AS_GROUP_COVER))
})

// ---------------------------------------------------------------------------
// Send to bin and Use as cover
// ---------------------------------------------------------------------------

test("Send to bin's refusal, the viewer still open, puts focus back on Send to bin", async () => {
  await open()
  await viewTile(1)
  photosWorld.answer.remove = conflict('not_ready')
  await held('remove', inWords('Send to bin'))
  expect(document.activeElement).toBe(inWords('Send to bin'))
})

test("Send to bin's success closes the viewer and puts focus on the photo's new row's Put back", async () => {
  await open()
  await viewTile(1)
  await held('remove', inWords('Send to bin'))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(within(rowOf('IMG_o1.jpg')).getByRole('button', { name: 'Put back' }))
})

test("Use as cover's refusal puts focus back on Use as cover", async () => {
  await open()
  await viewTile(2)
  photosWorld.answer.gatheringCover = conflict('not_published')
  await held('gatheringCover', inWords(USE_AS_COVER))
  expect(document.activeElement).toBe(inWords(USE_AS_COVER))
})

test("Use as cover's success, its button gone, puts focus on Close", async () => {
  await open()
  await viewTile(2)
  await held('gatheringCover', inWords(USE_AS_COVER))
  expect(within(words()).queryByRole('button', { name: USE_AS_COVER })).toBeNull()
  expect(document.activeElement).toBe(inViewer('Close'))
})

// ---------------------------------------------------------------------------
// The viewer's editor
// ---------------------------------------------------------------------------

const editor = () => within(words()).getByRole('form')

async function openEditor() {
  await open()
  await viewTile(1)
  inWords('Edit caption and tags').focus()
  fireEvent.click(inWords('Edit caption and tags'))
  await settle()
}

test('Edit caption and tags puts focus on the Caption field, and Cancel back on Edit caption and tags', async () => {
  await openEditor()
  expect(document.activeElement).toBe(within(editor()).getByLabelText('Caption'))
  within(editor()).getByRole('button', { name: 'Cancel' }).focus()
  fireEvent.click(within(editor()).getByRole('button', { name: 'Cancel' }))
  await settle()
  expect(document.activeElement).toBe(inWords('Edit caption and tags'))
})

test("the viewer editor's Save, a 422 on the caption, puts focus on the Caption field", async () => {
  await openEditor()
  fireEvent.change(within(editor()).getByLabelText('Caption'), { target: { value: 'At the dock' } })
  photosWorld.answer.patch = invalid('caption')
  await held('patch', within(editor()).getByRole('button', { name: 'Save' }))
  expect(document.activeElement).toBe(within(editor()).getByLabelText('Caption'))
})

test("the viewer editor's Save, a tag's 422, puts focus back on Save", async () => {
  await openEditor()
  fireEvent.change(within(editor()).getByLabelText('Caption'), { target: { value: 'At the dock' } })
  photosWorld.answer.patch = invalid('tags', 0)
  await held('patch', within(editor()).getByRole('button', { name: 'Save' }))
  expect(document.activeElement).toBe(within(editor()).getByRole('button', { name: 'Save' }))
})

test("the viewer editor's Save, failing, puts focus back on Save", async () => {
  await openEditor()
  fireEvent.change(within(editor()).getByLabelText('Caption'), { target: { value: 'At the dock' } })
  photosWorld.answer.patch = { status: 500 }
  await held('patch', within(editor()).getByRole('button', { name: 'Save' }))
  expect(document.activeElement).toBe(within(editor()).getByRole('button', { name: 'Save' }))
})

test("the viewer editor's Save, landing, puts focus on Edit caption and tags", async () => {
  await openEditor()
  fireEvent.change(within(editor()).getByLabelText('Caption'), { target: { value: 'At the dock' } })
  await held('patch', within(editor()).getByRole('button', { name: 'Save' }))
  expect(within(words()).queryByRole('form')).toBeNull()
  expect(document.activeElement).toBe(inWords('Edit caption and tags'))
})

// ---------------------------------------------------------------------------
// Refresh the list, beneath a refusal
// ---------------------------------------------------------------------------

async function refusedSendToBin() {
  await open()
  await viewTile(1)
  photosWorld.answer.remove = conflict('not_ready')
  fireEvent.click(inWords('Send to bin'))
  await settle()
  await settle()
  delete photosWorld.answer.remove
  return inWords('Refresh the list')
}

test('Refresh the list, the viewer still open, puts focus on Close', async () => {
  const refresh = await refusedSendToBin()
  await held('list', refresh)
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(document.activeElement).toBe(inViewer('Close'))
})

test('Refresh the list, failing, the viewer still open, puts focus on Close', async () => {
  const refresh = await refusedSendToBin()
  photosWorld.failList = 1
  await held('list', refresh)
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(document.activeElement).toBe(inViewer('Close'))
})

test('Refresh the list, the photo gone, closes the viewer and puts focus on the Photos heading', async () => {
  const refresh = await refusedSendToBin()
  photosWorld.rows.splice(0, 1)
  await held('list', refresh)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(document.getElementById('photos-heading'))
})

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

async function failedLayer(path: string) {
  photosWorld.failLayer.add('p1')
  await open(path)
  await viewTile(2)
  await within(dialog()).findByRole('button', { name: 'Retry' })
}

test('Retry, the photo shown, puts focus on Full screen', async () => {
  await failedLayer('/gatherings/g-1')
  photosWorld.failLayer.delete('p1')
  await held('layer', inViewer('Retry'))
  expect(dialog().querySelector('img.vphoto')).not.toBeNull()
  expect(document.activeElement).toBe(inViewer('Full screen'))
})

test('Retry, failing again, puts focus on the new Retry', async () => {
  await failedLayer('/gatherings/g-1')
  await held('layer', inViewer('Retry'))
  expect(document.activeElement).toBe(inViewer('Retry'))
})

// Added at the measurement, for the kickoff's plant on each container kind:
// Retry's answer moves focus only from the body or inside the stage.
test('a person who moved outside the stage while Retry waited keeps their place, refused or landed', async () => {
  await failedLayer('/gatherings/g-1')
  const close = inViewer('Close')
  await held('layer', inViewer('Retry'), close)
  expect(inViewer('Retry')).toBeTruthy()
  expect(document.activeElement).toBe(close)
  photosWorld.failLayer.delete('p1')
  await held('layer', inViewer('Retry'), close)
  expect(dialog().querySelector('img.vphoto')).not.toBeNull()
  expect(document.activeElement).toBe(close)
})

test("Retry on a group's page: the photo shown puts focus on Full screen; failing again, on the new Retry", async () => {
  await failedLayer(`/groups/${GROUP.id}`)
  await held('layer', inViewer('Retry'))
  expect(document.activeElement).toBe(inViewer('Retry'))
  photosWorld.failLayer.delete('p1')
  await held('layer', inViewer('Retry'))
  expect(dialog().querySelector('img.vphoto')).not.toBeNull()
  expect(document.activeElement).toBe(inViewer('Full screen'))
})

// Added by the mutation run (the Retry guard dropped survived): Retry's
// answer is the photo's own only while that photo is on screen. The viewer
// moved on by a pointer that moves no focus, focus still on the body, the
// answer for the photo left behind moves nothing.
test("Retry's answer landing after the viewer moved to another photo, focus still on the body, moves nothing", async () => {
  await failedLayer('/gatherings/g-1')
  photosWorld.failLayer.delete('p1')
  photosWorld.hold.layer = gate()
  const retry = inViewer('Retry')
  retry.focus()
  fireEvent.click(retry)
  await waitFor(() => expect(retry.isConnected).toBe(false))
  dropFocusToBody()
  fireEvent.click(within(dialog()).getByRole('button', { name: '3 of 3: IMG_p2.jpg' }))
  await settle()
  expect(within(dialog()).getByText(/3 of 3/)).toBeTruthy()
  await act(async () => photosWorld.hold.layer!.release())
  await settle()
  await settle()
  expect(document.activeElement).toBe(document.body)
})

// ---------------------------------------------------------------------------
// A person who moved on
// ---------------------------------------------------------------------------

test('a person who moved outside the words column while an act waited keeps their place, refused or landed', async () => {
  await open()
  await viewTile(1)
  photosWorld.answer.remove = conflict('not_ready')
  await held('remove', inWords('Send to bin'), inViewer('Next photo'))
  expect(document.activeElement).toBe(inViewer('Next photo'))
  delete photosWorld.answer.remove
  fireEvent.click(inViewer('Next photo'))
  await settle()
  await held('gatheringCover', inWords(USE_AS_COVER), inViewer('Previous photo'))
  expect(within(words()).queryByRole('button', { name: USE_AS_COVER })).toBeNull()
  expect(document.activeElement).toBe(inViewer('Previous photo'))
})

test('a person who pressed an arrow while an act waited, the viewer on another photo, keeps their place', async () => {
  await open()
  await viewTile(2)
  photosWorld.answer.gatheringCover = conflict('not_published')
  photosWorld.hold.gatheringCover = gate()
  const useAsCover = inWords(USE_AS_COVER)
  useAsCover.focus()
  fireEvent.click(useAsCover)
  await waitFor(() => expect((useAsCover as HTMLButtonElement).disabled).toBe(true))
  dropFocusToBody()
  fireEvent.keyDown(document.body, { key: 'ArrowRight' })
  await settle()
  expect(within(dialog()).getByText(/3 of 3/)).toBeTruthy()
  // the arrow puts focus on the arrow, or on Close at the last photo (CK-88)
  expect(document.activeElement).toBe(inViewer('Close'))
  await act(async () => photosWorld.hold.gatheringCover!.release())
  await settle()
  await settle()
  expect(document.activeElement).toBe(inViewer('Close'))
})

test("a viewer moved to another photo while an act waited, focus still on the body, takes no focus to the other photo's button", async () => {
  await open()
  await viewTile(2)
  photosWorld.answer.gatheringCover = conflict('not_published')
  photosWorld.hold.gatheringCover = gate()
  const useAsCover = inWords(USE_AS_COVER)
  useAsCover.focus()
  fireEvent.click(useAsCover)
  await waitFor(() => expect((useAsCover as HTMLButtonElement).disabled).toBe(true))
  dropFocusToBody()
  // the strip, pressed by a pointer that moves no focus (as Safari's does)
  fireEvent.click(within(dialog()).getByRole('button', { name: '3 of 3: IMG_p2.jpg' }))
  await settle()
  expect(within(dialog()).getByText(/3 of 3/)).toBeTruthy()
  expect(document.activeElement).toBe(document.body)
  await act(async () => photosWorld.hold.gatheringCover!.release())
  await settle()
  await settle()
  // the photo on screen has its own Use as cover, and focus is not put on it
  expect(inWords(USE_AS_COVER)).toBeTruthy()
  expect(document.activeElement).toBe(document.body)
})
