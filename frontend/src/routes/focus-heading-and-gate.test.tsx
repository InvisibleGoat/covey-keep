// CK-98 — Show co-hosts lands on its heading, the review gate reads only the
// gathering on screen, and the sweep's three controls, through the app's
// REAL route table with the REAL AuthProvider, against the two fake servers
// (test-support/world96.ts and test-support/photos.ts). The values under
// test (the kickoff's THE DESIGN §2, §3 and §5, and Steven's answers of
// 2026-11-16):
// - on a group's gathering, Show co-hosts puts focus on the section's <h2>
//   Co-hosts at once, the list read held; nothing more moves when it lands
//   or fails; a standalone gathering's Invite people stays on Email address;
// - the review gate (`reviewer`) and the poll read the held list only while
//   it was read for the gathering on screen: a move to a gathering whose
//   review is off shows no Awaiting your review until its own read lands
//   with something waiting; a move to one whose review is on shows it at
//   once; an in-flight row on the gathering left schedules no re-read of
//   the new one; the queue view open, a move to a review-off gathering is
//   the All view at once, read once — and, decided (Q1), the All view too
//   where a photo is stranded waiting there;
// - the New gathering form's Remove this date puts focus on the Starts of
//   the date now in its place, else the previous date's (Q2);
// - the caption-and-tags editor's Remove on a chip puts focus on the Remove
//   of the chip now in its place, else the previous chip's, else the Add a
//   tag field (Q3); Add tag on the cleared Add a tag field (Q4), in a row's
//   editor and in the photo viewer's.
// Chrome drops focus to the body from a control the press removes or
// disables; jsdom does not, so where a test stages the drop it does so by
// hand (test-support/focus.ts).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import App from '../App'
import { AuthProvider } from '../auth/AuthContext'
import { clearCoverPictures } from '../lib/covers'
import { POLL_INTERVAL_MS } from '../lib/media'
import { setToken } from '../lib/session'
import { dropFocusToBody, gate, settle } from '../test-support/focus'
import { own, photo, photosWorld, resetPhotosWorld, rowOf, stubPhotosServer, waiting, type Row } from '../test-support/photos'
import { gatheringDetail, GROUP, resetWorld96, stubWidth, stubWorld96, world96 } from '../test-support/world96'

vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
  startRegistration: async () => ({}),
  startAuthentication: async () => ({}),
}))

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  )
}

// ===================================================================== world96

