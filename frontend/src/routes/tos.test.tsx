// CK-26 private-alpha notice pins, revised at CK-73.3 for version 2. The value
// under test: /tos carries the load-bearing statements the alpha's condition 4
// requires — private test, data not kept, what is stored (photos among it:
// the three copies and the deleted original, location removed, the bin's 30
// days, what deletion leaves behind, invitees' addresses cleared after a week,
// plans in Stripe's test mode), every email the app sends — sign-in links,
// invitations, email-change confirmations — visible in a server log with the
// address it is for, what a person can remove before deleting an account
// (photos; an answer can only be changed) — both CK-73.4's corrections — real
// terms coming — and NEVER a sentence that went false (version 1's "Photo
// upload doesn't exist yet"; version 2's first "Delete them first"); the
// sign-in checkbox agrees to the test rather
// than to Terms that do not exist yet — with its mechanism intact (unchecked
// by default, submit disabled until checked) — and TOS_VERSION is 3: this
// text's number since CK-83b, version 1 being the CK-26 text, version 2
// CK-73.3's, and the published terms taking 4
// (decisions/2026-08-31-private-alpha-scope.md §3, §3.1). Version 3 is
// version 2 word for word with ONE paragraph added after the photographs
// paragraph — covers, chosen from a photo or uploaded — pinned below as the
// whole card, paragraph by paragraph, so a word moved anywhere fails.
//
// THE LESSON THIS FILE CARRIES: from CK-26 to CK-73.3 it pinned "Photo upload
// doesn't exist yet" — a sentence about something not built yet — and that
// pin kept a false statement alive for six weeks after CK-36 stored the first
// photograph, because no phase that began storing data looked here. Pin what
// the product DOES, and the negation of what it no longer says; never pin a
// claim about what is not built.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, test, vi } from 'vitest'
import { AuthContext, type AuthState } from '../auth/context'
import { PRODUCT_NAME } from '../brand'
import { TOS_VERSION } from '../lib/api'
import { RSVP_RESPONSES } from '../lib/rsvps'
import { SignIn } from './SignIn'
import { Tos } from './Tos'
import tosSource from './Tos.tsx?raw'

