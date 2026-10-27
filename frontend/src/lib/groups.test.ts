// CK-78 pins on lib/groups.ts — the types, calls and copy for your groups on
// the surface (decisions/2026-10-23-joining-a-group-and-co-admins.md §5–§7;
// the classification is CK-75's). The value under test: the role comes from
// `caller_role` through two flags and anything unknown gates closed; a
// member's initials never stand for anything but their name; every call
// answers the server's STABLE CODE — a 422's `detail[0].code`, the leave's
// 409 `detail.code`, a 404 as `not_found`, a network failure as
// `unreachable` — and never its wording; creating and renaming go through
// the one mapper, with no `group_type` ever sent; and every line of copy
// is pinned as the literal a person reads.
import { afterEach, expect, test, vi } from 'vitest'
import { networkErrors } from './formErrors'
import {
  addCoAdmin,
  callerRoleLine,
  CO_ADMIN_HINT,
  createGroup,
  groupRefusalMessage,
  groupRoleFlags,
  handOver,
  initials,
  leaveGroup,
  leaveSentence,
  LEAVE_COME_BACK,
  LEAVE_EXPLAINER,
  LEAVE_ONLY_MEMBER,
  listGroups,
  makeAdminSentence,
  memberCountLabel,
  readGroup,
  readMembers,
  removeCoAdmin,
  removeCoAdminSentence,
  removeMember,
  removeMemberSentence,
  renameGroup,
  roleLabel,
  STEP_DOWN_SENTENCE,
} from './groups'

afterEach(() => {
  vi.unstubAllGlobals()
})

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

const SERVER_WORDING = 'SERVER WORDING XYZ — never carried'

function refusal422(code: string): Response {
  return json(422, {
    detail: [{ loc: ['body', 'membership_id'], msg: SERVER_WORDING, type: 'value_error', code }],
  })
}

function stubOnce(response: Response | (() => Promise<Response>)) {
  const mock = vi.fn(() => (typeof response === 'function' ? response() : Promise.resolve(response)))
  vi.stubGlobal('fetch', mock)
  return mock
}

function onlyCall(mock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  expect(mock).toHaveBeenCalledTimes(1)
  const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit | undefined]
  return [String(url), init ?? {}]
}

const GROUP = {
  id: 'g-1',
  name: 'The Lees',
  group_type: 'HOUSEHOLD',
  admin_person_id: 'person-ada',
  member_count: 3,
  caller_role: 'admin',
  created_at: '2026-10-27T12:00:00+00:00',
  updated_at: null,
}

// ---------------------------------------------------------------------------
// The two flags.
// ---------------------------------------------------------------------------

test('groupRoleFlags: the admin holds both, a co-admin organises, a member holds neither', () => {
  expect(groupRoleFlags('admin')).toEqual({ isAdmin: true, organises: true })
  expect(groupRoleFlags('co_admin')).toEqual({ isAdmin: false, organises: true })
  expect(groupRoleFlags('member')).toEqual({ isAdmin: false, organises: false })
})

test('groupRoleFlags: null, missing and unknown roles all gate closed', () => {
  for (const role of [null, undefined, '', 'host', 'co_host', 'ADMIN', 'Admin', 'owner', 1, {}]) {
    expect(groupRoleFlags(role)).toEqual({ isAdmin: false, organises: false })
  }
})

// ---------------------------------------------------------------------------
// Initials and the small labels.
// ---------------------------------------------------------------------------

test('initials: the first letter of each of the first two words, uppercased', () => {
  expect(initials('Aunt May')).toBe('AM')
  expect(initials('aunt may')).toBe('AM')
  expect(initials('Mary Ann Lee')).toBe('MA')
})

test('initials: one word gives one letter; extra spaces are not words', () => {
  expect(initials('peter')).toBe('P')
  expect(initials('  Aunt   May  ')).toBe('AM')
  expect(initials('\tGrandpa\n')).toBe('G')
})