describe('on world96', () => {
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

  async function settled() {
    await waitFor(() => expect(world96.inflight).toBe(0))
    await settle()
  }

  const coHostsHeading = () => screen.getByRole('heading', { name: 'Co-hosts', level: 2 })
  const coHostsSection = () => coHostsHeading().closest('section') as HTMLElement

  // ------------------------------------------------------ §2 Show co-hosts

  async function groupGathering() {
    world96.detail['g-2'] = gatheringDetail('g-2')
    renderAt('/gatherings/g-2')
    await screen.findByRole('button', { name: 'Show co-hosts' })
    await settled()
  }

  // Press Show co-hosts with both of the section's reads held.
  async function showCoHostsHeld() {
    await groupGathering()
    const hold = gate()
    world96.hold.coHosts = hold
    world96.hold.roster = hold
    const show = screen.getByRole('button', { name: 'Show co-hosts' })
    show.focus()
    fireEvent.click(show)
    await settle()
    return { hold, show }
  }

  test("§2 Show co-hosts on a group's gathering puts focus on Co-hosts at once, the list read held", async () => {
    const { hold, show } = await showCoHostsHeld()
    expect(show.isConnected).toBe(false)
    expect(document.activeElement).toBe(coHostsHeading())
    await act(async () => hold.release())
    await settled()
  })

  test('§2 the co-host list landing moves nothing: focus still on Co-hosts', async () => {
    const { hold } = await showCoHostsHeld()
    await act(async () => hold.release())
    await settled()
    expect(within(coHostsSection()).getByRole('button', { name: 'Make co-host' })).toBeTruthy()
    expect(document.activeElement).toBe(coHostsHeading())
  })

  test('§2 the co-host list failing moves nothing: focus still on Co-hosts, the line an alert and its Try again there', async () => {
    world96.fail.coHosts = { status: 500 }
    const { hold } = await showCoHostsHeld()
    await act(async () => hold.release())
    await settled()
    expect(within(coHostsSection()).getByRole('alert').textContent).toContain("The co-host list couldn't be loaded just now.")
    expect(within(coHostsSection()).getByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(document.activeElement).toBe(coHostsHeading())
  })

  test("§2 a standalone gathering's Invite people still puts focus on Email address, never the heading", async () => {
    renderAt('/gatherings/g-1')
    const invite = await screen.findByRole('button', { name: 'Invite people' })
    await settled()
    const hold = gate()
    world96.hold.coHosts = hold
    world96.hold.roster = hold
    invite.focus()
    fireEvent.click(invite)
    await settle()
    const section = screen.getByRole('heading', { name: 'Invitations', level: 2 }).closest('section') as HTMLElement
    expect(document.activeElement).toBe(within(section).getByLabelText('Email address'))
    await act(async () => hold.release())
    await settled()
    expect(document.activeElement).toBe(within(section).getByLabelText('Email address'))
  })

  // ------------------------------------- §5 the New gathering form's dates

  async function newGathering(path: string, dates: number) {
    renderAt(path)
    await screen.findByRole('heading', { level: 1, name: /New gathering/ })
    await settled()
    for (let added = 1; added < dates; added++) {
      fireEvent.click(screen.getByRole('button', { name: 'Add another date' }))
    }
    expect(screen.getAllByLabelText('Starts')).toHaveLength(dates)
    // Each date's Starts told apart by a value of its own.
    screen.getAllByLabelText('Starts').forEach((input, index) =>
      fireEvent.change(input, { target: { value: `2026-12-0${index + 1}T18:00` } }),
    )
  }

  // Press date `n`'s Remove this date (0-based), focus dropped to the body
  // as Chrome drops it from a removed control.
  async function removeDate(n: number) {
    const remove = screen.getAllByRole('button', { name: 'Remove this date' })[n]
    remove.focus()
    fireEvent.click(remove)
    await settle()
  }

  const starts = () => screen.getAllByLabelText('Starts') as HTMLInputElement[]

  test('§5 Remove this date on a middle date puts focus on the Starts of the date now in its place', async () => {
    await newGathering('/gatherings/new', 3)
    await removeDate(1)
    expect(starts().map((input) => input.value)).toEqual(['2026-12-01T18:00', '2026-12-03T18:00'])
    expect(document.activeElement).toBe(starts()[1])
  })

  test('§5 Remove this date on the first date puts focus on the Starts of the date now first', async () => {
    await newGathering('/gatherings/new', 2)
    await removeDate(0)
    expect(starts()).toHaveLength(1)
    expect(starts()[0].value).toBe('2026-12-02T18:00')
    expect(document.activeElement).toBe(starts()[0])
  })

  test("§5 Remove this date on the last date puts focus on the previous date's Starts", async () => {
    await newGathering('/gatherings/new', 3)
    await removeDate(2)
    expect(starts().map((input) => input.value)).toEqual(['2026-12-01T18:00', '2026-12-02T18:00'])
    expect(document.activeElement).toBe(starts()[1])
  })

  test("§5 the group form's Remove this date takes the same rule", async () => {
    await newGathering(`/groups/${GROUP.id}/gatherings/new`, 2)
    await removeDate(1)
    expect(starts()).toHaveLength(1)
    expect(document.activeElement).toBe(starts()[0])
  })

  test('§5 Remove this date moves nothing when the person is elsewhere', async () => {
    await newGathering('/gatherings/new', 2)
    const stand = document.createElement('button')
    document.body.append(stand)
    const remove = screen.getAllByRole('button', { name: 'Remove this date' })[0]
    // A press from a pointer that left focus outside the form.
    stand.focus()
    fireEvent.click(remove)
    await settle()
    expect(document.activeElement).toBe(stand)
    stand.remove()
  })
})

// ===================================================================== photos

describe('on the photos world', () => {
  beforeEach(() => {
    clearCoverPictures()
    localStorage.clear()
    setToken('token-ada')
    stubPhotosServer()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} }))
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    localStorage.clear()
  })

  async function open() {
    renderAt('/gatherings/g-1')
    await screen.findByRole('heading', { level: 1, name: 'The Party' })
    await settle()
    await settle()
  }

  const block = () => document.querySelector('.media-block') as HTMLElement
  const reviewButton = () => within(block()).queryByRole('button', { name: 'Awaiting your review' })
  const allButton = () => within(block()).getByRole('button', { name: 'All photos' })
  const reviewStrings = ['Awaiting your review', 'Waiting for you to publish or decline it.', 'Nothing is waiting for your review.']
  const g2Reads = () => photosWorld.listReads.filter((read) => read.startsWith('/gatherings/g-2/media'))

  // The Party (g-1, review on) with two photos waiting for the host, one
  // published; The Picnic (g-2) beside it with `picnic` as its detail's own.
  function world(picnic: Record<string, unknown>, picnicRows: Row[] = []) {
    resetPhotosWorld([photo('w1', waiting), photo('w2', waiting), photo('p1')])
    photosWorld.second = true
    photosWorld.secondDetail = picnic
    photosWorld.secondRows = picnicRows
  }
  const reviewOff = { requires_approval: false, requires_approval_override: null }
  const stranded = () => photo('s1', { ...waiting, gathering_id: 'g-2' })

  // Move to The Picnic through the menu with its list read held.
  async function moveHeld() {
    const hold = gate()
    photosWorld.hold.list = hold
    const link = (await screen.findAllByRole('link', { name: /The Picnic/, hidden: true }))[0]
    fireEvent.click(link)
    await screen.findByRole('heading', { level: 1, name: 'The Picnic' })
    await settle()
    return hold
  }

  async function release(hold: { release: () => void }) {
    await act(async () => hold.release())
    await settle()
    await settle()
    delete photosWorld.hold.list
    await settle()
  }

  // ------------------------------------------------- §3 the review gate

  test('§3 a move to a gathering whose review is off, its read held: no Awaiting your review and no review string', async () => {
    world(reviewOff)
    await open()
    expect(reviewButton()).not.toBeNull()
    const hold = await moveHeld()
    expect(reviewButton()).toBeNull()
    for (const words of reviewStrings) expect(block().textContent).not.toContain(words)
    await release(hold)
    expect(within(block()).getByText('No photos yet.')).toBeTruthy()
    expect(reviewButton()).toBeNull()
    for (const words of reviewStrings) expect(block().textContent).not.toContain(words)
  })

  test('§3 the same move: the switch appears only once the new read lands with something waiting', async () => {
    world(reviewOff, [stranded()])
    await open()
    const hold = await moveHeld()
    expect(reviewButton()).toBeNull()
    await release(hold)
    expect(reviewButton()).not.toBeNull()
    expect(rowOf('IMG_s1.jpg').textContent).toContain('Waiting for you to publish or decline it.')
  })

  test('§3 a move to a gathering whose review is on shows Awaiting your review at once, the read held', async () => {
    world({})
    await open()
    const hold = await moveHeld()
    expect(reviewButton()).not.toBeNull()
    await release(hold)
    expect(reviewButton()).not.toBeNull()
  })

  test('§3 a move from a gathering with an in-flight row, its read held past POLL_INTERVAL_MS: no second list read of the new one', async () => {
    resetPhotosWorld([photo('f1', { ...own, ...waiting, status: 'processing' }), photo('p1')])
    photosWorld.second = true
    photosWorld.secondDetail = reviewOff
    vi.useFakeTimers()
    renderAt('/gatherings/g-1')
    const flush = async (times = 8) => {
      for (let i = 0; i < times; i++) await act(async () => void (await vi.advanceTimersByTimeAsync(0)))
    }
    await flush()
    expect(screen.getByRole('heading', { level: 1, name: 'The Party' })).toBeTruthy()
    expect(photosWorld.listReads).toEqual(['/gatherings/g-1/media'])
    const hold = gate()
    photosWorld.hold.list = hold
    fireEvent.click(screen.getAllByRole('link', { name: /The Picnic/, hidden: true })[0])
    await flush()
    expect(screen.getByRole('heading', { level: 1, name: 'The Picnic' })).toBeTruthy()
    expect(g2Reads()).toEqual(['/gatherings/g-2/media'])
    await act(async () => void (await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)))
    await flush()
    expect(g2Reads()).toEqual(['/gatherings/g-2/media'])
    await act(async () => hold.release())
    await flush()
    await act(async () => void (await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)))
    await flush()
    expect(g2Reads()).toEqual(['/gatherings/g-2/media'])
    expect(photosWorld.listReads.filter((read) => read.startsWith('/gatherings/g-1/media'))).toEqual(['/gatherings/g-1/media'])
  })

  async function inQueue() {
    await open()
    fireEvent.click(reviewButton() as HTMLElement)
    await settle()
    await settle()
    expect(reviewButton()?.getAttribute('aria-pressed')).toBe('true')
  }

  test('§3 the queue view open, a move to a gathering whose review is off: the All view at once, read once, and no queue read of it', async () => {
    world(reviewOff)
    await inQueue()
    const hold = await moveHeld()
    expect(allButton().getAttribute('aria-pressed')).toBe('true')
    expect(reviewButton()).toBeNull()
    await release(hold)
    expect(g2Reads()).toEqual(['/gatherings/g-2/media'])
    expect(allButton().getAttribute('aria-pressed')).toBe('true')
    expect(within(block()).getByText('No photos yet.')).toBeTruthy()
  })

  test('§3 (Q1, decided) the queue view open, a move to a review-off gathering with a photo stranded waiting: the All view, Awaiting your review unpressed', async () => {
    world(reviewOff, [stranded()])
    await inQueue()
    const hold = await moveHeld()
    expect(allButton().getAttribute('aria-pressed')).toBe('true')
    await release(hold)
    expect(g2Reads()).toEqual(['/gatherings/g-2/media'])
    expect(allButton().getAttribute('aria-pressed')).toBe('true')
    expect(reviewButton()?.getAttribute('aria-pressed')).toBe('false')
    expect(within(rowOf('IMG_s1.jpg')).getByRole('button', { name: 'Publish' })).toBeTruthy()
  })

  test('§3 the queue view open, a move to a gathering whose review is on: the queue view stays and reads the new queue', async () => {
    world({}, [stranded()])
    await inQueue()
    const hold = await moveHeld()
    expect(reviewButton()?.getAttribute('aria-pressed')).toBe('true')
    await release(hold)
    expect(g2Reads()).toEqual(['/gatherings/g-2/media?awaiting_review=true'])
    expect(reviewButton()?.getAttribute('aria-pressed')).toBe('true')
    expect(rowOf('IMG_s1.jpg')).toBeTruthy()
  })

  // --------------------------------- §5 the caption-and-tags editor (Q3, Q4)

  // A row's editor: your own waiting photo o1, tagged Dock, Dawn and Pier.
  async function rowEditor() {
    resetPhotosWorld([photo('o1', { ...own, ...waiting, tags: ['Dock', 'Dawn', 'Pier'] }), photo('p1')])
    await open()
    const edit = within(rowOf('IMG_o1.jpg')).getByRole('button', { name: 'Edit caption and tags' })
    edit.focus()
    fireEvent.click(edit)
    await settle()
    return within(rowOf('IMG_o1.jpg')).getByRole('form')
  }

  // The viewer's editor: your own published photo o1, the grid's first tile.
  async function viewerEditor() {
    resetPhotosWorld([photo('o1', { ...own, tags: ['Dock', 'Dawn', 'Pier'] }), photo('p1')])
    await open()
    const tile = await screen.findByRole('button', { name: /^Photo 1 of \d+ in The Party$/ })
    tile.focus()
    fireEvent.click(tile)
    const dialog = await screen.findByRole('dialog')
    await settle()
    const words = dialog.querySelector('.vinfo') as HTMLElement
    const edit = within(words).getByRole('button', { name: 'Edit caption and tags' })
    edit.focus()
    fireEvent.click(edit)
    await settle()
    return within(words).getByRole('form')
  }

  const removeOf = (form: HTMLElement, tag: string) => within(form).getByRole('button', { name: `Remove tag ${tag}` })
  const chips = (form: HTMLElement) =>
    within(form)
      .queryAllByRole('button', { name: /^Remove tag / })
      .map((button) => button.getAttribute('aria-label'))

  async function pressRemove(form: HTMLElement, tag: string) {
    const remove = removeOf(form, tag)
    remove.focus()
    fireEvent.click(remove)
    await settle()
  }

  for (const [where, openEditor] of [
    ['a row', rowEditor],
    ['the viewer', viewerEditor],
  ] as const) {
    test(`§5 (Q3) ${where}'s editor: a chip's Remove puts focus on the Remove of the chip now in its place`, async () => {
      const form = await openEditor()
      await pressRemove(form, 'Dawn')
      expect(chips(form)).toEqual(['Remove tag Dock', 'Remove tag Pier'])
      expect(document.activeElement).toBe(removeOf(form, 'Pier'))
    })

    test(`§5 (Q3) ${where}'s editor: the last chip's Remove puts focus on the previous chip's, and the only chip's on Add a tag`, async () => {
      const form = await openEditor()
      await pressRemove(form, 'Pier')
      expect(document.activeElement).toBe(removeOf(form, 'Dawn'))
      await pressRemove(form, 'Dock')
      expect(document.activeElement).toBe(removeOf(form, 'Dawn'))
      await pressRemove(form, 'Dawn')
      expect(chips(form)).toEqual([])
      expect(document.activeElement).toBe(within(form).getByLabelText('Add a tag'))
    })

    test(`§5 (Q4) ${where}'s editor: Add tag puts focus on the cleared Add a tag field`, async () => {
      const form = await openEditor()
      const entry = within(form).getByLabelText('Add a tag') as HTMLInputElement
      fireEvent.change(entry, { target: { value: 'Porch' } })
      const add = within(form).getByRole('button', { name: 'Add tag' }) as HTMLButtonElement
      add.focus()
      fireEvent.click(add)
      // Chrome drops focus from the button the press disabled.
      if (document.activeElement === add) dropFocusToBody()
      await settle()
      expect(chips(form)).toEqual(['Remove tag Dock', 'Remove tag Dawn', 'Remove tag Pier', 'Remove tag Porch'])
      expect(add.disabled).toBe(true)
      expect(entry.value).toBe('')
      expect(document.activeElement).toBe(entry)
    })
  }

  test('§5 (Q4) Enter in the Add a tag field adds the tag and keeps focus there, as before', async () => {
    const form = await rowEditor()
    const entry = within(form).getByLabelText('Add a tag') as HTMLInputElement
    entry.focus()
    fireEvent.change(entry, { target: { value: 'Porch' } })
    fireEvent.keyDown(entry, { key: 'Enter' })
    await settle()
    expect(chips(form)).toContain('Remove tag Porch')
    expect(document.activeElement).toBe(entry)
  })
})
