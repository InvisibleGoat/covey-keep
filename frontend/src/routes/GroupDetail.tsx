// /groups/:id — a group's page (CK-78, Groups 3a): the name, the member
// count, the member list, renaming, the acts on members, and leaving.
// decisions/2026-10-23-joining-a-group-and-co-admins.md §5–§7; the
// classification is CK-75's, one line per check in the api-reference's
// Groups router, and this page maps it control by control (the CK-69 model).
//
// TWO READS, TOGETHER ON MOUNT (`GET /groups/{id}` and `GET
// /groups/{id}/members`), each cancelled on unmount. A 404 on EITHER — a
// missing id and a group the caller is not in, byte-identical on the
// server — renders the one not-found screen (the 404-not-403 posture is
// only as good as the screen that renders it); a failed read offers Try
// again. After an act each read re-runs on its own key: the members after
// every act, the group too where the caller's role or the count changes —
// optimistic-free, the server's bodies are what render.
//
// WHO THE CALLER IS COMES FROM THE BODY: `groupRoleFlags(caller_role)` →
// `isAdmin` (reserved: Make co-admin, Remove as co-admin, Make admin, and
// the hint saying so) and `organises` (the admin or a co-admin — delegable:
// renaming, Remove from group on an ordinary member's row, Step down on a
// co-admin's own row). Nothing here compares person ids; `admin_person_id`
// gates nothing. A group with no admin (the admin deleted their account
// with no co-admin to promote) gives nobody `isAdmin`, so the reserved acts
// render for nobody — the claim flow is unbuilt, and no copy promises it.
//
// NOTHING IDENTIFYING ON SCREEN: a member is a display name and its
// initials (aria-hidden, beside the name, never instead of it); the
// membership id is the handle in calls and is never rendered, put in an
// element id, a URL or storage. Never an email, a phone number, a person
// id or an account id. ONE EXCEPTION since CK-79: the pending emailed
// invitations show the addresses the group's organisers typed, to
// organisers alone (CK-25's precedent; the record's DATA-HANDLING) — never
// on the member list, the request queue or a member's page.
//
// EVERY ACT BUT MAKE CO-ADMIN TAKES A SECOND, DELIBERATE STEP, inline on its
// row (never a browser dialog), and one step is open at a time on the
// whole page; the do-nothing beside each confirm does nothing. A refusal
// lands on the row it names, from its code, with no re-read (a re-read
// could drop the row it explains). Leaving is its own card at the bottom,
// a section and never inside the rename form. Nobody is told about any of
// it: no notification exists (record §12).
//
// JOINING ON THE SURFACE (CK-79, Groups 3b; record §2, §3), between Members
// and the leave card:
// - REQUESTS TO JOIN, for organisers (`GET /groups/{id}/join-requests` once
//   the group body says the caller organises): each row the initials, the
//   display name and the day they asked — nothing else about the person,
//   ever. Approve takes a second step (Steven, 2026-10-27: approving shows
//   the group's members, and brings its upcoming gatherings, to someone the
//   approver may know only by name) and re-reads the requests, the members
//   and the group; Decline is one click and re-reads the requests. A
//   refusal lands on its row, from its code, with a way to refresh.
// - INVITE PEOPLE, for every member: the group's link (`GET
//   /groups/{id}/link` on mount — any member may read and share it).
//   **The link never leaves its call** (lib/groupJoining.ts): this page
//   holds `{ expiresAt, share }`, and Share the link hands the URL to the
//   device's share sheet or clipboard at once, inside the click — no URL is
//   ever rendered, kept as a value in state, logged or sent anywhere else.
//   Organisers make it in one click, and replace it or turn it off behind a
//   second step; a member with no link to share reads why. Organisers also
//   invite by email — CK-25's form on the group — and read *Waiting on*.
//   `device` is a prop for tests only (the CK-74 `follow` idiom); the app
//   passes nothing and gets the browser's own.
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { FieldError, FormLevelErrors } from '../components/FieldError'
import { effectiveZone, formatDay } from '../lib/datetime'
import { describedBy, noErrors, type FormErrors } from '../lib/formErrors'
import {
  approveRequest,
  approveSentence,
  askedLine,
  declineRequest,
  decisionRefusalMessage,
  INVITE_HINT,
  inviteByEmail,
  LINK_HINT,
  linkExpiryLine,
  linkRefusalMessage,
  makeLink,
  NO_LINK_MEMBER,
  NO_REQUESTS,
  pendingExpiryLine,
  readGroupInvitations,
  readJoinRequests,
  readLink,
  REPLACE_LINK_SENTENCE,
  REQUESTS_HINT,
  revokeGroupInvitation,
  revokeLink,
  shareOutcomeLine,
  TURN_OFF_LINK_SENTENCE,
  type JoinRequest,
  type PendingGroupInvitation,
  type ShareableLink,
  type ShareDevice,
  type ShareOutcome,
} from '../lib/groupJoining'
import {
  addCoAdmin,
  callerRoleLine,
  CO_ADMIN_HINT,
  groupRefusalMessage,
  groupRoleFlags,
  handOver,
  initials,
  leaveGroup,
  leaveSentence,
  LEAVE_COME_BACK,
  LEAVE_EXPLAINER,
  LEAVE_ONLY_MEMBER,
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
  type Group,
  type GroupAct,
  type GroupMember,
  type GroupOutcome,
  type GroupRead,
} from '../lib/groups'

