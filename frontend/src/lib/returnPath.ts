// The sign-in return (CK-79): a signed-out visitor who opens a gated page
// comes back to it after the magic-link round trip, instead of to Home.
// Before CK-79 `RequireAuth` answered every signed-out visit with
// `<Navigate to="/" replace />` and nothing remembered where the person had
// been going — a link to `/groups/<id>`, `/plan` or `/gatherings/<id>`
// opened signed out landed on Home after sign-in (the Backlog's *a
// signed-out deep link loses its destination*). The two landing screens of
// Groups 3b need the same return, so it is built once, here.
//
// WHAT PARKS: a path and its query — `location.pathname + location.search`
// — and NEVER a fragment. A fragment is where this app carries tokens (the
// sign-in link, the invitation links, the group's link); anything from `#`
// on is dropped before a path is parked, and a stored value carrying one is
// refused on the way out.
//
// WHAT IS HONOURED: a SAME-ORIGIN RELATIVE PATH and nothing else — exactly
// one leading `/` (never `//`, which a browser reads as another host), no
// backslash anywhere (a browser reads `/\evil.example` as `//evil.example`),
// no control character or space (a browser strips a tab or a newline out of
// a URL, so `/<tab>/evil.example` becomes `//evil.example`), no fragment,
// at most 2,000 characters, and one that resolves against an origin to that
// same origin. No open redirect: a value that fails any of these never
// reaches `navigate()`. Validated when parked AND when taken, because the
// stored value is only as good as whatever wrote it.
//
// FRESH MEANS PARKED WITHIN RETURN_PATH_TTL — 30 minutes: room for asking for
// a sign-in link (which lives 15) and opening it, and short enough that a
// path parked and abandoned never surfaces at next week's sign-in. A
// timestamp from the future (a clock moved back) reads as stale — the safe
// direction, which lands on Home.
//
// WHO PARKS AND WHEN is the callers' rule, not this module's: `RequireAuth`
// parks only when the page load has been signed out since its auth state
// first settled — never on a sign-out or on a 401 that ends a session, so
// the next person to sign in on a shared device never lands on the last
// one's page — and the two Groups 3b landings and CK-25's park their own
// address when they send a person to sign in. `signOut` clears whatever is
// parked; `AuthCallback` takes it.
//
// Storage unavailable (private mode) means nothing parks, and sign-in lands
// on Home as it did before CK-79.

export const RETURN_PATH_KEY = 'covey-keep:return-path'

// 30 minutes, in milliseconds.
export const RETURN_PATH_TTL = 30 * 60 * 1000

export const MAX_RETURN_PATH_LENGTH = 2000

// Any origin will do for the resolution check: a relative path resolves to
// the origin it is given, and anything that names a host of its own does not.
const PROBE_ORIGIN = 'https://return-path.invalid'

// True only for a same-origin relative path the router may navigate to —
// the rules above, every one. Never throws.
export function isValidReturnPath(path: unknown): path is string {
  if (typeof path !== 'string') return false
  if (path.length === 0 || path.length > MAX_RETURN_PATH_LENGTH) return false
  if (path[0] !== '/' || path[1] === '/') return false
  if (path.includes('\\') || path.includes('#')) return false
  for (const char of path) {
    const code = char.charCodeAt(0)
    if (code <= 0x20 || code === 0x7f) return false
  }
  try {
    return new URL(path, PROBE_ORIGIN).origin === PROBE_ORIGIN
  } catch {
    return false
  }
}

// Parks `path` — its fragment dropped first — with the time it was parked.
// A path that is not a valid return path parks nothing (and leaves whatever
// was parked alone).
export function parkReturnPath(path: string, now: number = Date.now()): void {
  const hash = path.indexOf('#')
  const withoutFragment = hash === -1 ? path : path.slice(0, hash)
  if (!isValidReturnPath(withoutFragment)) return
  try {
    localStorage.setItem(RETURN_PATH_KEY, JSON.stringify({ path: withoutFragment, parkedAt: now }))
  } catch {
    // Storage unavailable: nothing parks, and sign-in lands on Home.
  }
}

// Reads what is parked, clears it — whatever it held — and answers the path
// only when it is valid and fresh; otherwise null.
export function takeReturnPath(now: number = Date.now()): string | null {
  let raw: string | null
  try {
    raw = localStorage.getItem(RETURN_PATH_KEY)
  } catch {
    return null
  }
  clearReturnPath()
  if (raw === null) return null
  let parked: unknown
  try {
    parked = JSON.parse(raw)
  } catch {
    return null
  }
  if (parked === null || typeof parked !== 'object') return null
  const { path, parkedAt } = parked as { path?: unknown; parkedAt?: unknown }
  if (typeof parkedAt !== 'number' || !Number.isFinite(parkedAt)) return null
  const age = now - parkedAt
  if (age < 0 || age > RETURN_PATH_TTL) return null
  return isValidReturnPath(path) ? path : null
}

export function clearReturnPath(): void {
  try {
    localStorage.removeItem(RETURN_PATH_KEY)
  } catch {
    // Nothing stored to clear.
  }
}
