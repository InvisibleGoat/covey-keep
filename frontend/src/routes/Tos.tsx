import { Link } from 'react-router-dom'
import { PRODUCT_NAME } from '../brand'

// The private-alpha notice (CK-26) — the text the sign-in checkbox records
// agreement to, as ToS version 1. This is NOT the Terms of Service: the real
// terms and privacy policy are with counsel and publish later as version 2,
// and the alpha notice must never share a version number with them
// (decisions/2026-08-31-private-alpha-scope.md §3). Its only job is to be
// true — do not add reassurance the product cannot back.
export function Tos() {
  return (
    <main className="auth-screen">
      <h1>{PRODUCT_NAME} is a private test</h1>
      <p>
        You're here because Steven invited you personally. {PRODUCT_NAME} isn't a finished
        service yet — this is a small family test, so please don't rely on it for anything
        that matters.
      </p>
      <p>
        <strong>Nothing you put here will be kept.</strong> Everything lives on a
        development database and will be deleted when the test ends; none of it carries
        over to the real product. If you add something you'd like to keep, keep a copy
        somewhere else too.
      </p>
      <p>
        While you take part, {PRODUCT_NAME} stores your email address, the display name
        you choose, your timezone, and the gatherings you create or are invited to, along
        with routine sign-in records (like the time and network address a sign-in link was
        requested from). Photo upload doesn't exist yet, so no photos are stored.
      </p>
      <p>
        One thing worth knowing: during this test, sign-in links are printed to a server
        log, and Steven — who runs the server — can see them. That's temporary, and it's
        told to you here because you should hear it rather than find out.
      </p>
      <p>
        A real Terms of Service and privacy policy are being written and reviewed. When
        they're published, you'll be asked to read and accept them before continuing.
      </p>
      <p>
        Questions, or want to stop taking part? Tell Steven — he invited you, so you
        already know how to reach him. You can also delete your account at any time from
        the Settings page.
      </p>
      <Link to="/">Back to sign-in</Link>
    </main>
  )
}
