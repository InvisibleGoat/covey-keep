import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { PRODUCT_NAME } from '../brand'
import { useAppUpdate } from '../components/useAppUpdate'

// The catch-all screen (CK-75.1): what renders at an address this bundle has
// no route for. It NEVER NAVIGATES, so the address — path, query and
// fragment — stays exactly as it arrived. Until CK-75.1 the catch-all was
// `<Navigate to="/" replace />`, which replaced the whole address with `/`:
// an emailed invitation to a route no bundle had yet (CK-75's group
// invitation) landed on Home with its fragment-carried token gone and
// nothing said, and a tab on a stale bundle sent a typed new route to the
// welcome screen the same way. The address is the point of this screen.
//
// Two cases, one screen. (1) The route exists in a newer bundle than the one
// this tab runs: on mount the screen asks the service worker for an update
// through the one owner (AppUpdateProvider), and when a newer version has
// taken control it offers Reload — a plain reload loads the same address,
// fragment intact, and the newer bundle then routes it. (2) The route does
// not exist in any bundle yet, or the address is mistyped: the screen says
// the page isn't available and offers the way home. It cannot tell the two
// apart and does not try.
//
// This screen never reads, stores, logs, sends or shows the address or
// anything in it (pinned by a source scan): a fragment may carry a token,
// and the one thing this screen owes it is to leave it where the browser
// put it. Not behind RequireAuth — signed in or out, the same screen.

export const PAGE_NOT_AVAILABLE_HEADING = "This page isn't available"
export const PAGE_NOT_AVAILABLE_BODY =
  "The link may be for something that isn't ready yet, or the address may be mistyped."
export const NEWER_VERSION_LINE = 'A newer version is ready, and it may have this page.'
export const GO_HOME_LABEL = `Go to ${PRODUCT_NAME}`

function reloadPage() {
  // The new worker already controls the page (autoUpdate), so picking up the
  // newer bundle is a plain reload of the same address.
  window.location.reload()
}

// `reload` is a prop for tests only (the CK-74 `follow` idiom — jsdom does
// not implement navigation); the app reloads with window.location.reload.
export function PageNotAvailable({ reload = reloadPage }: { reload?: () => void }) {
  const { updateReady, checkForUpdate } = useAppUpdate()

  // Once, on mount: the provider's check is stable, so this runs one time.
  useEffect(() => {
    checkForUpdate()
  }, [checkForUpdate])

  return (
    <main className="auth-screen">
      {updateReady && (
        <div className="newer-version" role="status">
          <p>{NEWER_VERSION_LINE}</p>
          <button type="button" onClick={() => reload()}>
            Reload
          </button>
        </div>
      )}
      <h1>{PAGE_NOT_AVAILABLE_HEADING}</h1>
      <p>{PAGE_NOT_AVAILABLE_BODY}</p>
      <Link to="/">{GO_HOME_LABEL}</Link>
    </main>
  )
}
