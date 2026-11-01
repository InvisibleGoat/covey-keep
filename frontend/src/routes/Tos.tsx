import { Link } from 'react-router-dom'
import { PRODUCT_NAME } from '../brand'
import { BrandMark } from '../components/AuthArt'

// The private test notice — the text the sign-in checkbox records agreement
// to, as ToS VERSION 3 (CK-83b): version 2 (CK-73.3) word for word, with one
// paragraph added after the photographs paragraph, on covers — chosen from a
// photo or uploaded — because an uploaded cover is a new kind of stored
// image. Version 1 was CK-26's text; it went false the day the first
// photograph was stored (CK-36) and stood six weeks. Every version's text
// lives word for word in decisions/2026-08-31-private-alpha-scope.md §3.1.
// This is NOT the Terms of Service: the real terms and privacy policy are
// with counsel and publish later as VERSION 4, and the notice must never
// share a version number with them (the record's §3).
//
// THIS PAGE IS A LIVING DESCRIPTION OF WHAT THE PRODUCT STORES. Every phase
// that stores a new kind of data, or changes what deletion does, amends it
// as a NEW version — never a rewrite under the old number, because an
// acceptance is recorded at account creation against the number alone, and
// one number must mean one text. Its only job is to be true — do not add
// reassurance the product cannot back, and never pin a sentence about
// something not built yet: that pin is what kept version 1 false.
//
// Two of version 2's sentences were corrected at CK-73.4 under the SAME
// number — the one case the rule allows: nothing had been pushed, so no
// account had accepted version 2 (the record's §3.1 banner says which two,
// and why each was wrong). A sentence that tells a person what they can do
// is checked against what the product lets them do.
//
// The look (CK-81) is the mockup's notice page, screen 19 — its STYLING
// only: the mark, the heading, the text on one card, the way back. The
// mockup's text is version 1 and stale (the design handoff §5.3); the
// words below are version 3 — version 2's, unchanged, and CK-83b's covers
// paragraph.
export function Tos() {
  return (
    <main className="auth-screen notice-screen">
      <div className="notice-page">
        <BrandMark />
        <h1>{PRODUCT_NAME} is a private test</h1>
        <div className="auth-card notice-card">
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
            "a former member". Delete your photos first if you'd rather they went. Answers
            can't be deleted, but you can change yours to "Can't make it" and remove anyone
            you said you were bringing.
          </p>
          <p>
            A group or gathering can also have a cover picture, chosen by the people who run
            it: a gathering's host or co-hosts, a group's admin or co-admins. A cover can be one
            of its photos. A gathering's cover is seen by the people in that gathering, and a
            group's cover by everyone in the group, including people who can't see the
            gathering the photo came from. A photo stops being a cover when it's sent to a bin
            or deleted. Instead, they can upload a cover picture: {PRODUCT_NAME} keeps two
            copies of it at different sizes and deletes the file uploaded, with location and
            other camera details removed. An uploaded cover isn't one of the photos. It stays
            until one of them changes or removes it, which deletes it — even if the person who
            uploaded it has deleted their account.
          </p>
          <p>
            {PRODUCT_NAME} may show paid plans during the test. They run in Stripe's test mode:
            no real payment is taken, and a real card won't work. Stripe holds what you enter
            on its page; {PRODUCT_NAME} keeps a record of which plan you're on, never your card.
          </p>
          <p>
            One thing worth knowing: during this test, sign-in links, invitations and
            email-change confirmations are printed to a server log, with the email address
            each one is for, and Steven — who runs the server — can see them. That's
            temporary, and it's told to you here because you should hear it rather than find
            out.
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
        </div>
        <Link to="/">Back to sign-in</Link>
      </div>
    </main>
  )
}
