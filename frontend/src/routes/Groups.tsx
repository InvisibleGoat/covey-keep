// /groups — your groups (CK-78, Groups 3a). ONE request (`GET /groups`),
// cancelled on unmount; each group links to its page with the member count
// and, for the caller alone, their role in it. In the server's order —
// newest first; pinning and last-active ordering are the theming phase's.
// The empty state is a real screen that promises nothing without a screen
// yet (no invitation, gathering or photo); a failed read can be retried,
// never "Try again." with nothing to press.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listGroups, memberCountLabel, roleLabel, type Group } from '../lib/groups'

type LoadStatus = 'loading' | 'loaded' | 'failed'

export function Groups() {
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [groups, setGroups] = useState<Group[]>([])
  // Bumped by Try again: the ordinary read over again, through the loading
  // state (the CK-74.1 idiom on /plan).
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const result = await listGroups()
      if (cancelled) return
      if (result.ok) {
        setGroups(result.groups)
        setStatus('loaded')
      } else {
        setStatus('failed')
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  function tryAgain() {
    setStatus('loading')
    setReloadKey((key) => key + 1)
  }

  if (status === 'loading') {
    return (
      <main className="auth-screen">
        <p>Loading your groups…</p>
      </main>
    )
  }

  if (status === 'failed') {
    return (
      <main className="auth-screen">
        <h1>Your groups</h1>
        <p className="form-error" role="alert">
          Something went wrong loading your groups.
        </p>
        <button type="button" onClick={tryAgain}>
          Try again
        </button>
        <Link to="/home">Back home</Link>
      </main>
    )
  }

  // The empty state is a real screen — what a person in no group sees.
  if (groups.length === 0) {
    return (
      <main className="auth-screen">
        <h1>No groups yet</h1>
        <p>Groups you start or join will be listed here.</p>
        <Link to="/groups/new">Start a group</Link>
        <Link to="/home">Back home</Link>
      </main>
    )
  }

  return (
    <main className="auth-screen">
      <h1>Your groups</h1>
      <ul className="gathering-list" aria-label="Your groups">
        {groups.map((group) => {
          const role = roleLabel(group.caller_role)
          return (
            <li key={group.id}>
              <Link className="gathering-item" to={`/groups/${group.id}`}>
                <strong>{group.name}</strong>
                <p>
                  {memberCountLabel(group.member_count)}
                  {role && ` · ${role}`}
                </p>
              </Link>
            </li>
          )
        })}
      </ul>
      <Link to="/groups/new">Start a group</Link>
      <Link to="/home">Back home</Link>
    </main>
  )
}
