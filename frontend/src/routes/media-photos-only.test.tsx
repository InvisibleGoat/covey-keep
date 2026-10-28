// CK-80 pins on the Photos section in the photos-only view
// (decisions/2026-10-04-a-groups-gathering-stays-in-the-group.md §4, §11 item
// 4). The values under test: with `canUpload` false there is no upload form,
// the toggle reads "Show photos", and a failed row of one's own offers no
// retry that would open a picker that is not there; with the dates withheld
// (`occurrences` null) no photo carries a date label — nor the moment it was
// added; and with neither flag the section is exactly what it was.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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

function renderMedia(over: Partial<Parameters<typeof GatheringMedia>[0]> = {}) {
  return render(
    <GatheringMedia
      gatheringId="g-1"
      isHost={false}
      requiresApproval={false}
      occurrences={occurrences}
      zone={ZONE}
      pollIntervalMs={20}
      searchDebounceMs={20}
      {...over}
    />,
  )
}

beforeEach(() => {
  Object.assign(URL, { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('canUpload false: the toggle reads "Show photos", and once open there is no upload form, no file input and no Upload button', async () => {
  stubMedia([mediaRow()])
  const view = renderMedia({ canUpload: false, occurrences: null })
  expect(screen.queryByRole('button', { name: /show photos and add yours/i })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Show photos' }))
  await screen.findByRole('list', { name: 'Photos' })
  expect(screen.queryByLabelText('Add photos')).toBeNull()
  expect(view.container.querySelector('input[type="file"]')).toBeNull()
  expect(screen.queryByRole('button', { name: /^upload/i })).toBeNull()
  // The search is the viewer's still: it narrows what they may see.
  expect(screen.getByLabelText('Find a photo')).toBeTruthy()
})

test('canUpload false: a failed row of the caller’s own offers Dismiss and no retry — there is no picker to open', async () => {
  stubMedia([mediaRow({ status: 'failed', publication_state: 'pending', is_own: true, failure_reason: 'interrupted' })])
  renderMedia({ canUpload: false, occurrences: null })
  fireEvent.click(screen.getByRole('button', { name: 'Show photos' }))
  const list = await screen.findByRole('list', { name: 'Photos' })
  const row = within(list).getAllByRole('listitem')[0]
  expect(within(row).getByRole('button', { name: 'Dismiss' })).toBeTruthy()
  expect(within(row).queryByRole('button', { name: /try again|choose a smaller copy/i })).toBeNull()
})

test('the dates withheld: no photo carries a date label, and no row shows the moment it was added', async () => {
  stubMedia([mediaRow()])
  const view = renderMedia({ canUpload: false, occurrences: null })
  fireEvent.click(screen.getByRole('button', { name: 'Show photos' }))
  const list = await screen.findByRole('list', { name: 'Photos' })
  const row = within(list).getAllByRole('listitem')[0]
  expect(row.textContent).toContain('party.jpg — added by Ada')
  expect(row.textContent).not.toContain(' for ')
  expect(row.textContent).not.toContain(formatInstant(occurrences[0].starts_at, ZONE))
  expect(row.textContent).not.toContain(formatInstant(mediaRow().created_at, ZONE))
  expect(view.container.textContent).not.toMatch(/20\d\d|\b\d{1,2}:\d\d\b/)
})

test('with the dates sent and uploads allowed the section is what it was: the toggle, the form, the date label and the moment added', async () => {
  stubMedia([mediaRow()])
  renderMedia()
  fireEvent.click(screen.getByRole('button', { name: /show photos and add yours/i }))
  const list = await screen.findByRole('list', { name: 'Photos' })
  expect(screen.getByLabelText('Add photos')).toBeTruthy()
  const row = within(list).getAllByRole('listitem')[0]
  expect(row.textContent).toContain(
    `party.jpg — added by Ada for ${formatInstant(occurrences[0].starts_at, ZONE)}, ${formatInstant(mediaRow().created_at, ZONE)}`,
  )
})
