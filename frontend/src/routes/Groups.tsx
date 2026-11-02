// /groups — your groups (CK-78, Groups 3a; the mockup's layout since CK-85).
// ONE request (`GET /groups`), cancelled on unmount. In the server's order —
// newest first; pinning and last-active ordering are later phases of their
// own (decisions/2026-10-31-the-design-and-how-it-is-merged.md §4), so the
// mockup's lede about them is left out until it is true.
//
// The page (CK-85; the mockup's screen 01, `groupsPage()`): the mockup's page
// column (`.page-column`; `.list-screen` until CK-86), the page head —
// *Groups* and **New group** — then THE FEATURED CARD, the first group as the
// cover's `hero` variant (the web
// layer), and *More groups*, the rest as `tile`s (the thumbnail layer) in a
// grid. One group: the featured card and no More groups heading. Every card
// is one link to its group's page, and its meta line is the count in
// people (`memberCountLabel`) and, for the caller alone, their role in it.
// No pin, no *Pinned* and no *Active … ago*: none has a backend yet.
//
// The empty state is a real screen that promises nothing without a screen
// yet (no invitation, gathering or photo); a failed read can be retried,
// never "Try again." with nothing to press. Their words are today's.
import { useEffect, useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { CardLine, Cover } from '../components/Cover'
import { Icon } from '../components/Icons'
import type { LinePiece } from '../lib/gatherings'
import { listGroups, memberCountLabel, roleLabel, type Group } from '../lib/groups'

type LoadStatus = 'loading' | 'loaded' | 'failed'

// A card's meta line: *14 people*, then *· Admin* or *· Co-admin* when the
// caller holds one — the role kept whole (CK-87.2), as a card's date is
// (CK-87): on a narrow card the line may break before the role, never at
// *Co-admin*'s hyphen. The text is the pieces joined, unchanged.
function metaPieces(group: Group): LinePiece[] {
  const count = { text: memberCountLabel(group.member_count), keep: false }
  const role = roleLabel(group.caller_role)
  return role ? [count, { text: ' · ', keep: false }, { text: role, keep: true }] : [count]
}

export function Groups() {
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [groups, setGroups] = useState<Group[]>([])
  // Bumped by Try again: the ordinary read over again, through the loading
  // state (the CK-74.1 idiom on /plan).
  const [reloadKey, setReloadKey] = useState(0)
  const moreHeading = useId()

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
      <main className="auth-screen page-column">
        <p>Loading your groups…</p>
      </main>
    )
  }

  if (status === 'failed') {
    return (
      <main className="auth-screen page-column">
        <div className="page-head">
          <div>
            <h1>Groups</h1>
          </div>
        </div>
        <div className="list-state">
          <p className="form-error" role="alert">
            Something went wrong loading your groups.
          </p>
          <button type="button" onClick={tryAgain}>
            Try again
          </button>
        </div>
      </main>
    )
  }

  // The empty state is a real screen — what a person in no group sees.
  if (groups.length === 0) {
    return (
      <main className="auth-screen page-column">
        <div className="page-head">
          <div>
            <h1>No groups yet</h1>
            <p className="lede">Groups you start or join will be listed here.</p>
          </div>
          <Link className="btn btn-primary" to="/groups/new">
            Start a group
          </Link>
        </div>
      </main>
    )
  }

  const [featured, ...more] = groups

  return (
    <main className="auth-screen page-column">
      <div className="page-head">
        <div>
          <h1>Groups</h1>
        </div>
        <Link className="btn btn-primary" to="/groups/new">
          <Icon name="plus" />
          New group
        </Link>
      </div>

      <Cover subject="group" id={featured.id} cover={featured.cover} variant="hero">
        <h2>
          <Link className="cover-link" to={`/groups/${featured.id}`}>
            {featured.name}
          </Link>
        </h2>
        <p className="cover-hero-meta">
          <CardLine pieces={metaPieces(featured)} />
        </p>
        {/* A picture of a button: the card's link already names the page. */}
        <span className="btn btn-photo" aria-hidden="true">
          Open group
        </span>
      </Cover>

      {more.length > 0 && (
        <>
          <h2 className="list-section" id={moreHeading}>
            More groups
          </h2>
          <ul className="cover-tiles" aria-labelledby={moreHeading}>
            {more.map((group) => (
              <li key={group.id}>
                <Cover subject="group" id={group.id} cover={group.cover} variant="tile">
                  <h3>
                    <Link className="cover-link" to={`/groups/${group.id}`}>
                      {group.name}
                    </Link>
                  </h3>
                  <p className="cover-meta">
                    <CardLine pieces={metaPieces(group)} />
                  </p>
                </Cover>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  )
}
