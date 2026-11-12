// Inviting people outside the group (CK-93): the one read of the three body
// fields, failing closed; the calls answering codes, never wording; the
// turn-off sentence in every form; every line as a literal.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ALERT_FAILED,
  CHANGE_FAILED,
  GOT_IT,
  KEEP_IT_ON,
  NOT_ALLOWED,
  NOT_NOW,
  PREVIEW_FAILED,
  REFRESH,
  TRY_AGAIN,
  TURNING_IT_OFF,
  TURNING_IT_ON,
  TURN_IT_OFF,
  TURN_IT_ON,
  alertSentence,
  dismissOutsideAlert,
  fromOutsideLabel,
  groupLine,
  openerOf,
  outsideFlags,
  readOutsideInvitations,
  setOutsideInvitations,
  switchLabel,
  turnOffNeedsStep,
  turnOffSentence,
  turnOnSentence,
  turnedOffMeanwhile,
  type OutsidePreview,
} from './outsideInvitations'

afterEach(() => {
  vi.unstubAllGlobals()
})

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

const ON = { on: true, since: '2026-11-10T12:00:00+00:00', by: 'Ada Test', may_change: true }

describe('outsideFlags — the one read of the three fields, failing closed', () => {
  it('reads each flag only from exactly true (or, for outsider, exactly false)', () => {
    expect(outsideFlags({ outside_invitations: ON, caller_in_group: true, outside_alert: true })).toEqual({
      mayChange: true,
      on: true,
      inGroup: true,
      outsider: false,
      alert: true,
    })
    expect(
      outsideFlags({
        outside_invitations: { on: false, since: null, by: null, may_change: false },
        caller_in_group: false,
        outside_alert: false,
      }),
    ).toEqual({ mayChange: false, on: false, inGroup: false, outsider: true, alert: false })
  })

  it('an absent field renders nothing new — and caller_in_group absent is not an outsider', () => {
    expect(outsideFlags({})).toEqual({
      mayChange: false,
      on: false,
      inGroup: false,
      outsider: false,
      alert: false,
    })
  })

  it('a null — the standalone gathering — renders nothing new', () => {
    expect(
      outsideFlags({ outside_invitations: null, caller_in_group: null, outside_alert: null }),
    ).toEqual({ mayChange: false, on: false, inGroup: false, outsider: false, alert: false })
  })

  it('a value this build does not know renders nothing new', () => {
    expect(
      outsideFlags({
        outside_invitations: { on: 'yes', may_change: 1 },
        caller_in_group: 'true',
        outside_alert: 'true',
      }),
    ).toEqual({ mayChange: false, on: false, inGroup: false, outsider: false, alert: false })
    expect(outsideFlags({ outside_invitations: 'on', caller_in_group: 0 })).toEqual({
      mayChange: false,
      on: false,
      inGroup: false,
      outsider: false,
      alert: false,
    })
  })

  it('openerOf reads by as a name or null', () => {
    expect(openerOf({ outside_invitations: ON })).toBe('Ada Test')
    expect(openerOf({ outside_invitations: { ...ON, by: null } })).toBeNull()
    expect(openerOf({ outside_invitations: null })).toBeNull()
    expect(openerOf({})).toBeNull()
  })
})

describe('turnOffSentence — every form, as literals', () => {
  const preview = (names: (string | null)[], pending: number): OutsidePreview => ({
    on: true,
    outsiders: names.map((display_name) => ({ display_name })),
    pending,
  })

  it('one outsider', () => {
    expect(turnOffSentence(preview(['Joe Smith'], 0))).toBe('Joe Smith will no longer see this gathering.')
  })

  it('two outsiders: and 1 other, never 1 others', () => {
    expect(turnOffSentence(preview(['Joe Smith', 'Ann Lee'], 0))).toBe(
      'Joe Smith and 1 other will no longer see this gathering.',
    )
  })

  it('more: and N others, the first in the preview’s order', () => {
    expect(turnOffSentence(preview(['Joe Smith', 'Ann Lee', 'Bo Park'], 0))).toBe(
      'Joe Smith and 2 others will no longer see this gathering.',
    )
  })

  it('the approved example: outsiders and pending', () => {
    expect(turnOffSentence(preview(['Joe Smith', 'Ann Lee', 'Bo Park'], 1))).toBe(
      'Joe Smith and 2 others will no longer see this gathering. Invitations not yet accepted will stop working.',
    )
    expect(turnOffSentence(preview(['Joe Smith'], 4))).toBe(
      'Joe Smith will no longer see this gathering. Invitations not yet accepted will stop working.',
    )
  })

  it('no outsider and pending above 0: the pending sentence alone', () => {
    expect(turnOffSentence(preview([], 2))).toBe('Invitations not yet accepted will stop working.')
  })

  it('a null name reads Someone', () => {
    expect(turnOffSentence(preview([null, 'Ann Lee'], 0))).toBe(
      'Someone and 1 other will no longer see this gathering.',
    )
  })

  it('the step is needed only when it would name someone or stop an invitation', () => {
    expect(turnOffNeedsStep(preview([], 0))).toBe(false)
    expect(turnOffNeedsStep(preview(['Joe Smith'], 0))).toBe(true)
    expect(turnOffNeedsStep(preview([], 1))).toBe(true)
  })
})