type Load<T> = { status: 'loading' } | GroupRead<T>

// A section's own read (CK-79): it fails in its own card, with its own Try
// again, and never takes the page with it.
type SectionLoad<T> = { status: 'loading' } | { status: 'loaded'; value: T } | { status: 'failed' }

// The acts that take a second step on a member's row.
type RowStepAct = 'remove_co_admin' | 'step_down' | 'make_admin' | 'remove_member'

// One second step open on the whole page: a member's row, the leave card,
// a request's approval, or the link's replacement or turning off (CK-79).
type Step =
  | { act: RowStepAct; membershipId: string }
  | { act: 'leave' }
  | { act: 'approve'; requestId: string }
  | { act: 'replace_link' }
  | { act: 'turn_off_link' }

// What each second step says and offers. The sentence names what the
// person loses; the confirm acts; the keep button does nothing.
function stepCopy(act: RowStepAct, name: string) {
  switch (act) {
    case 'remove_co_admin':
      return {
        label: `Remove ${name} as co-admin`,
        sentence: removeCoAdminSentence(name),
        confirm: 'Remove as co-admin',
        busy: 'Removing…',
        keep: 'Keep as co-admin',
      }
    case 'step_down':
      return {
        label: 'Step down as co-admin',
        sentence: STEP_DOWN_SENTENCE,
        confirm: 'Step down',
        busy: 'Stepping down…',
        keep: 'Stay a co-admin',
      }
    case 'make_admin':
      return {
        label: `Make ${name} the admin`,
        sentence: makeAdminSentence(name),
        confirm: `Make ${name} the admin`,
        busy: 'Handing over…',
        keep: 'Keep the role',
      }
    case 'remove_member':
      return {
        label: `Remove ${name} from the group`,
        sentence: removeMemberSentence(name),
        confirm: 'Remove from group',
        busy: 'Removing…',
        keep: `Keep ${name}`,
      }
  }
}

// Which controls a member's row offers the caller — the classification,
// mapped (the kickoff's table, one cell per viewer and row):
//   the admin: on a co-admin's row Remove as co-admin, Make admin, Remove
//     from group; on a member's row Make co-admin, Make admin, Remove from
//     group; nothing on their own row (Leave is below);
//   a co-admin: Remove from group on a member's row, Step down on their own
//     row, nothing on the admin's or another co-admin's;
//   a member: nothing anywhere.
function rowControls(member: GroupMember, isAdmin: boolean, organises: boolean) {
  const own = member.is_self
  const rowCoAdmin = member.role === 'co_admin'
  const rowMember = member.role === 'member'
  const coAdminViewer = organises && !isAdmin
  return {
    makeCoAdmin: isAdmin && !own && rowMember,
    removeCoAdmin: isAdmin && !own && rowCoAdmin,
    makeAdmin: isAdmin && !own && (rowCoAdmin || rowMember),
    removeFromGroup: !own && ((isAdmin && (rowCoAdmin || rowMember)) || (coAdminViewer && rowMember)),
    stepDown: own && coAdminViewer && rowCoAdmin,
  }
}

