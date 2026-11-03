// CK-80 pins on the Photos section in the photos-only view
// (decisions/2026-10-04-a-groups-gathering-stays-in-the-group.md §4, §11 item
// 4). The values under test: with `canUpload` false there is no upload form,
// and a failed row of one's own offers no retry that would open a picker that
// is not there; with the dates withheld (`occurrences` null) no photo carries
// a date label — nor the moment it was added, on a row or (since CK-88) on the
// viewer's "Added by" line; and with neither flag the section is what it was.
// Since CK-88 the section is open from the start (no toggle), and a published
// photo is a tile in the grid, opened in the viewer — so the row pins are
// carried by a waiting photo of the caller's own, which stays a row.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { GatheringMedia } from '../components/GatheringMedia'
import { formatInstant } from '../lib/datetime'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

const ZONE = 'America/Chicago'

const occurrences = [
  {
    id: 'occ-1',
    gathering_id: 'g-1',
    starts_at: '2026-09-01T18:00:00+00:00',
    ends_at: null,
    location: null,
    map_url: null,
  },
]

function mediaRow(over: Record<string, unknown> = {}) {
  return {
    id: 'm-1',
    gathering_id: 'g-1',
    occurrence_id: 'occ-1',
    status: 'ready',
    publication_state: 'live',
    upload_content_type: 'image/jpeg',
    upload_size_bytes: 1000,
    uploaded_at: '2026-09-09T12:00:01+00:00',
    created_at: '2026-09-09T12:00:00+00:00',
    uploader_display_name: 'Ada',
    is_own: false,
    removed_at: null,
    filename: 'party.jpg',
    caption: null,
    tags: [],
    published_at: '2026-09-09T12:00:05+00:00',
    failure_reason: null,
    ...over,
  }
}

function stubMedia(rows: unknown[]) {
  const mock = vi.fn((url: string) => {
    if (String(url).includes('/url?layer=')) {
      return Promise.resolve(json(409, { detail: { code: 'not_ready', status: 'processing', message: '' } }))
    }
    return Promise.resolve(json(200, { media: rows }))
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

// CK-88: the section needs a router (the viewer's history entry).
function renderMedia(over: Partial<Parameters<typeof GatheringMedia>[0]> = {}) {
  return render(
    <MemoryRouter initialEntries={['/gatherings/g-1']}>
      <GatheringMedia
        gatheringId="g-1"
        isHost={false}
        requiresApproval={false}
        occurrences={occurrences}
        gatheringTitle="Grandpa’s 80th"
        zone={ZONE}
        pollIntervalMs={20}
        searchDebounceMs={20}
        {...over}
      />
    </MemoryRouter>,
  )
}

// A photograph of the caller's own that waits for the host: a row in every
// seat since CK-88 (only a published photo is a tile).
const waitingOwn = () =>
  mediaRow({ id: 'm-2', publication_state: 'pending', is_own: true, filename: 'mine.jpg', published_at: null })

beforeEach(() => {
  Object.assign(URL, { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('canUpload false: the section is open from the start, with no upload form, no file input and no Upload button', async () => {
  stubMedia([mediaRow()])
  const view = renderMedia({ canUpload: false, occurrences: null })
  // CK-88: no toggle of either form — the section reads its list on mount,
  // and the published photo is a tile.
  expect(screen.queryByRole('button', { name: /^show photos/i })).toBeNull()
  await screen.findByRole('button', { name: 'Photo 1 of 1 in Grandpa’s 80th' })
  expect(screen.queryByLabelText('Add photos')).toBeNull()
  expect(view.container.querySelector('input[type="file"]')).toBeNull()
  expect(screen.queryByRole('button', { name: /^upload/i })).toBeNull()
  // The search is the viewer's still: it narrows what they may see.
  expect(screen.getByLabelText('Find a photo')).toBeTruthy()
})

test('canUpload false: a failed row of the caller’s own offers Dismiss and no retry — there is no picker to open', async () => {
  stubMedia([mediaRow({ status: 'failed', publication_state: 'pending', is_own: true, failure_reason: 'interrupted' })])
  renderMedia({ canUpload: false, occurrences: null })
  // CK-88: no toggle to press; a failed row is still a row.
  const list = await screen.findByRole('list', { name: 'Photos' })
  const row = within(list).getAllByRole('listitem')[0]
  expect(within(row).getByRole('button', { name: 'Dismiss' })).toBeTruthy()
  expect(within(row).queryByRole('button', { name: /try again|choose a smaller copy/i })).toBeNull()
})

test('the dates withheld: no photo carries a date label, no row shows the moment it was added, and the viewer’s Added by line carries no date', async () => {
  // CK-88: the row pins ride a waiting photo of the caller's own (a published
  // one is a tile), and the viewer's line joins them.
  stubMedia([mediaRow(), waitingOwn()])
  const view = renderMedia({ canUpload: false, occurrences: null })
  const list = await screen.findByRole('list', { name: 'Photos' })
  const row = within(list).getAllByRole('listitem')[0]
  expect(row.textContent).toContain('mine.jpg — added by You')
  // The date label is " for {date}" after the uploader (the waiting row's
  // own line says "Waiting for the host", so the pin names the label's form).
  expect(row.textContent).not.toContain('added by You for ')
  expect(row.textContent).not.toContain(formatInstant(occurrences[0].starts_at, ZONE))
  expect(row.textContent).not.toContain(formatInstant(mediaRow().created_at, ZONE))
  expect(view.container.textContent).not.toMatch(/20\d\d|\b\d{1,2}:\d\d\b/)
  fireEvent.click(screen.getByRole('button', { name: 'Photo 1 of 1 in Grandpa’s 80th' }))
  const viewer = await screen.findByRole('dialog')
  expect(viewer.querySelector('.vline')?.textContent).toBe('Added by Ada')
  expect(viewer.textContent).not.toMatch(/20\d\d|\b\d{1,2}:\d\d\b/)
})

test('with the dates sent and uploads allowed the section is what it was: the form, the date label and the moment added — and the viewer’s Added by line carries the day', async () => {
  // CK-88: no toggle; the row pins ride a waiting photo of the caller's own,
  // and the viewer's line reads the day added in the profile's zone.
  stubMedia([mediaRow(), waitingOwn()])
  renderMedia()
  const list = await screen.findByRole('list', { name: 'Photos' })
  expect(screen.getByLabelText('Add photos')).toBeTruthy()
  const row = within(list).getAllByRole('listitem')[0]
  expect(row.textContent).toContain(
    `mine.jpg — added by You for ${formatInstant(occurrences[0].starts_at, ZONE)}, ${formatInstant(mediaRow().created_at, ZONE)}`,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Photo 1 of 1 in Grandpa’s 80th' }))
  const viewer = await screen.findByRole('dialog')
  expect(viewer.querySelector('.vline')?.textContent).toBe('Added by Ada · Sep 9, 2026')
})
