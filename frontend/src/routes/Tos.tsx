import { Link } from 'react-router-dom'
import { PRODUCT_NAME } from '../brand'

// The private test notice — the text the sign-in checkbox records agreement
// to, as ToS VERSION 2 (CK-73.3). Version 1 was CK-26's text; it went false
// the day the first photograph was stored (CK-36) and stood six weeks, and
// it lives word for word in decisions/2026-08-31-private-alpha-scope.md §3.1,
// where every version's text is kept. This is NOT the Terms of Service: the
// real terms and privacy policy are with counsel and publish later as
// VERSION 3, and the notice must never share a version number with them
// (the record's §3).
//
// THIS PAGE IS A LIVING DESCRIPTION OF WHAT THE PRODUCT STORES. Every phase
// that stores a new kind of data, or changes what deletion does, amends it
// as a NEW version — never a rewrite under the old number, because an
// acceptance is recorded at account creation against the number alone, and
// one number must mean one text. Its only job is to be true — do not add
// reassurance the product cannot back, and never pin a sentence about
// something not built yet: that pin is what kept version 1 false.
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
        <strong>Nothing you put here will be kept.</strong> Everything is stored on test
        systems and will be deleted when the test ends; none of it carries over to the real
        product. If you add something you'd like to keep, a photo especially, keep a copy
        somewhere else too.
      </p>
      <p>
        While you take part, {PRODUCT_NAME} stores your email address, the display name
        you choose and your timezone; the gatherings and groups you create or join, and
        your answers to invitations, including the names of anyone you say you're
        bringing; the email addresses of people you invite, which are cleared after the
        invitation runs out a week later; routine sign-in records (like the time and
        network address a sign-in link was requested from), and a passkey if you add one.
      </p>
      <p>
        Photos you add can be seen by the people in that gathering, with any caption, tags
        and file name. {PRODUCT_NAME} keeps three copies of each photo at different sizes
        and deletes the file you uploaded; location and other camera details are removed
        from the copies. You can delete your own photos at any time, and a photo sent to a
        bin is deleted for good 30 days later. Deleting your account removes your email
        address and name, but photos and answers you added stay in their gatherings under
        "a former member". Delete them first if you'd rather they went.
      </p>
      <p>
        {PRODUCT_NAME} may show paid plans during the test. They run in Stripe's test mode:
        no real payment is taken, and a real card won't work. Stripe holds what you enter
        on its page; {PRODUCT_NAME} keeps a record of which plan you're on, never your card.
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