test('initials: a hyphenated name is one word', () => {
  expect(initials('Jean-Luc')).toBe('J')
  expect(initials('Mary-Kate Olsen')).toBe('MO')
})

test('initials: letters beyond ASCII count, and a word with no letter is passed over', () => {
  expect(initials('Émile Zola')).toBe('ÉZ')
  expect(initials('— Peter')).toBe('P')
  expect(initials('(Grandma) Rose')).toBe('GR')
})

test('initials: nothing usable gives "?"', () => {
  expect(initials('')).toBe('?')
  expect(initials('   ')).toBe('?')
  expect(initials('— …')).toBe('?')
  expect(initials(null)).toBe('?')
  expect(initials(undefined)).toBe('?')
})

test('the count, the role words and the caller line', () => {
  expect(memberCountLabel(1)).toBe('1 member')
  expect(memberCountLabel(0)).toBe('0 members')
  expect(memberCountLabel(3)).toBe('3 members')
  expect(roleLabel('admin')).toBe('Admin')
  expect(roleLabel('co_admin')).toBe('Co-admin')
  expect(roleLabel('member')).toBeNull()
  expect(roleLabel(null)).toBeNull()
  expect(callerRoleLine('admin')).toBe("You're the admin.")
  expect(callerRoleLine('co_admin')).toBe("You're a co-admin.")
  expect(callerRoleLine('member')).toBeNull()
  expect(callerRoleLine(undefined)).toBeNull()
})

// ---------------------------------------------------------------------------
// The reads.
// ---------------------------------------------------------------------------

test('listGroups: the list on a 200, a failure otherwise', async () => {
  stubOnce(json(200, { groups: [GROUP] }))
  expect(await listGroups()).toEqual({ ok: true, groups: [GROUP] })
  stubOnce(json(500, {}))
  expect(await listGroups()).toEqual({ ok: false })
  stubOnce(() => Promise.reject(new TypeError('network')))
  expect(await listGroups()).toEqual({ ok: false })
})

test('readGroup and readMembers: loaded, notFound for a 404 or a path 422, failed otherwise', async () => {
  let mock = stubOnce(json(200, GROUP))
  expect(await readGroup('g-1')).toEqual({ status: 'loaded', value: GROUP })
  expect(onlyCall(mock)[0]).toMatch(/\/groups\/g-1$/)

  const members = [{ membership_id: 'm-1', display_name: 'Ada', role: 'admin', is_self: true }]
  mock = stubOnce(json(200, { members }))
  expect(await readMembers('g-1')).toEqual({ status: 'loaded', value: members })
  expect(onlyCall(mock)[0]).toMatch(/\/groups\/g-1\/members$/)

  for (const reader of [readGroup, readMembers]) {
    stubOnce(json(404, { detail: 'No such group.' }))
    expect(await reader('g-1')).toEqual({ status: 'notFound' })
    stubOnce(json(422, { detail: [] }))
    expect(await reader('not-a-uuid')).toEqual({ status: 'notFound' })
    stubOnce(json(500, {}))
    expect(await reader('g-1')).toEqual({ status: 'failed' })
    stubOnce(() => Promise.reject(new TypeError('network')))
    expect(await reader('g-1')).toEqual({ status: 'failed' })
  }
})

// ---------------------------------------------------------------------------
// Create and rename — the one mapper.
// ---------------------------------------------------------------------------

test('createGroup: the body is exactly {"name"} — never group_type — and a 201 is the group', async () => {
  const mock = stubOnce(json(201, { ...GROUP, member_count: 1 }))
  const outcome = await createGroup('The Lees')
  expect(outcome).toEqual({ ok: true, group: { ...GROUP, member_count: 1 } })
  const [url, init] = onlyCall(mock)
  expect(url).toMatch(/\/groups$/)
  expect(init.method).toBe('POST')
  expect(JSON.parse(String(init.body))).toEqual({ name: 'The Lees' })
  expect(Object.keys(JSON.parse(String(init.body)))).toEqual(['name'])
})

