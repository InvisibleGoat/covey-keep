// CK-80 pins on lib/places.ts — each member's place on a group's gathering
// (decisions/2026-10-04-a-groups-gathering-stays-in-the-group.md §4, §9–§11).
// The values under test: the three words on screen are Steven's, as
// literals, in ONE table and the API's terms untouched; every call answers
// the server's STABLE CODE and never its wording; placesBody sends NEITHER
// list when everyone is invited — the whole-group create, so a later
// newcomer is invited too — and otherwise exactly the lists the server reads;
// listRefusals reads an item-level 422 back to its list and index; and the
// copy says what is true and never promises anyone is told.
import { afterEach, expect, test, vi } from 'vitest'
import { networkErrors } from './formErrors'
import {
  CO_HOST_ALWAYS_INVITED,
  createRefusalMessage,
  listRefusals,
  newcomerLine,
  noOtherMembersLine,
  noPlaceLine,
  PLACE_LABELS,
  PLACES,
  PLACES_HEADING,
  PLACES_HINT,
  placeRefusalMessage,
  placesBody,
  promptAction,
  promptLine,
  readPlaces,
  setPlace,
  type Place,
} from './places'

afterEach(() => {
  vi.unstubAllGlobals()
})

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

const SERVER_WORDING = 'SERVER WORDING XYZ — never carried'

function stubFetch(response: () => Response | Promise<Response>) {
  const mock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(response()))
  vi.stubGlobal('fetch', mock)
  return mock
}

test('the three words are Steven’s, as literals, in one table keyed by the API’s own terms, in the order a row offers them', () => {
  expect(PLACE_LABELS).toEqual({
    invited: 'Invited',
    shared_with: 'Sees the photos',
    left_out: 'Kept a surprise',
  })
  expect([...PLACES]).toEqual(['invited', 'shared_with', 'left_out'])
  // Never the words the record rejected.
  for (const label of Object.values(PLACE_LABELS)) {
    expect(label).not.toMatch(/excluded|left out|shared with|photos only/i)
  }
})

test('readPlaces: the list and invitees_chosen from a 200; each refusal its code; a network failure unreachable', async () => {
  const entry = { membership_id: 'mem-1', display_name: 'Bea', place: 'invited', co_host: false }
  const mock = stubFetch(() => json(200, { invitees_chosen: true, members: [entry] }))
  expect(await readPlaces('g-1')).toEqual({
    ok: true,
    value: { inviteesChosen: true, members: [entry] },
  })
  expect(String(mock.mock.calls[0][0])).toMatch(/\/gatherings\/g-1\/places$/)

  stubFetch(() => json(200, { invitees_chosen: false, members: [] }))
  expect(await readPlaces('g-1')).toEqual({ ok: true, value: { inviteesChosen: false, members: [] } })

  stubFetch(() => json(404, { detail: 'No such gathering.' }))
  expect(await readPlaces('g-1')).toEqual({ ok: false, code: 'not_found' })
  stubFetch(() => json(409, { detail: { code: 'not_in_a_group', message: SERVER_WORDING } }))
  expect(await readPlaces('g-1')).toEqual({ ok: false, code: 'not_in_a_group' })
  stubFetch(() => json(500, {}))
  expect(await readPlaces('g-1')).toEqual({ ok: false, code: 'failed' })
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))))
  expect(await readPlaces('g-1')).toEqual({ ok: false, code: 'unreachable' })
})

test('setPlace: one PUT with exactly {"place"}, the entry from a 200, and every refusal its stable code — never the wording', async () => {
  const entry = { membership_id: 'mem-1', display_name: 'Bea', place: 'shared_with', co_host: false }
  const mock = stubFetch(() => json(200, entry))
  expect(await setPlace('g-1', 'mem-1', 'shared_with')).toEqual({ ok: true, entry })
  expect(mock).toHaveBeenCalledTimes(1)
  const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toMatch(/\/gatherings\/g-1\/places\/mem-1$/)
  expect(init.method).toBe('PUT')
  expect(JSON.parse(String(init.body))).toEqual({ place: 'shared_with' })

  const cases: [() => Response, string][] = [
    [() => json(409, { detail: { code: 'is_co_host', message: SERVER_WORDING } }), 'is_co_host'],
    [() => json(409, { detail: { code: 'has_answered', message: SERVER_WORDING } }), 'has_answered'],
    [() => json(409, { detail: { code: 'not_in_a_group', message: SERVER_WORDING } }), 'not_in_a_group'],
    [
      () =>
        json(422, {
          detail: [{ loc: ['path', 'membership_id'], msg: SERVER_WORDING, type: 'value_error', code: 'is_host' }],
        }),
      'is_host',
    ],
    [() => json(404, { detail: 'No such member.' }), 'not_found'],
    [() => json(409, { detail: { message: SERVER_WORDING } }), 'failed'],
    [() => json(500, {}), 'failed'],
  ]
  for (const [respond, code] of cases) {
    stubFetch(respond)
    const outcome = await setPlace('g-1', 'mem-1', 'left_out')
    expect(outcome).toEqual({ ok: false, code })
    expect(JSON.stringify(outcome)).not.toContain(SERVER_WORDING)
  }
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))))
  expect(await setPlace('g-1', 'mem-1', 'invited')).toEqual({ ok: false, code: 'unreachable' })
})

function choices(entries: [string, Place][]): Map<string, Place> {
  return new Map(entries)
}

test('placesBody: everyone Invited sends NEITHER list — the whole-group create — and nobody else at all is the same', () => {
  expect(placesBody(choices([['m-b', 'invited'], ['m-c', 'invited'], ['m-d', 'invited']]))).toEqual({})
  // A group with nobody else in it: the whole-group create too.
  expect(placesBody(choices([]))).toEqual({})
})

