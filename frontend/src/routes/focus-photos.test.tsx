// CK-95 — focus after an answer in a gathering's Photos section
// (components/GatheringMedia.tsx): its rows, the batch, Show all, the upload
// form and Try again, through the app's REAL route table with the REAL
// AuthProvider, each request held on a released promise and focus dropped to
// the body while it waits, as Chrome drops it from a disabled control
// (test-support/focus.ts). The values under test (the kickoff's §5, the rows
// and the section):
// - a 422 puts focus on the field it names; any other failure puts focus back
//   on the control pressed;
// - a success puts focus on what carries the act on: the row's Put back after
//   Send to bin, its Send to bin after a Put back that waits, its Edit after
//   the editor, the file input after an upload;
// - THE ROW GONE: where the act took its row out of the list, the All view's
//   Photos heading, the queue's next Publish (or the last row's), the Removed
//   view's next Put back (or the last row's), and a failed re-read the
//   section's Try again;
// - a press that opens a second step puts focus on the step — a group
//   labelled by its sentence, never its acting button — and the step's keep
//   button puts it back on the button that opened it;
// - a person who moved elsewhere while it waited keeps their place.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from '../App'
import { AuthProvider } from '../auth/AuthContext'
import { clearCoverPictures } from '../lib/covers'
import { DELETE_PERMANENTLY_CONFIRMATION, REMOVED_BIN_DAYS, takedownSentence } from '../lib/media'
import { setToken } from '../lib/session'
import { dropFocusToBody, gate, pressHeld, settle } from '../test-support/focus'
import {
  conflict,
  inGatheringBin,
  inOwnBin,
  invalid,
  labelledName,
  own,
  photo,
  photosWorld,
  resetPhotosWorld,
  rowGone,
  rowOf,
  stubPhotosServer,
  waiting,
  type Key,
  type Row,
} from '../test-support/photos'

const W1 = 'IMG_w1.jpg'
const W2 = 'IMG_w2.jpg'
const W3 = 'IMG_w3.jpg'
const O1 = 'IMG_o1.jpg'
const B1 = 'IMG_b1.jpg'
const F1 = 'IMG_f1.jpg'
const G1 = 'IMG_g1.jpg'
const G2 = 'IMG_g2.jpg'
const P1 = 'IMG_p1.jpg'

const HOST_TAKEDOWN = takedownSentence({ isHost: true, requiresApproval: true })
const OWN_DECLINE = `The gathering won't see this photo. You can still see it yourself for ${REMOVED_BIN_DAYS} days.`

// The world, on a gathering that requires approval: three photos someone else
// added waiting for the host, the host's own waiting photo (tagged), the
// host's own photo in their bin, the host's own photo that failed, two photos
// in the gathering's bin and two published ones (the grid's tiles). The All
// view's rows are w1, w2, w3, o1, b1, f1; the queue's w1, w2, w3, o1; the
// Removed view's g1, g2.
function theWorld(): Row[] {
  return [
    photo('w1', waiting),
    photo('w2', waiting),
    photo('w3', waiting),
    photo('o1', { ...own, ...waiting, tags: ['dock'] }),
    photo('b1', inOwnBin()),
    photo('f1', { ...own, status: 'failed', publication_state: 'pending', published_at: null, failure_reason: 'unreadable' }),
    photo('g1', inGatheringBin()),
    photo('g2', inGatheringBin()),
    photo('p1'),
    photo('p2'),
  ]
}