test("createGroup: the server's 422 on name lands on the field; a network failure is the network line", async () => {
  stubOnce(json(422, { detail: [{ loc: ['body', 'name'], msg: 'Value error, name cannot be empty', type: 'value_error' }] }))
  const outcome = await createGroup('  ')
  expect(outcome.ok).toBe(false)
  if (outcome.ok) return
  expect(outcome.errors.fields).toEqual({ name: 'Name cannot be empty' })
  expect(outcome.errors.form).toEqual([])

  stubOnce(() => Promise.reject(new TypeError('network')))
  const offline = await createGroup('The Lees')
  expect(offline).toEqual({ ok: false, errors: networkErrors() })
})

test('renameGroup: a PATCH of {"name"} as typed — a blank goes out as "" — and a 200 is the group', async () => {
  const mock = stubOnce(json(200, { ...GROUP, name: 'The Lee Family' }))
  expect(await renameGroup('g-1', 'The Lee Family')).toEqual({
    ok: true,
    group: { ...GROUP, name: 'The Lee Family' },
  })
  const [url, init] = onlyCall(mock)
  expect(url).toMatch(/\/groups\/g-1$/)
  expect(init.method).toBe('PATCH')
  expect(JSON.parse(String(init.body))).toEqual({ name: 'The Lee Family' })

  const blank = stubOnce(
    json(422, { detail: [{ loc: ['body', 'name'], msg: 'Value error, name cannot be empty', type: 'value_error' }] }),
  )
  const refused = await renameGroup('g-1', '')
  expect(JSON.parse(String(onlyCall(blank)[1].body))).toEqual({ name: '' })
  expect(refused.ok).toBe(false)
  if (!refused.ok) expect(refused.errors.fields.name).toBe('Name cannot be empty')
})

test('renameGroup: a 404 is the no-longer-allowed line, never a validation message', async () => {
  stubOnce(json(404, { detail: 'No such group.' }))
  const outcome = await renameGroup('g-1', 'The Lees')
  expect(outcome).toEqual({
    ok: false,
    errors: { fields: {}, form: ["You can't make that change any more — refresh the page."] },
  })
})

// ---------------------------------------------------------------------------
// The acts: each status to its code, never the wording.
// ---------------------------------------------------------------------------

test('addCoAdmin: one POST of {"membership_id"}; 201 ok; each 422 code; 404; network; anything else', async () => {
  const mock = stubOnce(json(201, { membership_id: 'm-2', display_name: 'Bea', role: 'co_admin', is_self: false }))
  expect(await addCoAdmin('g-1', 'm-2')).toEqual({ ok: true })
  const [url, init] = onlyCall(mock)
  expect(url).toMatch(/\/groups\/g-1\/co-admins$/)
  expect(init.method).toBe('POST')
  expect(JSON.parse(String(init.body))).toEqual({ membership_id: 'm-2' })

  for (const code of ['not_a_member', 'is_admin', 'already_co_admin', 'account_deleted']) {
    stubOnce(refusal422(code))
    const outcome = await addCoAdmin('g-1', 'm-2')
    expect(outcome).toEqual({ ok: false, code })
    expect(JSON.stringify(outcome)).not.toContain(SERVER_WORDING)
  }
  stubOnce(json(404, { detail: 'No such group.' }))
  expect(await addCoAdmin('g-1', 'm-2')).toEqual({ ok: false, code: 'not_found' })
  stubOnce(() => Promise.reject(new TypeError('network')))
  expect(await addCoAdmin('g-1', 'm-2')).toEqual({ ok: false, code: 'unreachable' })
  stubOnce(json(500, {}))
  expect(await addCoAdmin('g-1', 'm-2')).toEqual({ ok: false, code: 'failed' })
  // A 422 with no code (FastAPI's own validation shape) is not a refusal the
  // copy knows.
  stubOnce(json(422, { detail: [{ loc: ['body', 'membership_id'], msg: 'bad uuid', type: 'uuid_parsing' }] }))
  expect(await addCoAdmin('g-1', 'm-2')).toEqual({ ok: false, code: 'failed' })
})

