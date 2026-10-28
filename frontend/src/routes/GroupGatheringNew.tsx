// /groups/:id/gatherings/new — a gathering in the group (CK-80, Groups 3c;
// decisions/2026-10-04-a-groups-gathering-stays-in-the-group.md §4). Making a
// gathering in a group starts from the group's page (Steven, 2026-10-27):
// New gathering there opens this form with that group's member list. The
// plain `/gatherings/new` stays standalone, with no group choice.
//
// THIS COMPONENT READS; GatheringNew IS THE FORM. Two reads together on mount
// — `GET /groups/{id}` for the name and `GET /groups/{id}/members` for Who
// it's for — each cancelled on unmount. A 404 on EITHER (a missing id and a
// group the caller is not in, byte-identical on the server) is CK-78's one
// not-found screen; a failed read offers Try again. Then GatheringNew renders
// with the group, and the form's fields, its body and its 422 mapping are
// that one component's — never a copy here.
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { readGroup, readMembers, type Group, type GroupMember, type GroupRead } from '../lib/groups'
import { GatheringNew } from './GatheringNew'

type Load<T> = { status: 'loading' } | GroupRead<T>

export function GroupGatheringNew() {
  const { id } = useParams()
  const groupId = id ?? ''
  const [groupLoad, setGroupLoad] = useState<Load<Group>>({ status: 'loading' })
  const [membersLoad, setMembersLoad] = useState<Load<GroupMember[]>>({ status: 'loading' })
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const [group, members] = await Promise.all([readGroup(groupId), readMembers(groupId)])
      if (cancelled) return
      setGroupLoad(group)
      setMembersLoad(members)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [groupId, reloadKey])

  if (groupLoad.status === 'notFound' || membersLoad.status === 'notFound') {
    // One screen, no speculation (CK-78's): it must not hint whether a group
    // exists behind this address, or that the caller was ever in it.
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
        <button
          type="button"
          onClick={() => {
            setGroupLoad({ status: 'loading' })
            setMembersLoad({ status: 'loading' })
            setReloadKey((key) => key + 1)
          }}
        >
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

  return <GatheringNew inGroup={{ group: groupLoad.value, members: membersLoad.value }} />
}