const signedOut: AuthState = {
  status: 'signedOut',
  person: null,
  signIn: () => {},
  signOut: async () => {},
  updatePerson: () => {},
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderNotice() {
  return render(
    <MemoryRouter>
      <Tos />
    </MemoryRouter>,
  )
}

test('the notice says what it is and carries every load-bearing statement', () => {
  renderNotice()
  // The heading says what the page actually is — never "Terms of Service".
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
    `${PRODUCT_NAME} is a private test`,
  )
  // Private test, by invitation, not a service.
  expect(screen.getByText(/invited you personally/i)).toBeTruthy()
  // The data will not be kept — on test systems, not "a development database":
  // photos live in a storage bucket and a plan at Stripe, so the broader word.
  expect(screen.getByText(/Nothing you put here will be kept/i)).toBeTruthy()
  expect(screen.getByText(/stored on test systems/i)).toBeTruthy()
  expect(screen.getByText(/will be deleted when the test ends/i)).toBeTruthy()
  // What is collected, in version 2's words: identity, gatherings and groups,
  // RSVP answers with companion names, invitees' addresses (and when they are
  // cleared — the pending row lives out its week, acceptance clears nothing),
  // sign-in records, a passkey.
  expect(
    screen.getByText(/stores your email address, the display name you choose and your timezone/i),
  ).toBeTruthy()
  expect(screen.getByText(/gatherings and groups you create or join/i)).toBeTruthy()
  expect(screen.getByText(/names of anyone you say you're bringing/i)).toBeTruthy()
  expect(
    screen.getByText(
      /email addresses of people you invite, which are cleared after the invitation runs out a week later/i,
    ),
  ).toBeTruthy()
  expect(screen.getByText(/a passkey if you add one/i)).toBeTruthy()
  // The console-mode disclosure, in version 2's corrected words. THE PIN MOVED
  // at CK-73.4, with its reason: as first built, version 2 said sign-in links
  // alone, and services/email.py's one console line prints EVERY email the app
  // sends with the address it is for — the sign-in link (api/auth.py), an
  // invitation (api/invitations.py: a third party's address, supplied by the
  // inviter), and both email-change messages (api/profile.py). The old regex,
  // /sign-in links are printed to a server log/, no longer matches because the
  // list of what is printed grew — which is the correction.
  expect(
    screen.getByText(
      /sign-in links, invitations and email-change confirmations are printed to a server log/i,
    ),
  ).toBeTruthy()
  expect(screen.getByText(/with the email address each one is for/i)).toBeTruthy()
  // Real terms and a privacy policy are coming, and they will need accepting.
  expect(screen.getByText(/asked to read and accept them/i)).toBeTruthy()
})

test('the notice tells the truth about photographs, deletion and plans', () => {
  renderNotice()
  // Photos: three copies, the uploaded file deleted (processing.py's three
  // layers; the worker deletes the original after the ready commit).
  expect(
    screen.getByText(
      /keeps three copies of each photo at different sizes and deletes the file you uploaded/i,
    ),
  ).toBeTruthy()
  // Location removed (every byte of metadata is dropped from the copies).
  expect(screen.getByText(/location and other camera details are removed/i)).toBeTruthy()
  // Your own photos are yours to delete; the bin's clock is the sweep's
  // REMOVED_BIN, 30 days, and the sweep is on (check (gt), 2026-10-19).
  expect(screen.getByText(/delete your own photos at any time/i)).toBeTruthy()
  expect(
    screen.getByText(/a photo sent to a bin is deleted for good 30 days later/i),
  ).toBeTruthy()
  // Deletion is anonymization: the email and name go, the contributions stay
  // under ANONYMIZED_DISPLAY_NAME (api/profile.py) — the omission that
  // mattered most for consent, and the sentence a person must read before
  // they agree.
  expect(
    screen.getByText(/removes your email address and name, but photos and answers you added stay/i),
  ).toBeTruthy()
  expect(screen.getByText(/under [“"]a former member[”"]/i)).toBeTruthy()
  // What a person can remove before deleting their account, said truthfully
  // (CK-73.4; version 2 as first built said "Delete them first", them being
  // photos AND answers): photos, yes — Send to bin and Delete permanently
  // (CK-64), Dismiss for a failed one (CK-71); answers, never — api/rsvps.py
  // has no delete route, deliberately (CK-27), so an answer can only be
  // changed to the `no` answer, which also clears its companions (a "no"
  // sends an empty list — CK-29's clearing path). Either quote style, as the
  // pin above.
  expect(screen.getByText(/Delete your photos first if you'd rather they went/i)).toBeTruthy()
  expect(
    screen.getByText(
      /Answers can't be deleted, but you can change yours to [“"]Can't make it[”"]/i,
    ),
  ).toBeTruthy()
  // And the label the sentence quotes IS the product's: the `no` answer as
  // lib/rsvps.ts spells it, so relabelling the button fails here instead of
  // leaving the notice naming a choice nobody can find. A sentence that tells
  // a person what they can do is checked against what the product lets them
  // do — this phase's lesson, made a test.
  const noLabel = RSVP_RESPONSES.find((r) => r.value === 'no')?.label
  expect(noLabel).toBeTruthy()
  expect(document.body.textContent ?? '').toContain(noLabel as string)
  // Plans: Stripe's test mode, no real payment, never your card (the key is
  // boot-checked to rk_test_; the subscriptions row holds a plan and nothing
  // about a card).
  expect(
    screen.getByText(/Stripe's test mode: no real payment is taken, and a real card won't work/i),
  ).toBeTruthy()
  expect(screen.getByText(/keeps a record of which plan you're on, never your card/i)).toBeTruthy()
})

test("the sentences that went false never render — version 1's photo claim, and version 2's first 'Delete them'", () => {
  // The NEGATION of the CK-26 pin. "Photo upload doesn't exist yet, so no
  // photos are stored" was true on 2026-09-02 and false from CK-36 on; the
  // old pin asserted it present, and nothing failed when it stopped being
  // true. Read the whole rendered page, not one element, so the sentence is
  // caught however it is split.
  renderNotice()
  const page = document.body.textContent ?? ''
  expect(page).not.toMatch(/Photo upload doesn't exist/i)
  expect(page).not.toMatch(/no photos are stored/i)
  // And version 2's own half-truth, corrected at CK-73.4 before any account
  // accepted it: "Delete them first if you'd rather they went" told a person
  // they could delete their answers, which the product has never let anyone
  // do (CK-27 shipped no RSVP delete, deliberately).
  expect(page).not.toMatch(/Delete them first/i)
})

test('the notice renders the product name from the brand module, never a literal', () => {
  // The brand.test.tsx discipline: the source may contain no spelling of the
  // name at all, so the rendered heading can only come from brand.ts.
  expect(tosSource.toLowerCase()).not.toContain('covey')
})

test('the sign-in checkbox agrees to the private test; the mechanism is unchanged', async () => {
  // Answer the /health probe locally so the effect settles inside the test.
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ status: 'ok' }), { status: 200 })),
    ),
  )
  render(
    <MemoryRouter>
      <AuthContext.Provider value={signedOut}>
        <SignIn />
      </AuthContext.Provider>
    </MemoryRouter>,
  )

  // Affirmative and unchecked by default, submit disabled until checked —
  // contract-formation hygiene that the copy change must not weaken.
  const checkbox = screen.getByRole('checkbox') as HTMLInputElement
  expect(checkbox.checked).toBe(false)
  const submit = screen.getByRole('button', {
    name: /email me a sign-in link/i,
  }) as HTMLButtonElement
  expect(submit.disabled).toBe(true)

  // The label links to the notice and no longer names a Terms of Service
  // that does not exist.
  const noticeLink = screen.getByRole('link', { name: /private test notice/i })
  expect(noticeLink.getAttribute('href')).toBe('/tos')
  expect(screen.queryByText(/terms of service/i)).toBeNull()

  fireEvent.click(checkbox)
  expect(checkbox.checked).toBe(true)
  expect(submit.disabled).toBe(false)
  await screen.findByText('API: ok')
})

// Version 2, paragraph by paragraph, as it renders — §3.1's text, the
// product's name from the brand module. Every one of its sentences stands in
// version 3, unchanged and in order.
const VERSION_2 = [
  `You're here because Steven invited you personally. ${PRODUCT_NAME} isn't a finished service yet — this is a small family test, so please don't rely on it for anything that matters.`,
  "Nothing you put here will be kept. Everything is stored on test systems and will be deleted when the test ends; none of it carries over to the real product. If you add something you'd like to keep, a photo especially, keep a copy somewhere else too.",
  `While you take part, ${PRODUCT_NAME} stores your email address, the display name you choose and your timezone; the gatherings and groups you create or join, and your answers to invitations, including the names of anyone you say you're bringing; the email addresses of people you invite, which are cleared after the invitation runs out a week later; routine sign-in records (like the time and network address a sign-in link was requested from), and a passkey if you add one.`,
  `Photos you add can be seen by the people in that gathering, with any caption, tags and file name. ${PRODUCT_NAME} keeps three copies of each photo at different sizes and deletes the file you uploaded; location and other camera details are removed from the copies. You can delete your own photos at any time, and a photo sent to a bin is deleted for good 30 days later. Deleting your account removes your email address and name, but photos and answers you added stay in their gatherings under "a former member". Delete your photos first if you'd rather they went. Answers can't be deleted, but you can change yours to "Can't make it" and remove anyone you said you were bringing.`,
  `${PRODUCT_NAME} may show paid plans during the test. They run in Stripe's test mode: no real payment is taken, and a real card won't work. Stripe holds what you enter on its page; ${PRODUCT_NAME} keeps a record of which plan you're on, never your card.`,
  "One thing worth knowing: during this test, sign-in links, invitations and email-change confirmations are printed to a server log, with the email address each one is for, and Steven — who runs the server — can see them. That's temporary, and it's told to you here because you should hear it rather than find out.",
  "A real Terms of Service and privacy policy are being written and reviewed. When they're published, you'll be asked to read and accept them before continuing.",
  "Questions, or want to stop taking part? Tell Steven — he invited you, so you already know how to reach him. You can also delete your account at any time from the Settings page.",
]

// Version 3's one new paragraph (approved by Steven 2026-11-01), word for
// word, after the photographs paragraph. Each sentence was checked against
// the product (the /tos Gotcha's rule (4)): the organisers — a gathering's
// host or co-hosts, a group's admin or co-admins — set and clear a cover
// (api/covers.py); a group's cover reaches every member, a gathering's its
// readers; removal and destruction clear a photograph cover
// (services/covers.py::clear_covers_of); an uploaded cover is two layers,
// web and thumbnail, its original deleted after `ready`, every byte of
// metadata stripped by the photographs' own path
// (processing.render_cover_layers); it is in no photo list; a later set,
// upload or clear retires and destroys it; account deletion leaves it.
const COVERS_PARAGRAPH = `A group or gathering can also have a cover picture, chosen by the people who run it: a gathering's host or co-hosts, a group's admin or co-admins. A cover can be one of its photos. A gathering's cover is seen by the people in that gathering, and a group's cover by everyone in the group, including people who can't see the gathering the photo came from. A photo stops being a cover when it's sent to a bin or deleted. Instead, they can upload a cover picture: ${PRODUCT_NAME} keeps two copies of it at different sizes and deletes the file uploaded, with location and other camera details removed. An uploaded cover isn't one of the photos. It stays until one of them changes or removes it, which deletes it — even if the person who uploaded it has deleted their account.`

const VERSION_3 = [...VERSION_2.slice(0, 4), COVERS_PARAGRAPH, ...VERSION_2.slice(4)]

function noticeParagraphs(): string[] {
  return Array.from(document.querySelectorAll('.notice-card p')).map((p) =>
    (p.textContent ?? '').replace(/\s+/g, ' ').trim(),
  )
}

test("the notice is version 3: version 2's every sentence, unchanged and in order, and the covers paragraph after the photographs", () => {
  renderNotice()
  // The whole card, paragraph by paragraph — the strongest form of "version
  // 2's sentences all still present": nothing reworded, nothing reordered,
  // exactly one paragraph added and nowhere else.
  expect(noticeParagraphs()).toEqual(VERSION_3)
  for (const paragraph of VERSION_2) {
    expect(noticeParagraphs()).toContain(paragraph)
  }
  expect(noticeParagraphs().indexOf(COVERS_PARAGRAPH)).toBe(
    noticeParagraphs().findIndex((p) => p.startsWith('Photos you add')) + 1,
  )
})

test('the covers paragraph, sentence by sentence, as literals', () => {
  renderNotice()
  expect(
    screen.getByText(
      /A group or gathering can also have a cover picture, chosen by the people who run it: a gathering's host or co-hosts, a group's admin or co-admins\./,
    ),
  ).toBeTruthy()
  const paragraph = screen.getByText(/A cover can be one of its photos\./)
  const text = (paragraph.textContent ?? '').replace(/\s+/g, ' ')
  for (const sentence of [
    'A cover can be one of its photos.',
    "A gathering's cover is seen by the people in that gathering, and a group's cover by everyone in the group, including people who can't see the gathering the photo came from.",
    "A photo stops being a cover when it's sent to a bin or deleted.",
    `Instead, they can upload a cover picture: ${PRODUCT_NAME} keeps two copies of it at different sizes and deletes the file uploaded, with location and other camera details removed.`,
    "An uploaded cover isn't one of the photos.",
    'It stays until one of them changes or removes it, which deletes it — even if the person who uploaded it has deleted their account.',
  ]) {
    expect(text).toContain(sentence)
  }
  // And it promises nothing the product does not do: no claim that a photo
  // used as a group's cover is never named (its cover URL's path carries the
  // photograph's id — CK-83a's finding), and no number of days on a cover.
  expect(text).not.toMatch(/never named|isn't named|never identif/i)
  expect(text).not.toMatch(/\d+ days/)
})

test('TOS_VERSION is 3 — this notice; 1 is the CK-26 text, 2 is CK-73.3\'s, the published terms take 4', () => {
  // One number means one text, forever. Version 1 is CK-26's notice and the
  // acceptance rows recorded against it (every account created before
  // CK-73.3 — all Steven's household); 2 is CK-73.3's, true about what was
  // stored until covers; 3 is the text in Tos.tsx today, version 2 with the
  // covers paragraph (CK-83b); 4 is the published terms', set by the phase
  // that publishes them. Never renumber an existing version in either
  // direction — the acceptance records would then name the wrong text, the
  // exact defect the ToS work exists to close (private-alpha decision record
  // §3, §3.1). THE PIN MOVED at CK-83b, with its reason: uploaded covers are
  // a new kind of stored image, so the notice took a new number — with the
  // text, never without it. The next change to what the product stores, or
  // to what deletion does, moves this to 4 and the terms to 5.
  expect(TOS_VERSION).toBe(3)
})