beforeEach(() => {
  clearCoverPictures()
  localStorage.clear()
  setToken('token-ada')
  resetPhotosWorld(theWorld())
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

// A press whose request the server holds on `key`, focus dropped to the body
// (or moved to `movedTo`) while it waits; then the re-read it starts lands.
async function held(key: Key, control: HTMLElement, movedTo?: HTMLElement) {
  photosWorld.hold[key] = gate()
  await pressHeld(control, photosWorld.hold[key]!, movedTo)
  await settle()
  await settle()
}

const heading = () => document.getElementById('photos-heading')
const block = () => document.querySelector('.media-block') as HTMLElement
const inRow = (name: string, label: string | RegExp) => within(rowOf(name)).getByRole('button', { name: label })
const sectionButton = (label: string | RegExp) => within(block()).getByRole('button', { name: label })
const search = () => screen.getByLabelText('Find a photo')
const fileInput = () => screen.getByLabelText('Add photos')

async function view(name: 'Awaiting your review' | 'Removed from this gathering') {
  fireEvent.click(sectionButton(name))
  await settle()
  await settle()
}

// Focus on a step: a group, named by its sentence.
function expectStep(sentence: string) {
  const active = document.activeElement as HTMLElement
  expect(active.getAttribute('role')).toBe('group')
  expect(labelledName(active)).toBe(sentence)
}

// THE HAZARD, pinned: a second press on whatever the step's opening focused
// sends nothing.
async function pressFocusedAgain() {
  const before = photosWorld.writes.length
  fireEvent.click(document.activeElement as HTMLElement)
  await settle()
  expect(photosWorld.writes.slice(before)).toEqual([])
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

test("Publish's refusal puts focus back on that row's Publish", async () => {
  await open()
  photosWorld.answer.publish = conflict('already_live')
  await held('publish', inRow(W1, 'Publish'))
  expect(document.activeElement).toBe(inRow(W1, 'Publish'))
})

test("Publish's success in the All view, the row gone to the grid, puts focus on the Photos heading", async () => {
  await open()
  await held('publish', inRow(W1, 'Publish'))
  expect(rowGone(W1)).toBe(true)
  expect(document.activeElement).toBe(heading())
})

test("Publish's success in the queue puts focus on the Publish of the row now in its place", async () => {
  await open()
  await view('Awaiting your review')
  await held('publish', inRow(W1, 'Publish'))
  expect(rowGone(W1)).toBe(true)
  expect(document.activeElement).toBe(inRow(W2, 'Publish'))
})

test("Publish's success on the queue's last row puts focus on the new last row's Publish", async () => {
  await open()
  await view('Awaiting your review')
  await held('publish', inRow(O1, 'Publish'))
  expect(rowGone(O1)).toBe(true)
  expect(document.activeElement).toBe(inRow(W3, 'Publish'))
})

test("Publish's success on the queue's only row puts focus on the Photos heading", async () => {
  resetPhotosWorld([photo('w1', waiting), photo('p1')])
  await open()
  await view('Awaiting your review')
  await held('publish', inRow(W1, 'Publish'))
  expect(document.querySelectorAll('li.media-item')).toHaveLength(0)
  expect(document.activeElement).toBe(heading())
})

// ---------------------------------------------------------------------------
// Decline
// ---------------------------------------------------------------------------

test('Decline opens its step with focus on the step, never on Decline it', async () => {
  await open()
  inRow(W1, 'Decline').focus()
  fireEvent.click(inRow(W1, 'Decline'))
  await settle()
  expectStep(HOST_TAKEDOWN)
  expect(document.activeElement).not.toBe(inRow(W1, 'Decline it'))
  await pressFocusedAgain()
})

test('the decline step on your own photo is named by its own sentence', async () => {
  await open()
  inRow(O1, 'Decline').focus()
  fireEvent.click(inRow(O1, 'Decline'))
  await settle()
  expectStep(OWN_DECLINE)
})

test('Leave it waiting puts focus back on Decline', async () => {
  await open()
  fireEvent.click(inRow(W1, 'Decline'))
  await settle()
  inRow(W1, 'Leave it waiting').focus()
  fireEvent.click(inRow(W1, 'Leave it waiting'))
  await settle()
  expect(document.activeElement).toBe(inRow(W1, 'Decline'))
})

test("Decline it's refusal puts focus on that row's Decline", async () => {
  await open()
  fireEvent.click(inRow(W1, 'Decline'))
  await settle()
  photosWorld.answer.decline = conflict('not_pending')
  await held('decline', inRow(W1, 'Decline it'))
  expect(document.activeElement).toBe(inRow(W1, 'Decline'))
})

test("Decline it's success on your own photo, still listed in your bin, puts focus on its Put back", async () => {
  await open()
  fireEvent.click(inRow(O1, 'Decline'))
  await settle()
  await held('decline', inRow(O1, 'Decline it'))
  expect(document.activeElement).toBe(inRow(O1, 'Put back'))
})

test("Decline it's success in the All view, the row gone, puts focus on the Photos heading", async () => {
  await open()
  fireEvent.click(inRow(W1, 'Decline'))
  await settle()
  await held('decline', inRow(W1, 'Decline it'))
  expect(rowGone(W1)).toBe(true)
  expect(document.activeElement).toBe(heading())
})

test("Decline it's success in the queue puts focus on the next row's Publish", async () => {
  await open()
  await view('Awaiting your review')
  fireEvent.click(inRow(W2, 'Decline'))
  await settle()
  await held('decline', inRow(W2, 'Decline it'))
  expect(rowGone(W2)).toBe(true)
  expect(document.activeElement).toBe(inRow(W3, 'Publish'))
})

// ---------------------------------------------------------------------------
// Send to bin and Put back
// ---------------------------------------------------------------------------

test("Send to bin's refusal puts focus back on Send to bin", async () => {
  await open()
  photosWorld.answer.remove = conflict('not_ready')
  await held('remove', inRow(O1, 'Send to bin'))
  expect(document.activeElement).toBe(inRow(O1, 'Send to bin'))
})

test("Send to bin's success, the row still listed, puts focus on its Put back", async () => {
  await open()
  await held('remove', inRow(O1, 'Send to bin'))
  expect(document.activeElement).toBe(inRow(O1, 'Put back'))
})

test("Send to bin's success in the queue, the row gone, puts focus on the new last row's Publish", async () => {
  await open()
  await view('Awaiting your review')
  await held('remove', inRow(O1, 'Send to bin'))
  expect(rowGone(O1)).toBe(true)
  expect(document.activeElement).toBe(inRow(W3, 'Publish'))
})

test("Put back's refusal puts focus back on Put back", async () => {
  await open()
  photosWorld.answer.restore = conflict('not_removed')
  await held('restore', inRow(B1, 'Put back'))
  expect(document.activeElement).toBe(inRow(B1, 'Put back'))
})

test("Put back's success, the photo waiting and still listed, puts focus on its Send to bin", async () => {
  await open()
  await held('restore', inRow(B1, 'Put back'))
  expect(document.activeElement).toBe(inRow(B1, 'Send to bin'))
})

test("Put back's success in the Removed view puts focus on the Put back of the row now in its place", async () => {
  await open()
  await view('Removed from this gathering')
  await held('restore', inRow(G1, 'Put back'))
  expect(rowGone(G1)).toBe(true)
  expect(document.activeElement).toBe(inRow(G2, 'Put back'))
})

test("Put back's success on the Removed view's last row puts focus on the new last row's Put back", async () => {
  await open()
  await view('Removed from this gathering')
  await held('restore', inRow(G2, 'Put back'))
  expect(rowGone(G2)).toBe(true)
  expect(document.activeElement).toBe(inRow(G1, 'Put back'))
})

test("Put back's success emptying the Removed view puts focus on the Photos heading", async () => {
  resetPhotosWorld([photo('g1', inGatheringBin()), photo('p1')])
  await open()
  await view('Removed from this gathering')
  await held('restore', inRow(G1, 'Put back'))
  expect(document.querySelectorAll('li.media-item')).toHaveLength(0)
  expect(document.activeElement).toBe(heading())
})

// ---------------------------------------------------------------------------
// Delete permanently
// ---------------------------------------------------------------------------

test('Delete permanently opens its step with focus on the step, never on its Delete permanently', async () => {
  await open()
  inRow(B1, 'Delete permanently').focus()
  fireEvent.click(inRow(B1, 'Delete permanently'))
  await settle()
  expectStep(DELETE_PERMANENTLY_CONFIRMATION)
  await pressFocusedAgain()
  expect(photosWorld.writes).toEqual([])
})

test('Keep it puts focus back on Delete permanently', async () => {
  await open()
  fireEvent.click(inRow(B1, 'Delete permanently'))
  await settle()
  inRow(B1, 'Keep it').focus()
  fireEvent.click(inRow(B1, 'Keep it'))
  await settle()
  expect(document.activeElement).toBe(inRow(B1, 'Delete permanently'))
})

test("the delete step's refusal puts focus on that row's Delete permanently", async () => {
  await open()
  fireEvent.click(inRow(B1, 'Delete permanently'))
  await settle()
  photosWorld.answer.destroy = conflict('not_removed')
  const confirm = within(rowOf(B1)).getByRole('group').querySelector('button') as HTMLElement
  await held('destroy', confirm)
  expect(document.activeElement).toBe(inRow(B1, 'Delete permanently'))
})

test("the delete step's success in the All view puts focus on the Photos heading", async () => {
  await open()
  fireEvent.click(inRow(B1, 'Delete permanently'))
  await settle()
  const confirm = within(rowOf(B1)).getByRole('group').querySelector('button') as HTMLElement
  await held('destroy', confirm)
  expect(rowGone(B1)).toBe(true)
  expect(document.activeElement).toBe(heading())
})

test("the delete step's success in the Removed view puts focus on the next row's Put back", async () => {
  await open()
  await view('Removed from this gathering')
  fireEvent.click(inRow(G1, 'Delete permanently'))
  await settle()
  const confirm = within(rowOf(G1)).getByRole('group').querySelector('button') as HTMLElement
  await held('destroy', confirm)
  expect(rowGone(G1)).toBe(true)
  expect(document.activeElement).toBe(inRow(G2, 'Put back'))
})

// ---------------------------------------------------------------------------
// Remove from gathering — a row offers it only while the list is being read
// for another view (the All view's published photos are the grid's tiles),
// so these hold the read.
// ---------------------------------------------------------------------------

async function switchingToQueue() {
  resetPhotosWorld([photo('p1'), ...theWorld().filter((row) => row.id !== 'p1')])
  await open()
  photosWorld.hold.list = gate()
  fireEvent.click(sectionButton('Awaiting your review'))
  await settle()
  return inRow(P1, 'Remove from gathering')
}

test('Remove from gathering opens its step with focus on the step, never on Remove it', async () => {
  const opener = await switchingToQueue()
  opener.focus()
  fireEvent.click(opener)
  await settle()
  expectStep(HOST_TAKEDOWN)
  await pressFocusedAgain()
})

test('Leave it puts focus back on Remove from gathering', async () => {
  const opener = await switchingToQueue()
  fireEvent.click(opener)
  await settle()
  inRow(P1, 'Leave it').focus()
  fireEvent.click(inRow(P1, 'Leave it'))
  await settle()
  expect(document.activeElement).toBe(inRow(P1, 'Remove from gathering'))
})

test("Remove it's refusal puts focus back on Remove from gathering", async () => {
  const opener = await switchingToQueue()
  fireEvent.click(opener)
  await settle()
  photosWorld.answer.remove = conflict('not_ready')
  await held('remove', inRow(P1, 'Remove it'))
  expect(document.activeElement).toBe(inRow(P1, 'Remove from gathering'))
})

test("Remove it's success, once the queue's read lands, puts focus on the Publish of the row now in its place", async () => {
  const opener = await switchingToQueue()
  fireEvent.click(opener)
  await settle()
  await held('remove', inRow(P1, 'Remove it'))
  await act(async () => photosWorld.hold.list!.release())
  await settle()
  await settle()
  expect(rowGone(P1)).toBe(true)
  expect(document.activeElement).toBe(inRow(W1, 'Publish'))
})

// ---------------------------------------------------------------------------
// Dismiss
// ---------------------------------------------------------------------------

test("Dismiss's refusal puts focus back on Dismiss", async () => {
  await open()
  photosWorld.answer.dismiss = conflict('not_failed')
  await held('dismiss', inRow(F1, 'Dismiss'))
  expect(document.activeElement).toBe(inRow(F1, 'Dismiss'))
})

test("Dismiss's success, the row gone, puts focus on the Photos heading", async () => {
  await open()
  await held('dismiss', inRow(F1, 'Dismiss'))
  expect(rowGone(F1)).toBe(true)
  expect(document.activeElement).toBe(heading())
})

// ---------------------------------------------------------------------------
// The row's editor
// ---------------------------------------------------------------------------

const editor = () => within(rowOf(O1)).getByRole('form')

async function openEditor() {
  inRow(O1, 'Edit caption and tags').focus()
  fireEvent.click(inRow(O1, 'Edit caption and tags'))
  await settle()
  fireEvent.change(within(editor()).getByLabelText('Caption'), { target: { value: 'At the dock' } })
}

test('Edit caption and tags puts focus on the Caption field', async () => {
  await open()
  await openEditor()
  expect(document.activeElement).toBe(within(editor()).getByLabelText('Caption'))
})

test("the editor's Cancel puts focus back on Edit caption and tags", async () => {
  await open()
  await openEditor()
  within(editor()).getByRole('button', { name: 'Cancel' }).focus()
  fireEvent.click(within(editor()).getByRole('button', { name: 'Cancel' }))
  await settle()
  expect(document.activeElement).toBe(inRow(O1, 'Edit caption and tags'))
})

test("Save's 422 on the caption puts focus on the Caption field", async () => {
  await open()
  await openEditor()
  photosWorld.answer.patch = invalid('caption')
  await held('patch', within(editor()).getByRole('button', { name: 'Save' }))
  expect(document.activeElement).toBe(within(editor()).getByLabelText('Caption'))
})

test("Save's 422 on a tag, which names no field, puts focus back on Save", async () => {
  await open()
  await openEditor()
  photosWorld.answer.patch = invalid('tags', 0)
  await held('patch', within(editor()).getByRole('button', { name: 'Save' }))
  expect(document.activeElement).toBe(within(editor()).getByRole('button', { name: 'Save' }))
})

test("Save's failure puts focus back on Save", async () => {
  await open()
  await openEditor()
  photosWorld.answer.patch = { status: 500 }
  await held('patch', within(editor()).getByRole('button', { name: 'Save' }))
  expect(document.activeElement).toBe(within(editor()).getByRole('button', { name: 'Save' }))
})

test("Save's success puts focus on Edit caption and tags", async () => {
  await open()
  await openEditor()
  await held('patch', within(editor()).getByRole('button', { name: 'Save' }))
  // the row is called by its new caption now
  expect(within(rowOf('At the dock')).queryByRole('form')).toBeNull()
  expect(document.activeElement).toBe(inRow('At the dock', 'Edit caption and tags'))
})

// ---------------------------------------------------------------------------
// Refresh the list (a row's)
// ---------------------------------------------------------------------------

async function refusedPublish() {
  photosWorld.answer.publish = conflict('already_live')
  fireEvent.click(inRow(W1, 'Publish'))
  await settle()
  await settle()
  delete photosWorld.answer.publish
  return inRow(W1, 'Refresh the list')
}

test("a row's Refresh the list, landing, puts focus on the Photos heading", async () => {
  await open()
  const refresh = await refusedPublish()
  await held('list', refresh)
  expect(document.activeElement).toBe(heading())
})

// Added by the mutation run (a marker spent by any read survived): THE ROW
// GONE is spent only by a read begun after the act. Here a read begun before
// it (a row's Refresh the list) is answered in the same moment as the act,
// with the row still in it, and lands before the act's own re-read is begun;
// it moves nothing, and the act's re-read lands focus on the row now in its
// place.
test('THE ROW GONE waits for a read begun after the act: one already in flight when the act lands moves nothing', async () => {
  await open()
  await view('Awaiting your review')
  const refresh = await refusedPublish()
  const together = gate()
  photosWorld.hold.list = together
  photosWorld.hold.publish = together
  fireEvent.click(refresh)
  await settle()
  const publish = inRow(W2, 'Publish')
  publish.focus()
  fireEvent.click(publish)
  await waitFor(() => expect((publish as HTMLButtonElement).disabled).toBe(true))
  dropFocusToBody()
  await act(async () => together.release())
  await settle()
  await settle()
  expect(rowGone(W2)).toBe(true)
  expect(document.activeElement).toBe(inRow(W3, 'Publish'))
})

test("a row's Refresh the list, failing, puts focus on the section's Try again", async () => {
  await open()
  const refresh = await refusedPublish()
  photosWorld.failList = 1
  await held('list', refresh)
  expect(document.activeElement).toBe(sectionButton('Try again'))
})

// ---------------------------------------------------------------------------
// The batch
// ---------------------------------------------------------------------------

const batch = () => screen.getByRole('form', { name: 'Publish selected photos' })
const batchSubmit = () => within(batch()).getByRole('button', { name: /^Publish \d selected photos?$/ })

async function selectAll() {
  await view('Awaiting your review')
  fireEvent.click(within(batch()).getByRole('button', { name: 'Select all' }))
  await settle()
}

test("the batch's 422 on one of its rows puts focus on that row's checkbox", async () => {
  await open()
  await selectAll()
  photosWorld.answer.batch = invalid('media_ids', 1)
  await held('batch', batchSubmit())
  expect(document.activeElement).toBe(within(rowOf(W2)).getByRole('checkbox'))
})

test("the batch's 422 on the whole selection puts focus back on its button", async () => {
  await open()
  await selectAll()
  photosWorld.answer.batch = invalid('media_ids')
  await held('batch', batchSubmit())
  expect(document.activeElement).toBe(batchSubmit())
})

test("the batch's failure puts focus back on its button", async () => {
  await open()
  await selectAll()
  photosWorld.answer.batch = { status: 500 }
  await held('batch', batchSubmit())
  expect(document.activeElement).toBe(batchSubmit())
})

test("the batch's success puts focus on the Publish of the row now in the first published row's place", async () => {
  await open()
  await view('Awaiting your review')
  fireEvent.click(within(rowOf(W2)).getByRole('checkbox'))
  await settle()
  await held('batch', batchSubmit())
  expect(rowGone(W2)).toBe(true)
  expect(document.activeElement).toBe(inRow(W3, 'Publish'))
})

test("the batch's success emptying the queue puts focus on the Photos heading", async () => {
  await open()
  await selectAll()
  await held('batch', batchSubmit())
  expect(document.querySelectorAll('li.media-item')).toHaveLength(0)
  expect(document.activeElement).toBe(heading())
})

test("the batch's Refresh the list, landing, puts focus on the Photos heading; failing, on Try again", async () => {
  await open()
  await selectAll()
  photosWorld.answer.batch = invalid('media_ids', 0)
  fireEvent.click(batchSubmit())
  await settle()
  await settle()
  delete photosWorld.answer.batch
  await held('list', within(batch()).getByRole('button', { name: 'Refresh the list' }))
  expect(document.activeElement).toBe(heading())
  // and once more, the re-read failing (the selection stays through Refresh
  // the list, as it always has, so nothing is selected again)
  photosWorld.answer.batch = invalid('media_ids', 0)
  fireEvent.click(batchSubmit())
  await settle()
  await settle()
  delete photosWorld.answer.batch
  photosWorld.failList = 1
  await held('list', within(batch()).getByRole('button', { name: 'Refresh the list' }))
  expect(document.activeElement).toBe(sectionButton('Try again'))
})

// ---------------------------------------------------------------------------
// Show all photos
// ---------------------------------------------------------------------------

test('Show all photos from the queue puts focus on the All photos button', async () => {
  await open()
  await view('Awaiting your review')
  const showAll = sectionButton('Show all photos')
  showAll.focus()
  fireEvent.click(showAll)
  await settle()
  await settle()
  expect(document.activeElement).toBe(sectionButton('All photos'))
})

test('Show all photos from the Removed view puts focus on the All photos button', async () => {
  await open()
  await view('Removed from this gathering')
  const showAll = sectionButton('Show all photos')
  showAll.focus()
  fireEvent.click(showAll)
  await settle()
  await settle()
  expect(document.activeElement).toBe(sectionButton('All photos'))
})

test('Show all photos after a search puts focus on Find a photo', async () => {
  await open()
  fireEvent.change(search(), { target: { value: 'dock' } })
  await settle(400)
  await settle()
  const showAll = sectionButton('Show all photos')
  showAll.focus()
  fireEvent.click(showAll)
  await settle()
  await settle()
  expect((search() as HTMLInputElement).value).toBe('')
  expect(document.activeElement).toBe(search())
})

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

function choose() {
  const file = new File([new Uint8Array([1, 2, 3])], 'IMG_0569.jpg', { type: 'image/jpeg' })
  fireEvent.change(fileInput(), { target: { files: [file] } })
}

test("Upload's 422 on the photo puts focus on the file input", async () => {
  await open()
  choose()
  photosWorld.answer.intents = invalid('items', 0, 'content_type')
  await held('intents', sectionButton('Upload'))
  expect(document.activeElement).toBe(fileInput())
})

test("Upload's 422 on the batch puts focus on the file input", async () => {
  await open()
  choose()
  photosWorld.answer.intents = invalid('items')
  await held('intents', sectionButton('Upload'))
  expect(document.activeElement).toBe(fileInput())
})

test("Upload's failure puts focus back on Upload", async () => {
  await open()
  choose()
  photosWorld.answer.intents = { status: 500 }
  await held('intents', sectionButton('Upload'))
  expect(document.activeElement).toBe(sectionButton('Upload'))
})

test("Upload's success puts focus on the file input once the last confirm is answered, and not before", async () => {
  await open()
  choose()
  photosWorld.hold.confirm = gate()
  await held('intents', sectionButton(/^Upload/))
  expect(document.activeElement).toBe(document.body)
  await act(async () => photosWorld.hold.confirm!.release())
  await settle()
  await settle()
  expect(document.activeElement).toBe(fileInput())
})

// ---------------------------------------------------------------------------
// Try again (the section's)
// ---------------------------------------------------------------------------

test("Try again, landing, puts focus on the Photos heading", async () => {
  photosWorld.failList = 1
  await open()
  await held('list', sectionButton('Try again'))
  expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0)
  expect(document.activeElement).toBe(heading())
})

test('Try again, failing again, puts focus on the new Try again', async () => {
  photosWorld.failList = 2
  await open()
  await held('list', sectionButton('Try again'))
  expect(document.activeElement).toBe(sectionButton('Try again'))
})

// ---------------------------------------------------------------------------
// A person who moved on
// ---------------------------------------------------------------------------

test("a person who moved on while a row's act waited keeps their place, refused or landed", async () => {
  await open()
  photosWorld.answer.publish = conflict('already_live')
  await held('publish', inRow(W1, 'Publish'), search())
  expect(document.activeElement).toBe(search())
  delete photosWorld.answer.publish
  fireEvent.click(inRow(W1, 'Refresh the list'))
  await settle()
  await settle()
  ;(document.activeElement as HTMLElement).blur()
  await held('publish', inRow(W2, 'Publish'), search())
  expect(rowGone(W2)).toBe(true)
  expect(document.activeElement).toBe(search())
})

test('a person who moved on while an upload waited keeps their place, refused or landed', async () => {
  await open()
  choose()
  photosWorld.answer.intents = { status: 500 }
  await held('intents', sectionButton('Upload'), search())
  expect(document.activeElement).toBe(search())
  delete photosWorld.answer.intents
  await held('intents', sectionButton('Upload'), search())
  expect(document.activeElement).toBe(search())
})

// Added at the measurement, for the kickoff's plant on each container kind:
// the section's own acts move focus only from the body or inside the section.
test('a person who moved outside the Photos section while Try again waited keeps their place, refused or landed', async () => {
  photosWorld.failList = 2
  await open()
  const away = screen.getAllByRole('button', { name: 'Add photos' }).find((b) => !block().contains(b))!
  await held('list', sectionButton('Try again'), away)
  expect(sectionButton('Try again')).toBeTruthy()
  expect(document.activeElement).toBe(away)
  await held('list', sectionButton('Try again'), away)
  expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0)
  expect(document.activeElement).toBe(away)
})