test('placesBody: one member who sees the photos — `invited` without them, and no `left_out`', () => {
  expect(placesBody(choices([['m-b', 'invited'], ['m-c', 'shared_with'], ['m-d', 'invited']]))).toEqual({
    invited: ['m-b', 'm-d'],
  })
})

test('placesBody: one member kept a surprise — both lists, in joining order', () => {
  expect(placesBody(choices([['m-b', 'invited'], ['m-c', 'shared_with'], ['m-d', 'left_out']]))).toEqual({
    invited: ['m-b'],
    left_out: ['m-d'],
  })
  expect(placesBody(choices([['m-b', 'left_out'], ['m-c', 'invited'], ['m-d', 'left_out']]))).toEqual({
    invited: ['m-c'],
    left_out: ['m-b', 'm-d'],
  })
})

test('placesBody: nobody invited — `invited: []`, so the server shares it with everyone not kept a surprise', () => {
  expect(placesBody(choices([['m-b', 'shared_with'], ['m-c', 'shared_with']]))).toEqual({ invited: [] })
  expect(placesBody(choices([['m-b', 'shared_with'], ['m-c', 'left_out']]))).toEqual({
    invited: [],
    left_out: ['m-c'],
  })
})

test('listRefusals: an item-level 422 on either list read back to its list, index and code; anything else ignored', () => {
  expect(
    listRefusals({
      detail: [
        { loc: ['body', 'left_out', 1], msg: SERVER_WORDING, type: 'value_error', code: 'not_a_member' },
        { loc: ['body', 'title'], msg: 'Value error, title cannot be empty', type: 'value_error' },
        { loc: ['body', 'invited', 0], msg: SERVER_WORDING, type: 'value_error', code: 'duplicate' },
        { loc: ['body', 'invited', 2], msg: SERVER_WORDING, type: 'value_error' },
      ],
    }),
  ).toEqual([
    { list: 'left_out', index: 1, code: 'not_a_member' },
    { list: 'invited', index: 0, code: 'duplicate' },
    { list: 'invited', index: 2, code: 'failed' },
  ])
  expect(listRefusals({ detail: 'No such group.' })).toEqual([])
  expect(listRefusals(null)).toEqual([])
  expect(listRefusals({ detail: [{ loc: ['body', 'invited'], msg: 'x' }] })).toEqual([])
})

test('the copy, as literals', () => {
  expect(PLACES_HEADING).toBe("Who it's for")
  expect(PLACES_HINT).toBe(
    "Invited people get the dates and the plans, and can add photos. People who see the photos get the photos and nothing else. Someone kept a surprise won't know about this gathering until you let them see the photos.",
  )
  expect(newcomerLine(false, 'The Lees')).toBe("Anyone who joins The Lees before it's over is invited too.")
  expect(newcomerLine(true, 'The Lees')).toBe("Anyone who joins The Lees before it's over will see the photos.")
  expect(CO_HOST_ALWAYS_INVITED).toBe('A co-host is always invited.')
  expect(noPlaceLine('Dee Test')).toBe('Dee Test has no place on this gathering yet.')
  expect(noOtherMembersLine('The Lees')).toBe('No one else is in The Lees yet.')
  expect(promptLine('Dee Test')).toBe("Dee Test doesn't know about this gathering yet.")
  expect(promptAction('Dee Test')).toBe('Let Dee Test see the photos')
})

test('the refusal lines, from the code — never the wording, and none claiming anything changed', () => {
  expect(placeRefusalMessage('has_answered', 'Bea Test', 'The Lees')).toBe(
    'Bea Test has answered a date, so they stay invited.',
  )
  expect(placeRefusalMessage('is_co_host', 'Cal', 'The Lees')).toBe(
    'Cal is a co-host, so they stay invited. Remove them as a co-host first.',
  )
  expect(placeRefusalMessage('not_found', 'Cal', 'The Lees')).toBe(
    "Cal isn't in The Lees any more — refresh the list.",
  )
  expect(placeRefusalMessage('unreachable', 'Cal', 'The Lees')).toBe(networkErrors().form[0])
  for (const code of ['failed', 'is_host', 'not_in_a_group', 'something_new']) {
    expect(placeRefusalMessage(code, 'Cal', 'The Lees')).toBe('Something went wrong. Nothing changed — try again.')
  }
  expect(createRefusalMessage('not_a_member', 'Cal')).toBe(
    "Cal isn't in this group any more — go back to the group and start again.",
  )
  for (const code of ['is_host', 'duplicate', 'failed']) {
    expect(createRefusalMessage(code, 'Cal')).toBe('Something went wrong. Nothing was created — try again.')
  }
})

test('the ban: no copy promises a notification or says anyone is told, and none uses the banned words', () => {
  const copy = [
    PLACES_HEADING,
    PLACES_HINT,
    newcomerLine(false, 'G'),
    newcomerLine(true, 'G'),
    CO_HOST_ALWAYS_INVITED,
    noPlaceLine('N'),
    noOtherMembersLine('G'),
    promptLine('N'),
    promptAction('N'),
    ...Object.values(PLACE_LABELS),
    ...['has_answered', 'is_co_host', 'not_found', 'failed'].map((c) => placeRefusalMessage(c, 'N', 'G')),
    createRefusalMessage('not_a_member', 'N'),
  ].join(' ')
  expect(copy).not.toMatch(/\bsafe|secure|private|forever|backed up|\bevents?\b/i)
  expect(copy).not.toMatch(/notif|email|message|\btold\b|\btell\b|\balert/i)
})
