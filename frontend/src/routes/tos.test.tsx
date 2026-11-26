// CK-26 private-alpha notice pins, revised at CK-73.3 for version 2, at
// CK-83b for version 3, at CK-100 for version 4, at CK-102 for version 5
// (the chat's paragraph, after the covers paragraph) and at CK-104 for
// version 6 (a sentence inside the chat's paragraph, and the paragraph on
// reactions, reading places and typing after it). The value under test:
// /tos carries the load-bearing statements the alpha's condition 4 requires —
// private test, data not kept, what is stored (photos among it: the three
// copies and the deleted original, location removed, the bin's 30 days, which
// photos a person can delete and what happens to one an organiser removes,
// what deletion leaves behind, invitees' addresses cleared after a week, plans
// in Stripe's test mode), every email the app sends — sign-in links,
// invitations, messages about your sign-in email — sent through Resend, with
// the server's own logs recording that one went out and not who it was for,
// what a person can remove before deleting an account (photos; an answer can
// only be changed) — both CK-73.4's corrections — real terms coming — and
// NEVER a sentence that went false (version 1's "Photo upload doesn't exist
// yet"; version 2's first "Delete them first"; version 3's "You can delete
// your own photos at any time" and its server-log paragraph); the sign-in
// checkbox agrees to the test rather than to Terms that do not exist yet —
// with its mechanism intact (unchecked by default, submit disabled until
// checked) — and TOS_VERSION is 6: this text's number since CK-104, version 1
// being the CK-26 text, version 2 CK-73.3's, version 3 CK-83b's, version 4
// CK-100's, version 5 CK-102's, and the published terms taking 7
// (decisions/2026-08-31-private-alpha-scope.md §3, §3.1). Version 4 is
// version 3 word for word but for two paragraphs — the photos paragraph's
// third sentence rewritten into three, and the server-log paragraph replaced
// by the email paragraph — and version 5 is version 4 word for word with one
// paragraph added, on the chat, after the covers paragraph; version 6 is
// version 5 word for word with one sentence added inside that paragraph and
// one paragraph after it. All are pinned below as the whole card, paragraph
// by paragraph, so a word moved anywhere fails.
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
  // Every email the app sends, and who handles it, in version 4's words. THE
  // PIN MOVED at CK-100, with its reason: version 3 said every email was
  // printed to a server log with the address it was for, which goes false the
  // moment the mode switches to provider. Since CK-100 a real address is sent
  // through Resend (services/email.py), and in provider mode the adapter's
  // line names it by a hash prefix alone; the list of what is sent is the
  // product's — the sign-in link and the invite-only note (api/auth.py), an
  // invitation (api/invitations.py, api/group_invitations.py) and both
  // email-change messages (api/profile.py). (The deploy runs provider since
  // CK-100's switch, the one commit that followed the checks.)
  expect(
    screen.getByText(
      /sign-in links, invitations and messages about your sign-in email — are sent through Resend, an email service, which handles each address and message to deliver it/i,
    ),
  ).toBeTruthy()
  expect(
    screen.getByText(/own server logs record that an email went out, but not who it was for/i),
  ).toBeTruthy()
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
  // Your own photos are yours to delete where you can still see them; the
  // bin's clock is the sweep's REMOVED_BIN, 30 days, and the sweep is on
  // (check (gt), 2026-10-19). THE PIN MOVED at CK-100, with its reason:
  // version 3's "You can delete your own photos at any time" was false three
  // ways (the seventh doc audit §18) — an outsider after a turn-off (CK-92), a
  // member moved to Kept a surprise (CK-77), and a photo an organiser removed,
  // which is in the gathering's bin, visible to the host and co-hosts alone
  // (CK-63, CK-66, CK-68) and put back or destroyed by them.
  expect(
    screen.getByText(/delete your own photos from any gathering you can still see/i),
  ).toBeTruthy()
  expect(
    screen.getByText(
      /If the host or a co-host removes one of your photos, only the host and co-hosts can see it from then on: they can put it back within 30 days, and after that it's deleted for good\./i,
    ),
  ).toBeTruthy()
  expect(
    screen.getByText(
      /If you can no longer see a gathering, the photos you added stay in it — ask its host if you'd like them removed\./i,
    ),
  ).toBeTruthy()
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
  // THE PIN MOVED at CK-102, with its reason: version 5's chat paragraph
  // says "a former member" too, so the bare phrase matches two paragraphs;
  // the pin now names the deletion paragraph's own sentence around it.
  expect(
    screen.getByText(/answers you added stay[^.]*under [“"]a former member[”"]/i),
  ).toBeTruthy()
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