describe('the calls answer codes, never wording', () => {
  it('setOutsideInvitations sends exactly {"on": …} and answers the body on 200', async () => {
    const body = { id: 'g-1', title: 'The Party' }
    const mock = vi.fn(() => Promise.resolve(json(200, body)))
    vi.stubGlobal('fetch', mock)
    const outcome = await setOutsideInvitations('g-1', true)
    expect(outcome).toEqual({ ok: true, gathering: body })
    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/gatherings\/g-1\/outside-invitations$/)
    expect(init.method).toBe('PUT')
    expect(init.body).toBe('{"on":true}')
    await setOutsideInvitations('g-1', false)
    expect((mock.mock.calls[1] as unknown as [string, RequestInit])[1].body).toBe('{"on":false}')
  })

  it('a 404 is not_found, a network failure unreachable, anything else failed', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(404, { detail: 'Not found' }))))
    expect(await setOutsideInvitations('g-1', true)).toEqual({ ok: false, code: 'not_found' })
    expect(await readOutsideInvitations('g-1')).toEqual({ ok: false, code: 'not_found' })
    expect(await dismissOutsideAlert('g-1')).toEqual({ ok: false, code: 'not_found' })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(409, { detail: { code: 'not_in_a_group' } }))))
    expect(await setOutsideInvitations('g-1', true)).toEqual({ ok: false, code: 'failed' })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(500, {}))))
    expect(await readOutsideInvitations('g-1')).toEqual({ ok: false, code: 'failed' })
    expect(await dismissOutsideAlert('g-1')).toEqual({ ok: false, code: 'failed' })
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))))
    expect(await setOutsideInvitations('g-1', true)).toEqual({ ok: false, code: 'unreachable' })
    expect(await readOutsideInvitations('g-1')).toEqual({ ok: false, code: 'unreachable' })
    expect(await dismissOutsideAlert('g-1')).toEqual({ ok: false, code: 'unreachable' })
  })

  it('readOutsideInvitations reads the preview, a GET', async () => {
    const mock = vi.fn(() =>
      Promise.resolve(
        json(200, {
          on: true,
          since: '2026-11-10T12:00:00+00:00',
          by: 'Ada Test',
          outsiders: [{ display_name: 'Joe Smith' }, { display_name: null }],
          pending: 2,
        }),
      ),
    )
    vi.stubGlobal('fetch', mock)
    expect(await readOutsideInvitations('g-1')).toEqual({
      ok: true,
      preview: { on: true, outsiders: [{ display_name: 'Joe Smith' }, { display_name: null }], pending: 2 },
    })
    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit | undefined]
    expect(url).toMatch(/\/gatherings\/g-1\/outside-invitations$/)
    expect(init?.method ?? 'GET').toBe('GET')
  })

  it('a preview that says off, or is not exactly on, reads as off', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(200, { on: false, since: null, by: null, outsiders: [], pending: 0 }))),
    )
    expect(await readOutsideInvitations('g-1')).toEqual({
      ok: true,
      preview: { on: false, outsiders: [], pending: 0 },
    })
  })

  it('dismissOutsideAlert posts once with no body and answers ok on 204', async () => {
    const mock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })))
    vi.stubGlobal('fetch', mock)
    expect(await dismissOutsideAlert('g-1')).toEqual({ ok: true })
    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/gatherings\/g-1\/outside-alert\/dismiss$/)
    expect(init.method).toBe('POST')
    expect(init.body).toBeUndefined()
  })
})

describe('every line, as a literal', () => {
  it('the approved words (Steven, 2026-11-10)', () => {
    expect(switchLabel('The Lees')).toBe('Invite people outside The Lees')
    expect(turnOnSentence('The Lees')).toBe(
      "People you invite from outside The Lees will see everything in this gathering, including what's already there. Everyone in it will be told.",
    )
    expect(TURN_IT_ON).toBe('Turn it on')
    expect(NOT_NOW).toBe('Not now')
    expect(groupLine('The Lees', false)).toBe(
      "Only people in The Lees can see this gathering for now. If people outside The Lees are invited, they'll see everything in it, including what's already there.",
    )
    expect(groupLine('The Lees', true)).toBe(
      'People outside The Lees can see this gathering and everything in it.',
    )
    expect(alertSentence('Ada Test', 'The Party', 'The Lees')).toBe(
      "Ada Test opened The Party to people outside The Lees. They can see everything in it, including what's already there. If you added something that should stay with The Lees, you can remove it.",
    )
    expect(GOT_IT).toBe('Got it')
    expect(TURN_IT_OFF).toBe('Turn it off')
    expect(KEEP_IT_ON).toBe('Keep it on')
  })

  it('the kickoff’s words', () => {
    expect(alertSentence(null, 'The Party', 'The Lees')).toBe(
      "The Party was opened to people outside The Lees. They can see everything in it, including what's already there. If you added something that should stay with The Lees, you can remove it.",
    )
    expect(fromOutsideLabel('Joe Smith', 'The Lees')).toBe('Joe Smith · From outside The Lees')
    expect(TURNING_IT_ON).toBe('Turning it on…')
    expect(TURNING_IT_OFF).toBe('Turning it off…')
    expect(PREVIEW_FAILED).toBe("Who would lose access couldn't be checked just now.")
    expect(TRY_AGAIN).toBe('Try again')
    expect(NOT_ALLOWED).toBe("You can't change this setting any more.")
    expect(REFRESH).toBe('Refresh')
    expect(CHANGE_FAILED).toBe('Something went wrong. Nothing was changed — try again.')
    expect(ALERT_FAILED).toBe('Something went wrong. Try again.')
    expect(turnedOffMeanwhile('The Lees')).toBe(
      'Inviting people outside The Lees was turned off. Nothing was sent.',
    )
  })

  it('no line says private or secure (the record §6)', () => {
    const lines = [
      groupLine('The Lees', false),
      groupLine('The Lees', true),
      switchLabel('The Lees'),
      turnOnSentence('The Lees'),
      alertSentence('Ada Test', 'The Party', 'The Lees'),
      alertSentence(null, 'The Party', 'The Lees'),
    ]
    for (const line of lines) expect(line).not.toMatch(/private|secure/i)
  })
})