test('removeCoAdmin: one DELETE on the co-admin row; 204 ok; 404 not_found', async () => {
  const mock = stubOnce(new Response(null, { status: 204 }))
  expect(await removeCoAdmin('g-1', 'm-2')).toEqual({ ok: true })
  const [url, init] = onlyCall(mock)
  expect(url).toMatch(/\/groups\/g-1\/co-admins\/m-2$/)
  expect(init.method).toBe('DELETE')
  expect(init.body).toBeUndefined()
  stubOnce(json(404, { detail: 'No such member.' }))
  expect(await removeCoAdmin('g-1', 'm-2')).toEqual({ ok: false, code: 'not_found' })
  stubOnce(() => Promise.reject(new TypeError('network')))
  expect(await removeCoAdmin('g-1', 'm-2')).toEqual({ ok: false, code: 'unreachable' })
})

test('removeMember: one DELETE on the membership; 204 ok; the member 404 and the group 404 alike not_found', async () => {
  const mock = stubOnce(new Response(null, { status: 204 }))
  expect(await removeMember('g-1', 'm-3')).toEqual({ ok: true })
  const [url, init] = onlyCall(mock)
  expect(url).toMatch(/\/groups\/g-1\/members\/m-3$/)
  expect(init.method).toBe('DELETE')
  for (const detail of ['No such member.', 'No such group.']) {
    stubOnce(json(404, { detail }))
    expect(await removeMember('g-1', 'm-3')).toEqual({ ok: false, code: 'not_found' })
  }
})

test('handOver: one POST of {"membership_id"}; 200 ok; its three 422 codes; 404', async () => {
  const mock = stubOnce(json(200, { ...GROUP, admin_person_id: 'person-bea', caller_role: 'member' }))
  expect(await handOver('g-1', 'm-2')).toEqual({ ok: true })
  const [url, init] = onlyCall(mock)
  expect(url).toMatch(/\/groups\/g-1\/hand-over$/)
  expect(init.method).toBe('POST')
  expect(JSON.parse(String(init.body))).toEqual({ membership_id: 'm-2' })
  for (const code of ['not_a_member', 'is_admin', 'account_deleted']) {
    stubOnce(refusal422(code))
    expect(await handOver('g-1', 'm-2')).toEqual({ ok: false, code })
  }
  stubOnce(json(404, { detail: 'No such group.' }))
  expect(await handOver('g-1', 'm-2')).toEqual({ ok: false, code: 'not_found' })
})

test("leaveGroup: one POST with no body; 204 ok; the 409's detail.code; 404", async () => {
  const mock = stubOnce(new Response(null, { status: 204 }))
  expect(await leaveGroup('g-1')).toEqual({ ok: true })
  const [url, init] = onlyCall(mock)
  expect(url).toMatch(/\/groups\/g-1\/leave$/)
  expect(init.method).toBe('POST')
  expect(init.body).toBeUndefined()

  stubOnce(json(409, { detail: { code: 'hand_over_first', message: SERVER_WORDING } }))
  const refused = await leaveGroup('g-1')
  expect(refused).toEqual({ ok: false, code: 'hand_over_first' })
  expect(JSON.stringify(refused)).not.toContain(SERVER_WORDING)
  stubOnce(json(409, { detail: SERVER_WORDING }))
  expect(await leaveGroup('g-1')).toEqual({ ok: false, code: 'failed' })
  stubOnce(json(404, { detail: 'No such group.' }))
  expect(await leaveGroup('g-1')).toEqual({ ok: false, code: 'not_found' })
  stubOnce(() => Promise.reject(new TypeError('network')))
  expect(await leaveGroup('g-1')).toEqual({ ok: false, code: 'unreachable' })
})