export function GroupDetail({ device }: { device?: ShareDevice } = {}) {
  const { id } = useParams()
  const groupId = id ?? ''
  const navigate = useNavigate()
  // Days — when a request was made, when the link and an invitation stop
  // working — read in the profile zone (the CK-17 rule; Plan's precedent).
  const { person } = useAuth()
  const zone = effectiveZone(person?.timezone)

  const [groupLoad, setGroupLoad] = useState<Load<Group>>({ status: 'loading' })
  const [membersLoad, setMembersLoad] = useState<Load<GroupMember[]>>({ status: 'loading' })
  // Each read re-runs when its key moves; a loaded value stays on screen
  // until the new answer replaces it.
  const [groupKey, setGroupKey] = useState(0)
  const [membersKey, setMembersKey] = useState(0)

  // The rename draft: null follows the server's name; a string is what the
  // person has typed. Save waits for it to differ (the CK-18 no-op guard).
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const [renameErrors, setRenameErrors] = useState<FormErrors>(noErrors())
  const [renaming, setRenaming] = useState(false)

  // One second step open on the page at a time, one act in flight at a
  // time (the membership id it is on, or 'leave'), and a refusal on the row
  // — or in the leave card — that drew it.
  const [step, setStep] = useState<Step | null>(null)
  const [acting, setActing] = useState<string | null>(null)
  const [rowRefusal, setRowRefusal] = useState<{ membershipId: string; message: string } | null>(
    null,
  )
  const [leaveRefusal, setLeaveRefusal] = useState<string | null>(null)

  // Joining on the surface (CK-79): each section reads on its own key and
  // fails in its own card.
  const [requestsLoad, setRequestsLoad] = useState<SectionLoad<JoinRequest[]>>({ status: 'loading' })
  const [requestsKey, setRequestsKey] = useState(0)
  const [requestRefusal, setRequestRefusal] = useState<{ requestId: string; message: string } | null>(
    null,
  )
  // The live link as `{ expiresAt, share }` — the URL is inside `share`'s
  // closure and is never a value this page holds.
  const [linkLoad, setLinkLoad] = useState<SectionLoad<ShareableLink | null>>({ status: 'loading' })
  const [linkKey, setLinkKey] = useState(0)
  const [linkRefusal, setLinkRefusal] = useState<string | null>(null)
  const [shareOutcome, setShareOutcome] = useState<ShareOutcome | null>(null)
  const [invitationsLoad, setInvitationsLoad] = useState<SectionLoad<PendingGroupInvitation[]>>({
    status: 'loading',
  })
  const [invitationsKey, setInvitationsKey] = useState(0)
  const [inviteDestination, setInviteDestination] = useState('')
  const [inviteErrors, setInviteErrors] = useState<FormErrors>(noErrors())
  const [inviteSubmitting, setInviteSubmitting] = useState(false)

  // Cancel-on-unmount for the mutation handlers (the CK-18 convention).
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function load() {
      const result = await readGroup(groupId)
      if (!cancelled) setGroupLoad(result)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [groupId, groupKey])

  useEffect(() => {
    let cancelled = false
    async function load() {
      const result = await readMembers(groupId)
      if (!cancelled) setMembersLoad(result)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [groupId, membersKey])

  // The two organiser reads wait for the group body to say the caller
  // organises: for anyone else they are the group's 404, and never asked.
  const callerOrganises =
    groupLoad.status === 'loaded' && groupRoleFlags(groupLoad.value.caller_role).organises

  // The link: any member may read it, so it is read on mount.
  useEffect(() => {
    let cancelled = false
    async function load() {
      const outcome = await readLink(groupId, device)
      if (!cancelled) setLinkLoad(outcome.ok ? { status: 'loaded', value: outcome.link } : { status: 'failed' })
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [groupId, linkKey, device])

  useEffect(() => {
    if (!callerOrganises) return
    let cancelled = false
    async function load() {
      const outcome = await readJoinRequests(groupId)
      if (!cancelled) {
        setRequestsLoad(outcome.ok ? { status: 'loaded', value: outcome.value } : { status: 'failed' })
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [groupId, callerOrganises, requestsKey])

  useEffect(() => {
    if (!callerOrganises) return
    let cancelled = false
    async function load() {
      const outcome = await readGroupInvitations(groupId)
      if (!cancelled) {
        setInvitationsLoad(outcome.ok ? { status: 'loaded', value: outcome.value } : { status: 'failed' })
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [groupId, callerOrganises, invitationsKey])

  function tryAgain() {
    setGroupLoad({ status: 'loading' })
    setMembersLoad({ status: 'loading' })
    setGroupKey((key) => key + 1)
    setMembersKey((key) => key + 1)
  }

  if (groupLoad.status === 'notFound' || membersLoad.status === 'notFound') {
    // One screen, no speculation: it must not hint whether a group exists
    // behind this address, or that the caller was ever in it.
    return (
      <main className="auth-screen">
        <h1>Nothing here</h1>
        <p>There's no group to show at this address.</p>
        <Link to="/groups">Back to your groups</Link>
      </main>
    )
  }

  if (groupLoad.status === 'failed' || membersLoad.status === 'failed') {
    return (
      <main className="auth-screen">
        <h1>Something went wrong</h1>
        <p className="form-error" role="alert">
          Something went wrong loading this group.
        </p>
        <button type="button" onClick={tryAgain}>
          Try again
        </button>
        <Link to="/groups">Back to your groups</Link>
      </main>
    )
  }

  if (groupLoad.status === 'loading' || membersLoad.status === 'loading') {
    return (
      <main className="auth-screen">
        <p>Loading…</p>
      </main>
    )
  }

  const group = groupLoad.value
  const members = membersLoad.value
  const { isAdmin, organises } = groupRoleFlags(group.caller_role)
  const roleLine = callerRoleLine(group.caller_role)
  const nameValue = nameDraft ?? group.name
  const renameDirty = nameDraft !== null && nameDraft !== group.name

  async function rename(event: FormEvent) {
    event.preventDefault()
    setRenaming(true)
    setRenameErrors(noErrors())
    // As typed: a blanked field goes out as "" so the server's own refusal
    // renders inline — never null (`name` is not clearable).
    const outcome = await renameGroup(group.id, nameValue)
    if (!alive.current) return
    setRenaming(false)
    if (outcome.ok) {
      // The PATCH's body is the server's own; render it at once, and
      // re-read the group as every success does.
      setGroupLoad({ status: 'loaded', value: outcome.group })
      setNameDraft(null)
      setGroupKey((key) => key + 1)
      return
    }
    setRenameErrors(outcome.errors)
  }

  function clearRefusals() {
    setRowRefusal(null)
    setLeaveRefusal(null)
    setRequestRefusal(null)
    setLinkRefusal(null)
  }

  function openStep(next: Step) {
    clearRefusals()
    setStep(next)
  }

  // Every act on a member's row: one in flight at a time; a success re-reads
  // the members — and the group when the caller's role or the count moves;
  // a refusal lands on the row, from its code, with nothing re-read.
  async function actOn(member: GroupMember, act: Exclude<GroupAct, 'leave'>) {
    if (acting !== null) return
    setActing(member.membership_id)
    clearRefusals()
    let outcome: GroupOutcome
    switch (act) {
      case 'make_co_admin':
        outcome = await addCoAdmin(group.id, member.membership_id)
        break
      case 'remove_co_admin':
      case 'step_down':
        outcome = await removeCoAdmin(group.id, member.membership_id)
        break
      case 'make_admin':
        outcome = await handOver(group.id, member.membership_id)
        break
      case 'remove_member':
        outcome = await removeMember(group.id, member.membership_id)
        break
    }
    if (!alive.current) return
    setActing(null)
    setStep(null)
    if (outcome.ok) {
      // Stepping down and handing over change the caller's role; removal
      // changes the count. Making or removing a co-admin changes neither.
      if (act === 'step_down' || act === 'make_admin' || act === 'remove_member') {
        setGroupKey((key) => key + 1)
      }
      setMembersKey((key) => key + 1)
      return
    }
    setRowRefusal({
      membershipId: member.membership_id,
      message: groupRefusalMessage(outcome.code, member.display_name, act),
    })
  }

  async function leave() {
    if (acting !== null) return
    setActing('leave')
    clearRefusals()
    const outcome = await leaveGroup(group.id)
    if (!alive.current) return
    setActing(null)
    if (outcome.ok) {
      // The group is a 404 to the caller from here on; their list no
      // longer carries it.
      navigate('/groups')
      return
    }
    setStep(null)
    setLeaveRefusal(groupRefusalMessage(outcome.code, '', 'leave'))
  }

  // --- joining on the surface (CK-79) ---------------------------------------

  // Approve (behind its step) or decline (one click) a request to join. A
  // success re-reads the requests — and, for an approval, the members and
  // the group, whose count moved; a refusal lands on the row from its code.
  async function decide(request: JoinRequest, decision: 'approve' | 'decline') {
    if (acting !== null) return
    setActing(`request:${request.id}`)
    clearRefusals()
    const outcome =
      decision === 'approve'
        ? await approveRequest(group.id, request.id)
        : await declineRequest(group.id, request.id)
    if (!alive.current) return
    setActing(null)
    setStep(null)
    if (outcome.ok) {
      setRequestsKey((key) => key + 1)
      if (decision === 'approve') {
        setMembersKey((key) => key + 1)
        setGroupKey((key) => key + 1)
      }
      return
    }
    setRequestRefusal({
      requestId: request.id,
      message: decisionRefusalMessage(outcome.code, outcome.outcome),
    })
  }

  function refreshRequests() {
    setRequestRefusal(null)
    setRequestsKey((key) => key + 1)
  }

  // Make the link (one click) or replace it (behind its step): the 201's
  // body is the new link, rendered at once — the server's own.
  async function makeTheLink() {
    if (acting !== null) return
    setActing('link')
    clearRefusals()
    setShareOutcome(null)
    const outcome = await makeLink(group.id, device)
    if (!alive.current) return
    setActing(null)
    setStep(null)
    if (outcome.ok) {
      setLinkLoad({ status: 'loaded', value: outcome.link })
      return
    }
    setLinkRefusal(linkRefusalMessage(outcome.code))
  }

  // Turn the link off (behind its step), then re-read: no link from here.
  async function turnOffTheLink() {
    if (acting !== null) return
    setActing('link')
    clearRefusals()
    setShareOutcome(null)
    const outcome = await revokeLink(group.id)
    if (!alive.current) return
    setActing(null)
    setStep(null)
    if (outcome.ok) {
      setLinkKey((key) => key + 1)
      return
    }
    setLinkRefusal(linkRefusalMessage(outcome.code))
  }

  // Share the link: the device is called at once, inside the click, so the
  // share sheet and the clipboard still have the click's user activation.
  // The URL never passes through here — `share` holds it.
  function shareTheLink(link: ShareableLink) {
    setShareOutcome(null)
    void link.share(group.name).then((outcome) => {
      if (alive.current) setShareOutcome(outcome)
    })
  }

  async function sendInvitation(event: FormEvent) {
    event.preventDefault()
    setInviteSubmitting(true)
    setInviteErrors(noErrors())
    const outcome = await inviteByEmail(group.id, inviteDestination.trim())
    if (!alive.current) return
    setInviteSubmitting(false)
    if (outcome.ok) {
      setInviteDestination('')
      setInvitationsKey((key) => key + 1)
      return
    }
    setInviteErrors(outcome.errors)
  }

  // Revoke is one click (CK-25). A 404 means it stopped being pending —
  // accepted meanwhile, or revoked elsewhere — so the list is stale either
  // way; a network failure leaves the row, and pressing again recovers.
  async function revokeInvitation(invitationId: string) {
    if (acting !== null) return
    setActing(`invitation:${invitationId}`)
    const outcome = await revokeGroupInvitation(group.id, invitationId)
    if (!alive.current) return
    setActing(null)
    if (outcome.ok || outcome.code === 'not_found') setInvitationsKey((key) => key + 1)
  }

  const leaveStepOpen = step?.act === 'leave'
  const requests = requestsLoad.status === 'loaded' ? requestsLoad.value : null
  const link = linkLoad.status === 'loaded' ? linkLoad.value : null
  const pending = invitationsLoad.status === 'loaded' ? invitationsLoad.value : null
  const shareLine = shareOutcomeLine(shareOutcome)

  return (
    <main className="auth-screen">
      <h1>{group.name}</h1>
      <p>{memberCountLabel(group.member_count)}</p>
      {roleLine && <p>{roleLine}</p>}

      {organises && (
        <form
          className="auth-card"
          aria-labelledby="rename-heading"
          onSubmit={(event) => void rename(event)}
        >
          <h2 id="rename-heading">Rename the group</h2>
          <label htmlFor="group-name">Group name</label>
          <input
            id="group-name"
            type="text"
            maxLength={200}
            value={nameValue}
            aria-describedby={describedBy(renameErrors, 'name')}
            onChange={(event) => setNameDraft(event.target.value)}
          />
          <FieldError errors={renameErrors} field="name" />
          <button type="submit" disabled={!renameDirty || renaming}>
            {renaming ? 'Saving…' : 'Save'}
          </button>
          <FormLevelErrors errors={renameErrors} />
        </form>
      )}

      <section className="auth-card" aria-labelledby="members-heading">
        <h2 id="members-heading">Members</h2>
        {isAdmin && <p className="field-hint">{CO_ADMIN_HINT}</p>}
        <ul className="occurrence-list member-list" aria-label="Members">
          {members.map((member) => {
            const name = member.display_name
            const label = roleLabel(member.role)
            const controls = rowControls(member, isAdmin, organises)
            const openAct =
              step !== null && 'membershipId' in step && step.membershipId === member.membership_id
                ? step.act
                : null
            const copy = openAct ? stepCopy(openAct, name) : null
            const busy = acting === member.membership_id
            return (
              <li key={member.membership_id} className="member-row">
                <p>
                  <span className="member-initials" aria-hidden="true">
                    {initials(name)}
                  </span>{' '}
                  <span className="member-name">{name}</span>
                  {member.is_self && ' (you)'}
                  {label && (
                    <>
                      {' · '}
                      <span className="member-role">{label}</span>
                    </>
                  )}
                </p>
                {copy && openAct ? (
                  // The second, deliberate step: the first click only asked,
                  // and the do-nothing beside the confirm does nothing.
                  <div role="group" aria-label={copy.label}>
                    <p className="field-hint">{copy.sentence}</p>
                    <button
                      type="button"
                      disabled={acting !== null}
                      onClick={() => void actOn(member, openAct)}
                    >
                      {busy ? copy.busy : copy.confirm}
                    </button>{' '}
                    <button
                      type="button"
                      className="link-button"
                      disabled={acting !== null}
                      onClick={() => setStep(null)}
                    >
                      {copy.keep}
                    </button>
                  </div>
                ) : (
                  <div className="member-actions">
                    {controls.makeCoAdmin && (
                      <button
                        type="button"
                        className="link-button"
                        disabled={acting !== null}
                        onClick={() => {
                          setStep(null)
                          void actOn(member, 'make_co_admin')
                        }}
                      >
                        {busy ? 'Making co-admin…' : 'Make co-admin'}
                      </button>
                    )}
                    {controls.removeCoAdmin && (
                      <button
                        type="button"
                        className="link-button"
                        disabled={acting !== null}
                        onClick={() =>
                          openStep({ act: 'remove_co_admin', membershipId: member.membership_id })
                        }
                      >
                        Remove as co-admin
                      </button>
                    )}
                    {controls.makeAdmin && (
                      <button
                        type="button"
                        className="link-button"
                        disabled={acting !== null}
                        onClick={() =>
                          openStep({ act: 'make_admin', membershipId: member.membership_id })
                        }
                      >
                        Make admin
                      </button>
                    )}
                    {controls.removeFromGroup && (
                      <button
                        type="button"
                        className="link-button"
                        disabled={acting !== null}
                        onClick={() =>
                          openStep({ act: 'remove_member', membershipId: member.membership_id })
                        }
                      >
                        Remove from group
                      </button>
                    )}
                    {controls.stepDown && (
                      <button
                        type="button"
                        className="link-button"
                        disabled={acting !== null}
                        onClick={() =>
                          openStep({ act: 'step_down', membershipId: member.membership_id })
                        }
                      >
                        Step down
                      </button>
                    )}
                  </div>
                )}
                {rowRefusal?.membershipId === member.membership_id && (
                  <FormLevelErrors errors={{ fields: {}, form: [rowRefusal.message] }} />
                )}
              </li>
            )
          })}
        </ul>
      </section>

      {organises && (
        <section className="auth-card" aria-labelledby="requests-heading">
          <h2 id="requests-heading">Requests to join</h2>
          <p className="field-hint">{REQUESTS_HINT}</p>
          {requestsLoad.status === 'loading' && <p>Loading…</p>}
          {requestsLoad.status === 'failed' && (
            <>
              <p className="form-error" role="alert">
                <span aria-hidden="true">⚠ </span>
                The requests to join couldn't be loaded just now.
              </p>
              <button
                type="button"
                onClick={() => {
                  setRequestsLoad({ status: 'loading' })
                  setRequestsKey((key) => key + 1)
                }}
              >
                Try again
              </button>
            </>
          )}
          {requests !== null && requests.length === 0 && <p>{NO_REQUESTS}</p>}
          {requests !== null && requests.length > 0 && (
            <ul className="occurrence-list member-list" aria-label="Requests to join">
              {requests.map((request) => {
                const name = request.display_name
                const approveOpen = step?.act === 'approve' && step.requestId === request.id
                const busy = acting === `request:${request.id}`
                return (
                  <li key={request.id} className="member-row">
                    <p>
                      <span className="member-initials" aria-hidden="true">
                        {initials(name)}
                      </span>{' '}
                      <span className="member-name">{name}</span>
                      {' · '}
                      <span className="member-role">
                        {askedLine(formatDay(request.created_at, zone))}
                      </span>
                    </p>
                    {approveOpen ? (
                      // The second, deliberate step (Steven, 2026-10-27): the
                      // first click only asked, and Not yet does nothing.
                      <div role="group" aria-label={`Approve ${name}`}>
                        <p className="field-hint">{approveSentence(name, group.name)}</p>
                        <button
                          type="button"
                          disabled={acting !== null}
                          onClick={() => void decide(request, 'approve')}
                        >
                          {busy ? 'Approving…' : `Approve ${name}`}
                        </button>{' '}
                        <button
                          type="button"
                          className="link-button"
                          disabled={acting !== null}
                          onClick={() => setStep(null)}
                        >
                          Not yet
                        </button>
                      </div>
                    ) : (
                      <div className="member-actions">
                        <button
                          type="button"
                          className="link-button"
                          disabled={acting !== null}
                          onClick={() => openStep({ act: 'approve', requestId: request.id })}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="link-button"
                          disabled={acting !== null}
                          onClick={() => {
                            setStep(null)
                            void decide(request, 'decline')
                          }}
                        >
                          {busy ? 'Declining…' : 'Decline'}
                        </button>
                      </div>
                    )}
                    {requestRefusal?.requestId === request.id && (
                      <>
                        <FormLevelErrors errors={{ fields: {}, form: [requestRefusal.message] }} />
                        <button type="button" className="link-button" onClick={refreshRequests}>
                          Refresh the list
                        </button>
                      </>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      )}

      <section className="auth-card" aria-labelledby="invite-heading">
        <h2 id="invite-heading">Invite people</h2>
        {linkLoad.status === 'loading' && <p>Loading…</p>}
        {linkLoad.status === 'failed' && (
          <>
            <p className="form-error" role="alert">
              <span aria-hidden="true">⚠ </span>
              The group's link couldn't be loaded just now.
            </p>
            <button
              type="button"
              onClick={() => {
                setLinkLoad({ status: 'loading' })
                setLinkKey((key) => key + 1)
              }}
            >
              Try again
            </button>
          </>
        )}
        {linkLoad.status === 'loaded' && link === null && organises && (
          <>
            <p className="field-hint">{LINK_HINT}</p>
            <button type="button" disabled={acting !== null} onClick={() => void makeTheLink()}>
              {acting === 'link' ? 'Making…' : 'Make a link'}
            </button>
          </>
        )}
        {linkLoad.status === 'loaded' && link === null && !organises && <p>{NO_LINK_MEMBER}</p>}
        {link !== null && (
          <>
            <button type="button" disabled={acting === 'link'} onClick={() => shareTheLink(link)}>
              Share the link
            </button>
            <p>{linkExpiryLine(formatDay(link.expiresAt, zone))}</p>
            <p className="field-hint">{LINK_HINT}</p>
            {organises &&
              (step?.act === 'replace_link' ? (
                <div role="group" aria-label="Make a new link">
                  <p className="field-hint">{REPLACE_LINK_SENTENCE}</p>
                  <button type="button" disabled={acting !== null} onClick={() => void makeTheLink()}>
                    {acting === 'link' ? 'Making…' : 'Make a new link'}
                  </button>{' '}
                  <button
                    type="button"
                    className="link-button"
                    disabled={acting !== null}
                    onClick={() => setStep(null)}
                  >
                    Keep this link
                  </button>
                </div>
              ) : step?.act === 'turn_off_link' ? (
                <div role="group" aria-label="Turn off the link">
                  <p className="field-hint">{TURN_OFF_LINK_SENTENCE}</p>
                  <button
                    type="button"
                    disabled={acting !== null}
                    onClick={() => void turnOffTheLink()}
                  >
                    {acting === 'link' ? 'Turning off…' : 'Turn off the link'}
                  </button>{' '}
                  <button
                    type="button"
                    className="link-button"
                    disabled={acting !== null}
                    onClick={() => setStep(null)}
                  >
                    Keep the link
                  </button>
                </div>
              ) : (
                <div className="member-actions">
                  <button
                    type="button"
                    className="link-button"
                    disabled={acting !== null}
                    onClick={() => openStep({ act: 'replace_link' })}
                  >
                    Make a new link
                  </button>
                  <button
                    type="button"
                    className="link-button"
                    disabled={acting !== null}
                    onClick={() => openStep({ act: 'turn_off_link' })}
                  >
                    Turn off the link
                  </button>
                </div>
              ))}
          </>
        )}
        {/* What a press of Share the link came to — announced, and empty for
            a share sheet that took it or one the person closed. */}
        <p role="status" className="field-hint">
          {shareLine}
        </p>
        {linkRefusal && <FormLevelErrors errors={{ fields: {}, form: [linkRefusal] }} />}

        {organises && (
          <>
            <h3>Invite by email</h3>
            <form onSubmit={(event) => void sendInvitation(event)}>
              <label htmlFor="group-invite-destination">Email address</label>
              <input
                id="group-invite-destination"
                type="email"
                required
                value={inviteDestination}
                aria-describedby={describedBy(inviteErrors, 'destination')}
                onChange={(event) => setInviteDestination(event.target.value)}
              />
              <FieldError errors={inviteErrors} field="destination" />
              <FieldError errors={inviteErrors} field="channel" />
              <p className="field-hint">{INVITE_HINT}</p>
              <button
                type="submit"
                disabled={inviteDestination.trim() === '' || inviteSubmitting}
              >
                {inviteSubmitting ? 'Sending…' : 'Send invitation'}
              </button>
              <FormLevelErrors errors={inviteErrors} />
            </form>

            <h3>Waiting on</h3>
            {invitationsLoad.status === 'loading' && <p>Loading…</p>}
            {invitationsLoad.status === 'failed' && (
              <>
                <p className="form-error" role="alert">
                  <span aria-hidden="true">⚠ </span>
                  The invitation list couldn't be loaded just now.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setInvitationsLoad({ status: 'loading' })
                    setInvitationsKey((key) => key + 1)
                  }}
                >
                  Try again
                </button>
              </>
            )}
            {pending !== null && pending.length === 0 && (
              <p className="field-hint">No pending invitations.</p>
            )}
            {pending !== null && pending.length > 0 && (
              // The one place an email address shows on this page: the
              // addresses organisers typed, to organisers alone (CK-25).
              <ul className="occurrence-list" aria-label="Pending invitations">
                {pending.map((invitation) => (
                  <li key={invitation.id}>
                    {invitation.destination}
                    {' — '}
                    {pendingExpiryLine(
                      new Date(invitation.expires_at).getTime() <= Date.now(),
                      formatDay(invitation.expires_at, zone),
                    )}{' '}
                    <button
                      type="button"
                      className="link-button"
                      disabled={acting !== null}
                      onClick={() => void revokeInvitation(invitation.id)}
                    >
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      {/* Deliberately a section, not part of the rename form above: Enter in
          the name field must never reach leaving (the Destructive-sections
          convention). Not type-to-confirm — the group can undo a leave and
          the account is untouched — but a second, deliberate step. */}
      <section className="auth-card danger-zone" aria-labelledby="leave-heading">
        <h2 id="leave-heading">Leave this group</h2>
        <p className="danger-explainer">{LEAVE_EXPLAINER}</p>
        <p className="danger-explainer">
          {group.member_count === 1 ? LEAVE_ONLY_MEMBER : LEAVE_COME_BACK}
        </p>
        {leaveStepOpen ? (
          <div role="group" aria-label={`Leave ${group.name}`}>
            <p className="field-hint">{leaveSentence(group.name)}</p>
            <button
              type="button"
              className="danger-button"
              disabled={acting !== null}
              onClick={() => void leave()}
            >
              {acting === 'leave' ? 'Leaving…' : 'Leave'}
            </button>{' '}
            <button
              type="button"
              className="link-button"
              disabled={acting !== null}
              onClick={() => setStep(null)}
            >
              Stay
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="danger-button"
            disabled={acting !== null}
            onClick={() => openStep({ act: 'leave' })}
          >
            Leave this group
          </button>
        )}
        {leaveRefusal && <FormLevelErrors errors={{ fields: {}, form: [leaveRefusal] }} />}
      </section>

      <Link to="/groups">Back to your groups</Link>
    </main>
  )
}
