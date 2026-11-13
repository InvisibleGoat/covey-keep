// Inviting by email (CK-25's form and *Waiting on*, moved here at CK-93 so
// a standalone gathering's Invitations section and a group's gathering's
// card for inviting people outside the group render ONE form and ONE list —
// moved and shared, never copied). The state and the handlers stay the
// page's (`routes/GatheringDetail.tsx`: `sendInvitation`, `revokeInvitation`,
// the roster read), so the 429's line, the mapper's 422s and the re-reads
// are one copy too; these two render what they are handed.
//
// THE ADDRESSES: *Waiting on* is the one place an address shows — the
// addresses the organisers typed, to the organisers alone (CK-25's
// precedent), on either kind of gathering.
import type { FormEvent } from 'react'
import { formatInstant } from '../lib/datetime'
import { describedBy, type FormErrors } from '../lib/formErrors'
import type { PendingInvitation } from '../lib/invitations'
import { FieldError, FormLevelErrors } from './FieldError'

export function InviteForm({
  destination,
  onDestinationChange,
  errors,
  submitting,
  onSubmit,
}: {
  destination: string
  onDestinationChange: (value: string) => void
  errors: FormErrors
  submitting: boolean
  onSubmit: (event: FormEvent) => void
}) {
  return (
    <form onSubmit={onSubmit}>
      <label htmlFor="invite-destination">Email address</label>
      <input
        id="invite-destination"
        type="email"
        required
        value={destination}
        aria-describedby={describedBy(errors, 'destination')}
        onChange={(event) => onDestinationChange(event.target.value)}
      />
      <FieldError errors={errors} field="destination" />
      <FieldError errors={errors} field="channel" />
      <p className="field-hint">
        They'll get an email with a link to this gathering. Invitations expire after 7 days.
      </p>
      <button type="submit" disabled={destination.trim() === '' || submitting}>
        {submitting ? 'Sending…' : 'Send invitation'}
      </button>
      <FormLevelErrors errors={errors} />
    </form>
  )
}

export function WaitingOn({
  pending,
  zone,
  onRevoke,
}: {
  pending: PendingInvitation[]
  zone: string
  onRevoke: (pendingId: string) => void
}) {
  return (
    <>
      <h3>Waiting on</h3>
      {pending.length === 0 ? (
        <p className="field-hint">No pending invitations.</p>
      ) : (
        <ul className="occurrence-list address-list">
          {pending.map((entry) => (
            <li key={entry.id}>
              {entry.destination}
              {' — '}
              {new Date(entry.expires_at).getTime() <= Date.now()
                ? 'expired'
                : `expires ${formatInstant(entry.expires_at, zone)}`}{' '}
              <button type="button" className="link-button" onClick={() => onRevoke(entry.id)}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