test("the sentences that went false never render — version 1's photo claim, version 2's first 'Delete them', and version 3's two", () => {
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
  // And version 3's two, replaced at CK-100 (the whole page, whitespace
  // folded): "You can delete your own photos at any time", false three ways,
  // and the server-log paragraph, false from the switch on.
  const folded = page.replace(/\s+/g, ' ')
  expect(folded).not.toMatch(/delete your own photos at any time/i)
  expect(folded).not.toMatch(/printed to a server log/i)
  expect(folded).not.toMatch(/with the email address each one is for/i)
  expect(folded).not.toMatch(/That's temporary, and it's told to you here/i)
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

// Version 4's two paragraphs (approved by Steven 2026-11-19, THE WORDS of
// CK-100), word for word, the product's name from the brand module. The
// photos paragraph is version 3's with its third sentence rewritten into
// three; the email paragraph replaces version 3's server-log paragraph.
const PHOTOS_PARAGRAPH_4 = `Photos you add can be seen by the people in that gathering, with any caption, tags and file name. ${PRODUCT_NAME} keeps three copies of each photo at different sizes and deletes the file you uploaded; location and other camera details are removed from the copies. You can delete your own photos from any gathering you can still see, and a photo sent to a bin is deleted for good 30 days later. If the host or a co-host removes one of your photos, only the host and co-hosts can see it from then on: they can put it back within 30 days, and after that it's deleted for good. If you can no longer see a gathering, the photos you added stay in it — ask its host if you'd like them removed. Deleting your account removes your email address and name, but photos and answers you added stay in their gatherings under "a former member". Delete your photos first if you'd rather they went. Answers can't be deleted, but you can change yours to "Can't make it" and remove anyone you said you were bringing.`
const EMAIL_PARAGRAPH_4 = `Emails from ${PRODUCT_NAME} — sign-in links, invitations and messages about your sign-in email — are sent through Resend, an email service, which handles each address and message to deliver it. ${PRODUCT_NAME}'s own server logs record that an email went out, but not who it was for.`

const PHOTOS_AT = 3
const EMAIL_AT = 6
const VERSION_4 = VERSION_3.map((paragraph, i) =>
  i === PHOTOS_AT ? PHOTOS_PARAGRAPH_4 : i === EMAIL_AT ? EMAIL_PARAGRAPH_4 : paragraph,
)

function noticeParagraphs(): string[] {
  return Array.from(document.querySelectorAll('.notice-card p')).map((p) =>
    (p.textContent ?? '').replace(/\s+/g, ' ').trim(),
  )
}

// Version 5's one new paragraph (approved by Steven 2026-11-21, THE WORDS of
// CK-102), word for word, after the covers paragraph and before the plans
// paragraph. Each sentence was checked against the product (the /tos
// Gotcha's rule (4)): a group's chat is read from the reader's membership's
// instant on (api/chat.py's group_chat_window), and a join line is written by
// both ways in (none at a group's creation — Q3b); a gathering's chat is
// the invited tier's, an outsider included (_gathering_for_invited); each
// message is stored with its author and its instant (posts); the writer
// deletes their own and the organisers remove others' (POST
// /messages/{id}/remove), a line the chat wrote itself never (Q3a); a
// removed message is held for the organisers alone until removed_at +
// REMOVED_BIN and then deleted by the sweep (Q1, Q2); leaving ends reading
// and keeps the messages; account deletion leaves them under "a former
// member"; and a person who left and came back cannot reach their old
// messages, so the last sentence says "the ones you can still read".
const CHAT_PARAGRAPH = `Groups and gatherings each have a chat. A message you send in a group's chat can be read by the people who were in the group when you sent it; people who join later see the chat from when they joined, and a line in the chat says when someone joins. A message in a gathering's chat can be read by its host, its co-hosts and everyone invited to it, whenever they were invited, including people invited from outside its group. ${PRODUCT_NAME} stores each message with your name and the time you sent it. You can delete your own messages, and the people who run a group or gathering can remove other people's messages in it. A deleted or removed message leaves the chat at once; the people who run that group or gathering can still see it for 30 days, and then it is gone for good. If you leave a group you can no longer read its chat, and your messages stay in it. Deleting your account removes your name, but your messages stay in their chats under "a former member". Delete the ones you can still read first, if you'd rather they went.`

const COVERS_AT = 4
const CHAT_AT = COVERS_AT + 1
const VERSION_5 = [...VERSION_4.slice(0, CHAT_AT), CHAT_PARAGRAPH, ...VERSION_4.slice(CHAT_AT)]

// Version 6's two additions (approved by Steven 2026-11-25, THE WORDS of
// CK-104), word for word. One sentence inside the chat's paragraph, after the
// one on who joins: PUT /gatherings/{id}/outside-invitations writes the line on
// each change, and only the group's members are ever sent it (api/chat.py).
// And one paragraph after it, each sentence checked against the product (the
// /tos Gotcha's rule (4)): a reaction is a row with its person's id, shown by
// name to everyone who can read the message (GET /messages/{id}/reactions),
// taken away by the route that leaves it on any live message its person can
// still read, and deleted with their account (forget_in_every_chat); a reading
// place is a row of its own person's, in no answer but their own arrival
// (chat_read_positions holds no time); and a typing signal is a header on the
// poll, held in memory for six seconds, with nothing of it stored or logged
// (services/chat_typing.py).
const JOINED_SENTENCE = 'people who join later see the chat from when they joined, and a line in the chat says when someone joins.'
const SETTING_SENTENCE =
  "In a gathering that belongs to a group, a line in its chat says when it is opened or closed to people outside the group; only the group's members see that line."
const CHAT_PARAGRAPH_6 = CHAT_PARAGRAPH.replace(JOINED_SENTENCE, `${JOINED_SENTENCE} ${SETTING_SENTENCE}`)
const PRESENCE_SENTENCES = [
  'Reactions you leave on messages are stored with your name and can be seen by everyone who can read the message; you can take yours away from any message you can still read, and they are deleted if you delete your account.',
  `${PRODUCT_NAME} also keeps how far you've read in each chat, to show you what is new; nobody else sees that.`,
  'While you are writing a message, the other people in that chat can see that you are typing; nothing about that is kept.',
]
const PRESENCE_AT = CHAT_AT + 1
const VERSION_6 = [
  ...VERSION_5.slice(0, CHAT_AT),
  CHAT_PARAGRAPH_6,
  PRESENCE_SENTENCES.join(' '),
  ...VERSION_5.slice(PRESENCE_AT),
]

test("the notice is version 6: version 5's every paragraph but the chat's unchanged and in order, one sentence inside the chat's, and one paragraph after it", () => {
  renderNotice()
  // The whole card, paragraph by paragraph. THE PIN MOVED at CK-104, with its
  // reason: this test read version 5 from CK-102 until the notice took 6,
  // because a chat now keeps how far each person has read and shows others
  // that a person is typing (the /tos Gotcha's rule (1)), and because the line
  // CK-102 writes when a gathering opens or closes was never said here.
  expect(noticeParagraphs()).toEqual(VERSION_6)
  // Version 4's paragraphs, every one unchanged and in its order around them.
  expect(noticeParagraphs().filter((_, i) => i !== CHAT_AT && i !== PRESENCE_AT)).toEqual(VERSION_4)
  // After the covers paragraph, before the plans paragraph.
  expect(noticeParagraphs()[CHAT_AT - 1]).toBe(COVERS_PARAGRAPH)
  expect(noticeParagraphs()[PRESENCE_AT + 1]).toMatch(/may show paid plans during the test/)
})

test("version 6's sentences, as literals: the line inside the chat's paragraph, and the paragraph after it, sentence by sentence", () => {
  renderNotice()
  // The setting line's sentence stands inside the chat's paragraph, straight
  // after who joins; the rest of that paragraph is version 5's, word for word.
  expect(CHAT_PARAGRAPH_6).not.toBe(CHAT_PARAGRAPH)
  const chat = noticeParagraphs()[CHAT_AT]
  expect(chat).toContain(`${JOINED_SENTENCE} ${SETTING_SENTENCE}`)
  expect(chat.replace(`${SETTING_SENTENCE} `, '')).toBe(CHAT_PARAGRAPH)
  // The paragraph after it, and no word of it anywhere else on the card.
  const presence = noticeParagraphs()[PRESENCE_AT]
  expect(presence).toBe(PRESENCE_SENTENCES.join(' '))
  for (const sentence of PRESENCE_SENTENCES) {
    expect(noticeParagraphs().filter((paragraph) => paragraph.includes(sentence))).toEqual([presence])
  }
  // And none of the wording Q4's other answer would have needed.
  expect(presence).not.toMatch(/about a minute/i)
})

test("the chat's paragraph, sentence by sentence, as literals", () => {
  renderNotice()
  const chat = noticeParagraphs()[CHAT_AT]
  const sentences = [
    'Groups and gatherings each have a chat.',
    "A message you send in a group's chat can be read by the people who were in the group when you sent it; people who join later see the chat from when they joined, and a line in the chat says when someone joins.",
    // THE PIN MOVED at CK-104, with its reason: version 6 adds this sentence.
    SETTING_SENTENCE,
    "A message in a gathering's chat can be read by its host, its co-hosts and everyone invited to it, whenever they were invited, including people invited from outside its group.",
    `${PRODUCT_NAME} stores each message with your name and the time you sent it.`,
    "You can delete your own messages, and the people who run a group or gathering can remove other people's messages in it.",
    'A deleted or removed message leaves the chat at once; the people who run that group or gathering can still see it for 30 days, and then it is gone for good.',
    'If you leave a group you can no longer read its chat, and your messages stay in it.',
    'Deleting your account removes your name, but your messages stay in their chats under "a former member".',
    "Delete the ones you can still read first, if you'd rather they went.",
  ]
  expect(sentences.join(' ')).toBe(chat)
  for (const sentence of sentences) {
    expect(chat).toContain(sentence)
  }
  // And none of the record's draft wordings it replaced (the kickoff's four
  // changes, each checked against what the product does).
  expect(chat).not.toMatch(/when each person joined/)
  expect(chat).not.toMatch(/can remove any message/)
  expect(chat).not.toMatch(/Delete them first/)
})

test('the email paragraph, as a literal, and the photos paragraph sentence by sentence', () => {
  renderNotice()
  expect(noticeParagraphs()[VERSION_6.indexOf(EMAIL_PARAGRAPH_4)]).toBe(EMAIL_PARAGRAPH_4)
  const photos = noticeParagraphs()[PHOTOS_AT]
  for (const sentence of [
    'You can delete your own photos from any gathering you can still see, and a photo sent to a bin is deleted for good 30 days later.',
    "If the host or a co-host removes one of your photos, only the host and co-hosts can see it from then on: they can put it back within 30 days, and after that it's deleted for good.",
    "If you can no longer see a gathering, the photos you added stay in it — ask its host if you'd like them removed.",
  ]) {
    expect(photos).toContain(sentence)
  }
  // Version 4's two paragraphs against version 3 still hold inside version 6:
  // the photos paragraph changed in its third sentence alone.
  const sentences3 = VERSION_3[PHOTOS_AT].split('. ')
  const sentences4 = PHOTOS_PARAGRAPH_4.split('. ')
  expect(sentences4.slice(0, 2)).toEqual(sentences3.slice(0, 2))
  expect(sentences4.slice(-3)).toEqual(sentences3.slice(-3))
  expect(sentences4).toHaveLength(sentences3.length + 2)
  expect(EMAIL_AT).toBe(VERSION_4.indexOf(EMAIL_PARAGRAPH_4))
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

test("TOS_VERSION is 6 — this notice; 1 is the CK-26 text, 2 is CK-73.3's, 3 is CK-83b's, 4 is CK-100's, 5 is CK-102's, the published terms take 7", () => {
  // One number means one text, forever. Version 1 is CK-26's notice and the
  // acceptance rows recorded against it (every account created before
  // CK-73.3 — all Steven's household); 2 is CK-73.3's, true about what was
  // stored until covers; 3 is CK-83b's, version 2 with the covers paragraph;
  // 4 is CK-100's, with Resend and the photos paragraph rewritten; 5 is
  // CK-102's, with the chat's paragraph; 6 is the text in Tos.tsx today
  // (CK-104); 7 is the published terms', set by the phase that publishes them.
  // Never renumber an existing version in either direction — the acceptance
  // records would then name the wrong text, the exact defect the ToS work
  // exists to close (private-alpha decision record §3, §3.1). THE PIN MOVED at
  // CK-104, with its reason: a chat keeps how far each person has read and
  // shows others that a person is typing, so the notice took a new number —
  // with the text, never without it. The next change to what the product
  // stores, or to what deletion does, moves this to 7 and the terms to 8.
  expect(TOS_VERSION).toBe(6)
})
