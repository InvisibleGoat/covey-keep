// THE STEP (CK-101): an emailed invitation opened by a signed-in account it
// was not sent to. The server compared the addresses, wrote nothing, and
// answered `other_address`; this asks the person which of two things they
// mean. One copy for both landings — the group's and the gathering's —
// whose words differ only in what the invitation was to.
//
// Steven's answers of 2026-11-20 (the kickoff's Q1–Q4, each as
// recommended): the step names the signed-in account's own name and address
// and never the address the invitation went to (Q1, which the landing never
// learns); both buttons are quiet pills, Accept as {name} first, so neither
// leads (Q2); the words are THE WORDS as approved, word for word (Q4). When
// the person has not loaded (an API failure leaves the session signed in
// with no profile) the fallback words stand in.
//
// The landing owns the state, the calls and focus: the step's <h1> takes
// focus when it appears, never either button, so a stray Enter presses
// nothing; a failed Accept puts focus back on Accept, which `acceptRef`
// names. Both buttons are disabled while the acceptance is out, as every
// press in the app is, and the house line — an alert beneath them — is the
// landing's `failed`, cleared by the next press.
import type { RefObject } from 'react'
import type { Person } from '../auth/context'
import { REVOKE_REFUSED } from '../lib/invitations'

export const INVITATION_STEP_HEADING = 'This invitation was sent to a different email address'
export const SIGN_OUT_AND_USE = 'Sign out and use the invited address'

export function InvitationStep({
  invitationTo,
  person,
  busy,
  failed,
  headingRef,
  acceptRef,
  onAccept,
  onSignOut,
}: {
  // What the invitation was to, as the second sentence reads it: `join
  // {group name}` on the group landing, `"{title}"` on the gathering's.
  invitationTo: string
  person: Person | null
  busy: boolean
  failed: boolean
  headingRef: RefObject<HTMLHeadingElement | null>
  acceptRef: RefObject<HTMLButtonElement | null>
  onAccept: () => void
  onSignOut: () => void
}) {
  const signedInAs = person
    ? `You're signed in as ${person.display_name} (${person.email}).`
    : "You're signed in on this device."
  const youCan = person
    ? `If that address is yours too, you can accept as ${person.display_name}.`
    : 'If that address is yours too, you can accept with this account.'
  return (
    <>
      <h1 ref={headingRef} tabIndex={-1}>
        {INVITATION_STEP_HEADING}
      </h1>
      <p>{`${signedInAs} The invitation to ${invitationTo} was sent to another address.`}</p>
      <p>{`${youCan} If it's someone else's, sign out so they can sign in with it.`}</p>
      <div className="invitation-step-actions">
        <button ref={acceptRef} type="button" disabled={busy} onClick={onAccept}>
          {person ? `Accept as ${person.display_name}` : 'Accept with this account'}
        </button>
        <button type="button" disabled={busy} onClick={onSignOut}>
          {SIGN_OUT_AND_USE}
        </button>
      </div>
      {failed && (
        <p className="form-error" role="alert">
          {REVOKE_REFUSED}
        </p>
      )}
    </>
  )
}