// ---------------------------------------------------------------------------
// The copy, as literals.
// ---------------------------------------------------------------------------

test('groupRefusalMessage: one line per code, each saying what is true and the way on', () => {
  expect(groupRefusalMessage('not_a_member', 'Cal', 'make_co_admin')).toBe(
    "Cal isn't in this group any more — refresh the list.",
  )
  expect(groupRefusalMessage('is_admin', 'Cal', 'make_co_admin')).toBe('Cal is the admin.')
  expect(groupRefusalMessage('is_admin', 'Cal', 'make_admin')).toBe(
    "That's you — you're already the admin.",
  )
  expect(groupRefusalMessage('already_co_admin', 'Cal', 'make_co_admin')).toBe(
    'Cal is already a co-admin — refresh the list.',
  )
  expect(groupRefusalMessage('account_deleted', 'Cal', 'make_admin')).toBe(
    'Cal has deleted their account — refresh the list.',
  )
  expect(groupRefusalMessage('hand_over_first', '', 'leave')).toBe(
    "You're the admin, so someone else needs the role before you leave. Choose Make admin beside a member's name.",
  )
  expect(groupRefusalMessage('not_found', 'Cal', 'remove_member')).toBe(
    "You can't make that change any more — refresh the page.",
  )
  expect(groupRefusalMessage('unreachable', 'Cal', 'remove_member')).toBe(networkErrors().form[0])
  expect(groupRefusalMessage('failed', 'Cal', 'remove_member')).toBe(
    'Something went wrong. Nothing changed — try again.',
  )
  expect(groupRefusalMessage('a_code_nobody_sent', 'Cal')).toBe(
    'Something went wrong. Nothing changed — try again.',
  )
})

test('the hint, the four step sentences and the leave copy, as literals', () => {
  expect(CO_ADMIN_HINT).toBe(
    'A co-admin can rename the group, invite people, approve requests to join, and remove members. Only you choose co-admins, remove them, and make someone else the admin.',
  )
  expect(removeCoAdminSentence('Bea')).toBe(
    'Bea will no longer be able to rename the group, invite people, approve requests to join or remove members.',
  )
  expect(STEP_DOWN_SENTENCE).toBe(
    "You'll no longer be able to rename the group, invite people, approve requests to join or remove members. Only the admin can make you a co-admin again.",
  )
  expect(makeAdminSentence('Bea')).toBe(
    "Bea will be the admin at once, and you'll be a member. Only Bea can make you the admin again.",
  )
  expect(removeMemberSentence('Cal')).toBe(
    "Cal will no longer be a member of this group. Gatherings they're already part of don't change.",
  )
  expect(LEAVE_EXPLAINER).toBe(
    "You'll stop seeing this group and its members. Gatherings you're already part of don't change.",
  )
  expect(LEAVE_COME_BACK).toBe(
    'To come back, someone in the group will need to invite you or approve your request.',
  )
  expect(LEAVE_ONLY_MEMBER).toBe("You're the only member, so the group will be left with nobody in it.")
  expect(leaveSentence('The Lees')).toBe('Leave The Lees?')
})

test('no line says safe, secure, private, forever, backed up or events', () => {
  const lines = [
    CO_ADMIN_HINT,
    removeCoAdminSentence('Bea'),
    STEP_DOWN_SENTENCE,
    makeAdminSentence('Bea'),
    removeMemberSentence('Cal'),
    LEAVE_EXPLAINER,
    LEAVE_COME_BACK,
    LEAVE_ONLY_MEMBER,
    ...['not_a_member', 'is_admin', 'already_co_admin', 'account_deleted', 'hand_over_first', 'not_found', 'failed'].map(
      (code) => groupRefusalMessage(code, 'Cal'),
    ),
  ]
  for (const line of lines) {
    expect(line).not.toMatch(/\bsafe|secure|private|forever|backed up|\bevents?\b|claim/i)
  }
})
