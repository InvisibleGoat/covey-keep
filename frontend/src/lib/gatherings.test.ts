// CK-69 pins on the role flags every gated control on the gathering page
// reads. The value under test: `caller_role` is the one source of the role
// — the host is both flags, a co-host organises and is not the host, and
// anything else (null, a missing field, a value this build does not know,
// any near-miss spelling) gates CLOSED on both, in one place.
import { expect, test } from 'vitest'
import { roleFlags } from './gatherings'

test('roleFlags: the host is both flags, a co-host organises only, and anything else gates closed', () => {
  expect(roleFlags('host')).toEqual({ isHost: true, organises: true })
  expect(roleFlags('co_host')).toEqual({ isHost: false, organises: true })
  // An invitee, a keeper, a former host — and every value that is not one
  // of the two known roles, including the spellings a hand-written check
  // might have accepted.
  for (const other of [null, undefined, '', 'HOST', 'Host', 'cohost', 'co-host', 'admin', 'keeper', 0, 1, true, {}, []]) {
    expect(roleFlags(other)).toEqual({ isHost: false, organises: false })
  }
})
