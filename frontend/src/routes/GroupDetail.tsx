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
// id or an account id.
//
// EVERY ACT BUT MAKE CO-ADMIN TAKES A SECOND, DELIBERATE STEP, inline on its
// row (never a browser dialog), and one step is open at a time on the
// whole page; the do-nothing beside each confirm does nothing. A refusal
// lands on the row it names, from its code, with no re-read (a re-read
// could drop the row it explains). Leaving is its own card at the bottom,
// a section and never inside the rename form. Nobody is told about any of
// it: no notification exists (record §12).
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { FieldError, FormLevelErrors } from '../components/FieldError'
import { describedBy, noErrors, type FormErrors } from '../lib/formErrors'
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

// The acts that take a second step on a member's row.
type RowStepAct = 'remove_co_admin' | 'step_down' | 'make_admin' | 'remove_member'

type Step = { act: RowStepAct; membershipId: string } | { act: 'leave' }

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

export function GroupDetail() {
  const { id } = useParams()
  const groupId = id ?? ''
  const navigate = useNavigate()

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

  function openStep(next: Step) {
    setRowRefusal(null)
    setLeaveRefusal(null)
    setStep(next)
  }

  // Every act on a member's row: one in flight at a time; a success re-reads
  // the members — and the group when the caller's role or the count moves;
  // a refusal lands on the row, from its code, with nothing re-read.
  async function actOn(member: GroupMember, act: Exclude<GroupAct, 'leave'>) {
    if (acting !== null) return
    setActing(member.membership_id)
    setRowRefusal(null)
    setLeaveRefusal(null)
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
    setLeaveRefusal(null)
    setRowRefusal(null)
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

  const leaveStepOpen = step?.act === 'leave'

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
              step !== null && step.act !== 'leave' && step.membershipId === member.membership_id
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
