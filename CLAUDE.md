# CoveyKeep — Repo Operational Guide

**Version:** 1.90.0
**Last Updated:** 2026-10-28
**Source:** the one-line list of every phase from CK-2 to CK-80 that stood here moved VERBATIM to `CLAUDE-history.md` at 1.88.0 (2026-10-28); each phase is named in its own changelog entry, here or there.
**Audience:** Any Claude session working in this repo.

**Changelog:**
- **1.90.0** (2026-10-28): **The stale code comments the sixth doc audit found are corrected, and two lines of this file with them** (Hub `covey-keep/audits/2026-10-28-doc-audit.md`, its *Owed to code phases* list), at Steven's go. **This file**: the CK-74.2 Gotcha's rule (1) said `(jk)` was still to come and named its fallback; `(jk)` passed on 2026-10-22 (Link gone from Checkout, *Bank* with it) and the fallback was never needed. The CK-64 Deploys bullet said the sweep ships off and nothing clears a bin; it has been on since `(gt)`, 2026-10-19. **The code: comments, docstrings and one server string, in fourteen files** — the audit's nine and five more carrying the same stale facts. `frontend/src/auth/context.ts`: no gate compares account ids since CK-69. `frontend/src/lib/session.ts` and `backend/app/models/auth.py`: a session is 90 days sliding with a 365-day cap (CK-9), not 30 days. `frontend/vite.config.ts`: `AppUpdateProvider.tsx` owns registration since CK-75.1. `frontend/src/lib/media.ts` (twice): the sweep is on. `backend/app/api/media.py`: the restore reads the gate through `_gate_destination` and `_home_facts` (named `_host_kind` until CK-76). `backend/app/api/profile.py`: the deletion leg's keeping lapse as it runs since CK-49b and CK-68. `backend/app/services/keeping.py` (six sites) and `backend/app/models/gathering.py`: the 30/90 grace and the v2 §5 ladder meant to replace it are RETIRED in design (2026-09-27), so `grace_state` and its constants decide nothing; and since CK-76 a gathering resolves through its group. `backend/app/models/group.py`: the resolver's first rung reachable since CK-76. `backend/app/services/billing.py` (twice): `(jk)` passed. `frontend/src/routes/Plan.tsx`: since CK-76 a group's gatherings are charged to its keeper, so whether the line should name groups again is a copy decision not yet made. `frontend/src/lib/media-bin.test.ts` (three comments): the sweep is on; the pins are unchanged. **The one behaviour change**: `_review_refusal`'s message for declining a `live` photograph said taking one down *isn't supported yet*, false since CK-54, and now reads *this photo is already published — to take it down, remove it*. The code (`not_pending`) and the body's shape are unchanged, the frontend switches on the code and never showed the message, and `tests/test_review.py` pins it — red first against the old string, its stale *the takedown is unbuilt* comment rewritten. **Found and not fixed here**: three Deploys bullets that carried no amendment mark, so the 1.89.0 rewrite did not reach them, still describe their phase's moment as current — the publication gate (CK-41: *no belongs-to link*, built at CK-76), Groups (CK-45: *no leave*, rename *admin only*, the admin relinquished with the backup never promoted, and *Not built: membership of anyone else, invitations … the belongs-to link* — all built at CK-75 and CK-76) and the sweep (CK-59: *Not built: … restore-from-bin*, *CK-57 should follow*, and the two decline rows still to go — restore built at CK-63, CK-57 done, the rows destroyed at `(gt)`). Steven's call. No migration, no lock, no deploy file changed.
- **1.89.0** (2026-10-28): **The directory map says what each file is now, and the Deploys restatements are folded into their bullets** — the last piece of the sixth doc audit's condensing proposal (Hub `covey-keep/audits/2026-10-28-doc-audit.md` §19), authored at Steven's go. **The directory map** was one entry per folder, each carrying its files' descriptions with their history phase by phase (52–61% history by the audit's two measures); it is now one line per git-tracked file or folder, 282 lines naming all 262 tracked files with nothing summarized, each saying what the file is in the present tense, with the constraints a reader of one file must know (`api/media.py` never imports `services/ingest.py`; `services/destruction.py` never imports ingest, processing, storage or botocore; the two lock files are generated from their `.in` files) and a phase number on the migrations alone: 178,813 → 31,922 bytes. **The Deploys subsection** carried 11 *Restated at CK-NN* parentheticals and 5 other inline amendments, each correcting the text before it; the nine bullets that carried them — reading back (CK-37), the upload surface (CK-38), the host's review (CK-43), the review surface (CK-43.1), removal and destruction (CK-54), the gathering's bin (CK-66), the host's side (CK-67), paid tiers (CK-73) and your groups (CK-78) — are each rewritten whole to the current state, checked against the code, with every correction folded in and no parenthetical left. The rewrites also correct what no restatement had reached: a removed photograph's audience (the bin of whoever removed it, since CK-63 — not the uploader alone), a decline (into the gathering's bin, not the uploader's), "no endpoint moves `publication_state`", the sweep, restore and both bins' surfaces listed as unbuilt, and check `(jk)` left pending (it passed on 2026-10-22: Link gone, *Bank* with it). The other 31 bullets are byte-identical but for two approximation tildes made `≈` (`≈50 MP`, `≈61 s`), as is the Gotchas' `≈543 ms`. **The old map and the nine original bullets are in `CLAUDE-history.md` 1.1.0, verbatim and in their original order**, and the move is proved against `git show HEAD:` at `4056268`: every moved line is there once and nowhere here (the map's two fence lines excepted); every other line of this file is unchanged except the version line, this entry and the three tilde lines; every section outside the map and Deploys is byte-identical but for those lines; and the map names every tracked file and nothing untracked. **352,552 → 207,171 bytes (-41.2%)**; Deploys 78,447 → 77,297. No code, test, migration or deploy file changed.
- **1.88.0** (2026-10-28): **The changelog and the Source line moved to `CLAUDE-history.md`, verbatim** — the sixth doc audit's condensing proposal (Hub `covey-keep/audits/2026-10-28-doc-audit.md` 1.2.0 §19), applied at Steven's go. This file is loaded into every Claude Code session in the code root, and the moved entries were 53.9% of it. **Moved, byte for byte and in order:** the one-line `**Source:**` (every phase from CK-2 to CK-80) and the 87 changelog entries 1.84.0 back to 1.0.0; each left a one-line pointer. **Kept:** this entry and the three newest (1.87.0, 1.86.0, 1.85.0), and every other section as it was — Commands, Deploys, Gotchas, the directory map — except two references that pointed into the moved entries (the Deploys bullet's "since 1.78.1" and the CK-74.2 Gotcha's "the 1.76.0 entry below"), which now name `CLAUDE-history.md`, and one directory-map line for the new file. **The move is proved**, CK-53's six conditions against `git show HEAD:CLAUDE.md` at `23bc47d`: the kept file with its pointers swapped back equals HEAD byte for byte; every moved line is in HEAD; the moved entries are contiguous in the history file, each once there and nowhere here; the bytes removed equal the bytes moved minus the pointers. **802,703 → 352,552 bytes (-56.1%).** No code, test, migration or deploy file changed.
- **1.87.0** (2026-10-27): Phase CK-80 — **Groups 3c: gatherings in a group — the group's gatherings, each member's place, the photos-only view, and the prompt to share** (`decisions/2026-10-04-a-groups-gathering-stays-in-the-group.md` 1.4.0 — BUILT (frontend) banners under §4, under §10's left-out item and on §11's words item for the three choices; `reference/frontend/components.md` 1.32.0 — the Gatherings in a group convention, the routing row, the inventory, two not-built lists brought current; Steven's four answers of 2026-10-27, each as recommended: on screen the three places read *Invited*, *Sees the photos* and *Kept a surprise* — the screen's labels for the API's `invited`, `shared_with` and `left_out`, which stay the terms; the prompt to share is built, on the gathering page; making a gathering in a group starts from the group's page and the plain `/gatherings/new` stays standalone; one phase; **frontend only: new `lib/places.ts` and `routes/GroupGatheringNew.tsx`; `lib/gatherings.ts`, `lib/groups.ts`, `routes/GatheringNew.tsx`, `routes/GatheringDetail.tsx`, `routes/Gatherings.tsx`, `routes/GroupDetail.tsx`, `components/GatheringMedia.tsx`, `App.tsx` and tests — nothing under `backend/`, no migration, head stays 0034, the verifier at 361 unchanged, neither lock touched, `App.css`, `render.yaml`, `netlify.toml`, `vite.config.ts` and `frontend/.nvmrc` untouched**; **492 frontend tests, 70 new** — `lib/places.test.ts` 11, `lib/gatherings.test.ts` +2, `routes/group-detail.test.tsx` +8, `routes/group-gathering-new.test.tsx` 15, `routes/gathering-in-group.test.tsx` 27, `routes/gatherings.test.tsx` +3, `routes/media-photos-only.test.tsx` 4 — the 422 existing green, the moved pins below; build + lint clean; seven mutations of the load-bearing rules each caught; two commits, one per root). **THE TYPES AND THE ONE READ OF THE VIEW** (`lib/gatherings.ts`): `Gathering` gains `group` (`{id, name}` or null) and `caller_view`, `rsvp_list_visibility` and the detail's `occurrences` become nullable, the list item's `occurrence_count` too; **`viewOf(caller_view)`** — `roleFlags`' shape — answers `{ full, photosOnly }` with `full` ONLY for exactly `'full'`: `'memory'`, null, a missing field and any value this build does not know are the PHOTOS-ONLY view, so an unknown view shows less, never the dates; no surface reads `caller_view` by hand; `listItemLine` — the type, the next date or *You can see its photos*, and the group's name where asked — serves both lists. **THE PLACES** (`lib/places.ts`, `lib/groups.ts`'s shape): `PLACE_LABELS` the ONE table of the three words; `readPlaces` / `setPlace` answering the server's stable code (`is_co_host`, `has_answered`, `is_host`, `not_in_a_group`, `not_found` for a 404, `unreachable`, `failed`), never its wording; **`placesBody` — every member Invited sends NEITHER list** (the whole-group create, CK-76's byte for byte: `invitees_chosen` stays false, so a member who joins later is invited too — sending `invited` with everyone in it would mark the gathering chosen and make every later newcomer see the photos only, silently; pinned on the exact body), otherwise `invited` (possibly `[]`) and `left_out` when anyone is kept a surprise; `listRefusals` reads a create's item-level 422 back to its list and index; every line of copy. **THE GROUP PAGE** gains **Gatherings** after the header and rename, before Members: `GET /groups/{id}/gatherings` (`lib/groups.ts::readGroupGatherings`) on its own key, failing in its own card with Try again; each item a link to the gathering — the title, the type and the next date, or *You can see its photos* and no date; *No gatherings in this group yet.*; **New gathering** for every member → `/groups/<id>/gatherings/new`. **THE FORM** — `routes/GroupGatheringNew.tsx` reads the group and its members (CK-78's one not-found screen for a 404 on either, Try again on a failed read) and renders **`GatheringNew` with an `inGroup` prop** — one form, one 422 mapping, the plain route passing nothing and so offering no group choice: the heading *New gathering in {group name}*, `group_id` in the body, and **Who it's for** — every member but the caller (`is_self`), each a radio group whose legend is their name, **everyone starting Invited**, **Invite everyone** and **Let everyone see the photos**, the hint, the newcomer line following the choice, *No one else is in {group name} yet.* with nobody else; a list 422 lands on the row it names from its code (*{name} isn't in this group any more — go back to the group and start again.*) with *Nothing was created.* beside the button; a 201 lands on the gathering. **THE GATHERING PAGE**: the group line *In {group name}*, a link to the group, for everyone who can read it; **the photos-only view** wherever `viewOf` is not `full` — the header, *You can see this gathering's photos. Its dates and plans are for the people invited.*, and the Photos section with no upload and no date — no When, no RSVP, no Edit, no Invitations, no places, and **the page never reads `occurrences` or `rsvp_list_visibility` there and asks for nothing the view withholds** (pinned: one request, the detail); **Who it's for** for organisers of a group's gathering in the full view — `GET …/places` on mount in its own card, each member's three radio buttons, **a change one tap and one PUT** with the row re-rendered from the server's entry and `invitees_chosen` following the API's documented once-chosen rule, **a co-host's row offering Invited alone** with *A co-host is always invited.*, a member with no place shown with none checked and *{name} has no place on this gathering yet.*, a refusal on its row from its code with nothing re-read and **Refresh the list**, and the places re-read after Make co-host or Remove as co-host, so a new co-host's row offers Invited alone at once (found walking check `(kx)` against the build before the report); **the prompt to share** — once any date has started and the places hold anyone kept a surprise, one line per member at the top beneath the header, *{name} doesn't know about this gathering yet.* with **Let {name} see the photos**, one PUT `shared_with`, the line gone, nothing sent to anyone; **a group gathering's Invitations section is co-host management alone** — titled **Co-hosts**, opened by **Show co-hosts**, the list headed **Invited** with Make co-host — **no email form and no *Waiting on***, because every emailed invitation to a group's gathering is the 409 `members_only` (the defect the kickoff found: the page offered the form and rendered the 409 as a generic failure); a standalone gathering's section unchanged; the failed read *This gathering couldn't be loaded just now.* with **Try again** (the rider). **`Gatherings.tsx`**: *· {group name}* on a group's gathering, *You can see its photos* on a photos-only item, the empty state *Gatherings you start or are invited to will be listed here.* (its CK-17 sentence said *keep*, false since CK-77), and *Something went wrong loading your gatherings.* with **Try again** (the rider); the *Times in* hint only while a date is on screen. **`GatheringMedia`**: `canUpload` (default true) — false renders no upload form, the toggle *Show photos*, and no retry on one's own failed row (it would open a picker that is not there); `occurrences` null — no date label on any photo, **and no row shows the moment it was added either**, a decision beyond the kickoff's letter (that moment says when the event was, and check `(ky)` asks for no date anywhere on the view). **Copy**: every suggested string kept as written; the additions are *Nothing was created.*, *Who it's for couldn't be loaded just now.*, *The list of who's invited couldn't be loaded just now.*, *No one else is invited yet.*, *Back to {group name}* and the generic *Something went wrong. Nothing was created — try again.* for the two list codes this form cannot produce. **The moved pins, each with its reason in the test**: `routes/group-detail.test.tsx`'s *nothing of 3c* (CK-80 IS 3c — the links are New gathering and the way back, one heading names the gatherings, and the group page still names nobody's place) and *nothing identifying on screen* (the group's own id is in the markup exactly once, New gathering's href, and pinned absent from everything else); the detail fixtures of `co-hosts`, `gatherings`, `invitations`, `media` and `rsvps` tests and the list fixture gain `caller_view: 'full'` and `group: null` (a shape change: without `caller_view` a body reads photos-only), and the group page's fake answers the new route with no gatherings; `routes/gatherings.test.tsx` had no pin on the old empty-state or failed-read sentence, so new pins assert both ABSENT. **Diverged from the kickoff, recorded**: (1) the form is `GatheringNew` with an `inGroup` prop behind a new reading component, not a second form (the kickoff's "your call"); (2) the moment a photo was added is withheld in the photos-only view, above; (3) the retry on one's own failed row is withheld with `canUpload` false; (4) `listItemLine` and `readGroupGatherings` are helpers the kickoff did not name; (5) the prompt's region is named by the left-out label from the one table; (6) Who it's for sits after Photos and before the co-host section. Not pushed — the CK-45 precedent. Checks `(ku)`–`(ky)` under the HARNESS RULE's dev-deploy form. Report: `D:\projects\temp\CK-80-report.md`.
- **1.86.0** (2026-10-27): Phase CK-79 — **Groups 3b: joining on the surface — the group's link, requests to join, emailed invitations, and the sign-in return** (`decisions/2026-10-23-joining-a-group-and-co-admins.md` 1.6.0 — BUILT (frontend) banners under §2 and §3, a DECIDED banner on §12's declined-requester item; `reference/frontend/components.md` 1.31.0 — the Joining on the surface and Sign-in return conventions, the routing rows, the sink enumeration extended, the inventory; Steven's four answers of 2026-10-27, each as recommended: a declined requester is not told, for now; a signed-in person asks to join with a press, never on opening; approving takes a second step and declining one click; one phase; **frontend only: new `lib/returnPath.ts`, `lib/groupJoining.ts`, `routes/GroupJoin.tsx` and `routes/GroupInvitationAccept.tsx`; `routes/GroupDetail.tsx`, `components/RequireAuth.tsx`, `auth/AuthContext.tsx` and `auth/context.ts`, `routes/AuthCallback.tsx`, `routes/InvitationAccept.tsx` (its return path only), `App.tsx`, one comment in `lib/groups.ts`, and tests — nothing under `backend/`, no migration, head stays 0034, the verifier at 361 unchanged, neither lock touched, `render.yaml`, `netlify.toml`, `vite.config.ts` and `frontend/.nvmrc` untouched**; **422 frontend tests, 114 new** — `lib/returnPath.test.ts` 13, `lib/groupJoining.test.ts` 24, `routes/group-join.test.tsx` 23, `routes/group-invitation-accept.test.tsx` 14, `routes/sign-in-return.test.tsx` 9, `routes/group-detail.test.tsx` +27, `routes/page-not-available.test.tsx` +4 — the 308 existing green, the moved pins below; build + lint clean; two commits, one per root). **THE SIGN-IN RETURN, built once for three callers** (the Backlog's *a signed-out deep link loses its destination*, homed here by Steven): `lib/returnPath.ts` — `parkReturnPath(path)` stores `{ path, parkedAt }` under `covey-keep:return-path`, `takeReturnPath()` reads, clears and answers the path only when valid and fresh, `clearReturnPath()`; **valid is a same-origin relative path and nothing else** — exactly one leading `/` (never `//`), no backslash anywhere, no control character or space (a browser strips a tab or newline out of a URL, so `/<tab>/evil.example` would become `//evil.example`), no fragment, at most 2,000 characters, and one that resolves against an origin to that same origin — checked at park AND at take, every hostile shape pinned; **fresh is within `RETURN_PATH_TTL`, 30 minutes**, a future timestamp read as stale; storage that throws parks nothing. **`RequireAuth` parks `pathname + search` — never `hash` — in an effect, before its UNCHANGED `<Navigate to="/" replace />`, and only when `signedOutSinceLoad`**: a new optional field on `AuthState` that `AuthProvider` derives during render — null until the auth state first settles, true if it settled signed out, false for the rest of the page load the moment it is ever signed in — so **a sign-out, or a 401 that ends a session this page load held, parks nothing**, and the next person to sign in on a shared device never lands on the last one's page; **a stored session that fails its first check is a signed-out visit and parks** (the first resolution decides — the kickoff's suggestion, taken; recorded as a choice); optional so every hand-built test context parks nothing; `signOut` clears whatever is parked. **`AuthCallback` navigates to `takeReturnPath()` first, else to `/invitations/accept` when a CK-25 token is parked (the old branch, kept as the fallback), else `/home`.** `InvitationAccept` parks `/invitations/accept` when it shows its sign-in step and changes nothing else. **One limit stated, not fixed**: a sign-in link opened on another device or browser has no parked path and lands on Home; **and one found**: a passkey sign-in (`SignIn.tsx`, outside this phase's scope) lands on Home and leaves the parked path to the next callback, a sign-out or the TTL. **THE LINK NEVER LEAVES ITS CALL** (CK-74's rule, applied to a bearer credential): `lib/groupJoining.ts::readLink` and `makeLink` answer `{ expiresAt, share }` or no link, and `share(groupName)` closes over the URL and hands it to the device — `navigator.share({ title, text, url })` where the browser has it, else `navigator.clipboard.writeText(url)`, both injectable (`ShareDevice`; `GroupDetail`'s `device` prop for tests only, the `follow` idiom); the URL is never a property of what is returned, never in state, the DOM, a log or another request (pinned on the returned object, on the markup with every step open, and on the request log after every share outcome); **the device is called inside the click, before anything is awaited** — the share sheet and the clipboard both need the click's user activation, which a network round trip after the click can spend, so the URL is fetched when the section loads and when a link is made (pinned: the share function called synchronously). `share` answers `shared`, `copied`, `cancelled` (an `AbortError` — nothing said), `unavailable` (neither exists) or `failed`, a refusing share sheet falling back to the clipboard once. **THE GROUP PAGE GROWS**, between Members and the leave card: **Requests to join**, for organisers (read once the group body says the caller organises — for anyone else it is the group's 404 and is never asked): the hint, *No one is waiting to join.*, each row the initials, the name and *asked {day}* in the profile zone and nothing else about the person; **Approve takes a second step** — *{name} will join {group name} and see its members. The group's upcoming gatherings will include them.* — **Approve {name}** / **Not yet**, a success re-reading the requests, the members and the group; **Decline is one click**, re-reading the requests; a refusal on its row from its code (`already_decided` by outcome, a 404, the network line, the generic line) with **Refresh the list**; **Invite people**, for every member: no live link — an organiser reads the hint and **Make a link**, a member *There's no link to share right now. An admin or co-admin can make one.*; a live link — everyone **Share the link**, *Works until {day}* and the hint, organisers **Make a new link** and **Turn off the link** each behind a second step (*The current link will stop working, and anyone who hasn't used it yet will need the new one.* — Make a new link / Keep this link; *The link will stop working. Requests already made stay in Requests to join.* — Turn off the link / Keep the link); the share outcome's line in a `role="status"` region; and **Invite by email** for organisers — CK-25's form on the group, the body exactly `{"channel": "EMAIL", "destination"}` through the one mapper, *Waiting on* with each address, *expires {day}* or *expired*, and **Revoke** in one click, the 429's line; **the pending list is the one place an address shows on the group page** — the addresses organisers typed, to organisers alone (CK-25's precedent; the record's DATA-HANDLING). Each section's read fails in its own card with **Try again**; one second step open on the whole page, CK-78's rows included. **THE TWO LANDINGS, both outside `RequireAuth` and before `/groups/:id`** (`App.tsx`; CK-78's static `/groups/join` row removed): `/groups/join` (`routes/GroupJoin.tsx`) consumes the fragment once and strips it, parks the token (`covey-keep:group-link-token`) and picks a parked one up on the return leg; **previews first, signed in or out**, the screen read from the auth state at render; signed out **Join {group name}** / **Sign in to ask to join**, which parks `/groups/join` and goes to `/`; signed in **Join {group name}?** / *When you ask, the group's admin and co-admins will see your name, {name}.* / **Ask to join** / *Not now* — **nothing sent before the press** (Steven); `requested` **Your request is in**, `pending` **You've already asked to join** — *You won't get a message when they decide — if they approve it, the group will be in Your groups.* — `already_member` to the group's page, a dead token its screen, the 429 and the network line with the button live again; the token cleared at every terminal outcome, *Not now* included. `/groups/invitations/accept` (`routes/GroupInvitationAccept.tsx`) is CK-25's acceptance screen on the group, its own component: the token parked under `covey-keep:group-invitation-token`, signed out the preview and **Sign in to accept** (parking this address), signed in **opening accepts** (CK-25's rule — it was addressed to them), CK-25's dead-token screens with the group's *used* line; one call per auth state, so a session that settles after the preview accepts. **Copy changed from the kickoff's suggestions, each with its reason**: *unavailable* reads *This browser can't share or copy the link. Open this page on your phone to share it.* (pressing again cannot help when neither exists, and the page never shows the URL to copy by hand) — *failed* keeps the suggested line; the invitation 429 reads *Too many invitations just now — try again in a few minutes.* (the 429 is either limit, and the per-inviter one counts all of the inviter's groups, so "from this group" could be false); a *shared* outcome says nothing (the person watched it happen). **The moved pins, each with its reason in the test**: `routes/group-detail.test.tsx`'s render helper gains a signed-in context (the page reads the profile zone) and its fake answers CK-79's routes — by default no link, no request and no invitation, the page CK-78 pinned, so the member's and the unknown role's *nothing but Leave* pins hold unedited; *the page offers nothing of 3b or 3c* → *nothing of 3c* (CK-79 IS 3b); *nothing identifying on screen* narrowed — no address outside an organiser's pending list, the request and invitation ids added to the id rule, CK-79's steps opened in turn; `routes/page-not-available.test.tsx`'s two group URLs re-pointed at `/zz-ck79-unbuilt/…` with their fragments, its wiring test likewise, and four tests added that the two URLs now reach their screens; `routes/groups.test.tsx`'s `/groups/join` pin → the join landing. **Mutation-checked**: the guard made to park on every signed-out render fails the sign-out and 401 tests; parking removed fails the three return tests. **Diverged from the kickoff, recorded**: (1) **prerequisite 1 was not met** — the Hub's `WORKING-ON-NOW.md` was uncommitted at 1.215.0, the planning session's own entry queuing this kickoff; the CK-74.2 precedent — the file untouched, the docs commit staged by path, the breach heads the report; (2) **there is no sign-out control on `/settings`** — sign-out lives on Home — so *a sign-out from /settings parks nothing* is pinned two ways: Home's Sign out (with a pre-parked path shown cleared) and a 401 on `/settings`, the case `/home` alone cannot tell apart; the runbook's `(kt)` signs out from Home; (3) the organiser reads wait for the group body rather than firing beside the two reads — for a member each would be a 404 the page never needs; (4) `reference/frontend/components.md`'s sink enumeration is extended beyond the kickoff's docs list (its binding rule: a phase adding a way for a user-influenced value to reach a navigation sink extends it); (5) one comment in `lib/groups.ts` said the inviting and approving screens were Groups 3b's to come; (6) *Refresh the list* under a request refusal, a Try again on each section's failed read, and the landing's preview-failure screen with **Try again** are additions; (7) the brand pin over the new sources uses `/covey ?keep/i` (the CK-74 form) because two new modules carry the `covey-keep:` storage-key slug, the filesystem convention. Not pushed — the CK-45 precedent. Checks `(kp)`–`(kt)` under the HARNESS RULE's dev-deploy form. Report: `D:\projects\temp\CK-79-report.md`.
- **1.85.0** (2026-10-27): Phase CK-78 — **Groups 3a: your groups on the surface — the list, a group's page, its members, and running it** (`decisions/2026-10-23-joining-a-group-and-co-admins.md` 1.5.0 — BUILT (frontend) banners under §5, §6 and §7; `reference/frontend/components.md` 1.30.0 — the Groups on the surface convention, four routing-map rows, the inventory; Steven's split of Groups 3 of 2026-10-27: 3a this phase, 3b joining, 3c gatherings in a group; **frontend only: a new `lib/groups.ts`, new `routes/Groups.tsx`, `routes/GroupNew.tsx` and `routes/GroupDetail.tsx`, `App.tsx`, `routes/Home.tsx`, `App.css`, and three new test files — nothing under `backend/`, no migration, head stays 0034, the verifier at 361 unchanged, neither lock touched, `render.yaml`, `netlify.toml`, `vite.config.ts` and `frontend/.nvmrc` untouched**; **308 frontend tests, 66 new** — `lib/groups.test.ts` 22, `routes/groups.test.tsx` 11, `routes/group-detail.test.tsx` 33 — the 242 existing green and unedited; build + lint clean; two commits, one per root). **WHAT EXISTED**: CK-45, CK-75, CK-76 and CK-77 built groups, membership, co-admins, leaving, removal, handing over and gatherings in a group, all verified on the deploy, and the app showed none of it — no `/groups` route, nothing linking to one. **THE THREE ROUTES, each behind `RequireAuth`, linked from Home's new *Your groups* above *Your gatherings*, in today's classes** (the design session's groups-first shell is the theming phase's): **`/groups`** — `GET /groups`, one request; each group a link to its page with its name, *{n} members* (*1 member* for one) and, for the caller alone, *· Admin* or *· Co-admin*, in the server's order; the empty state a real screen — **No groups yet** / *Groups you start or join will be listed here.* / **Start a group** / *Back home*, promising no invitation, gathering or photo; a failed read *Something went wrong loading your groups.* with a **Try again** button that re-reads through the loading state (the CK-74.1 idiom), never *Try again.* with nothing to press. **`/groups/new`** — `POST /groups` with exactly `{"name"}`: one field, **Name** (`maxLength` 200), the hint *Most groups are named for a family — the Hawkins Family, the Lees.*, **NO TYPE CONTROL and no `group_type` sent** (the API accepts HOUSEHOLD alone; a control it refuses is worse than none — the CK-18 lesson), **Start group** / *Starting…*, disabled until a non-blank character, the server's 422 on `name` inline through the one mapper, a 201 navigating to the new page. **`/groups/:id`** — `GET /groups/{id}` and `GET /groups/{id}/members` together on mount, each on its own reload key; **a 404 on either is ONE not-found screen** — **Nothing here** / *There's no group to show at this address.* / *Back to your groups* — byte-identical for a missing id, a group the caller is not in and a path 422 (pinned on the markup); a failed read *Something went wrong loading this group.* with **Try again**. The header: the name, the count, *You're the admin.* or *You're a co-admin.*; **rename** for organisers (the CK-18 convention: **Group name** holding the current name, **Save** disabled until it differs, a blank sent as `""` so the server's own refusal renders, never null; success renders the PATCH's body and re-reads the group); **Members** in joining order — the initials `aria-hidden` beside the name, *(you)* on the caller's row, *Admin* or *Co-admin* beside the name, and **never an email, a person id, an account id or a membership id on screen** (pinned on the markup with every step open). **THE ROLE COMES FROM THE BODY**: `lib/groups.ts::groupRoleFlags(caller_role)` → `isAdmin` (reserved) and `organises` (the admin or a co-admin — delegable), anything but the three known roles gating closed; **no surface compares person ids**, `admin_person_id` gates nothing. **THE CLASSIFICATION, MAPPED**: the admin gets **Remove as co-admin**, **Make admin** and **Remove from group** on a co-admin's row and **Make co-admin**, **Make admin** and **Remove from group** on a member's, nothing on their own row; a co-admin gets **Remove from group** on an ordinary member's row and **Step down** on their own, nothing on the admin's or another co-admin's; a member gets nothing; the admin alone reads *A co-admin can rename the group, invite people, approve requests to join, and remove members. Only you choose co-admins, remove them, and make someone else the admin.* **Make co-admin is one click; every other act a second, deliberate step inline on its row**, one step open on the whole page — *{name} will no longer be able to rename the group, invite people, approve requests to join or remove members.* (Remove as co-admin / Keep as co-admin), the step-down sentence (Step down / Stay a co-admin), *{name} will be the admin at once, and you'll be a member. Only {name} can make you the admin again.* (Make {name} the admin / Keep the role), *{name} will no longer be a member of this group. Gatherings they're already part of don't change.* (Remove from group / Keep {name}); a success re-reads the members, and the group too where the caller's role or the count moves — Step down and Make admin re-render the page as a member's; **a refusal lands on the row it names from its code, nothing re-read** (`groupRefusalMessage`: `not_a_member`, `is_admin` in two senses, `already_co_admin`, `account_deleted`, a 404 as `not_found`, the network line, the generic line). **Leaving**, every member's, in its own `danger-zone` section beneath the list: **Leave this group** → *Leave {group name}?* → **Leave** / **Stay**; a 204 lands on `/groups`; the admin with other members draws the 409 `hand_over_first` — *You're the admin, so someone else needs the role before you leave. Choose Make admin beside a member's name.* — in the card, nothing navigated; not type-to-confirm. A group with no admin gives nobody `isAdmin`, so the reserved acts render for nobody (the claim flow unbuilt; no copy promises it). **THE FINDING, AND THE ONE ROUTE THE KICKOFF DID NOT NAME**: `/groups/:id` captures `/groups/join` — the join URL CK-75 mints — and, behind `RequireAuth`, sends a signed-out holder to `/` without the fragment: CK-75's finding 1 again, and `routes/page-not-available.test.tsx`'s two `/groups/join#token=abc` pins would have failed. A static row, `<Route path="/groups/join" element={<PageNotAvailable />} />`, outranks the dynamic one and keeps the address on the catch-all's screen exactly as CK-75.1 left it, until 3b's landing replaces it; pinned again in `routes/groups.test.tsx`, signed in and out, no request made. **Copy changed from the kickoff's suggestions, each with its reason**: `account_deleted` gains *— refresh the list.* (each line says the way on); the hint's last clause *and make someone else the admin* (was *and can make*, for the parallel); **the only member's leave card drops the way back** — *To come back, someone in the group will need to invite you or approve your request.* is shown when anyone else remains, and replaced by *You're the only member, so the group will be left with nobody in it.* when nobody would be left to invite them; a rename's 404 renders the no-longer-allowed line rather than the mapper's generic one; the group page's failed read carries the heading *Something went wrong* (GatheringDetail's precedent — the name is unknown there). **Diverged from the kickoff, recorded**: (1) the `/groups/join` row above; (2) the reads live in `lib/groups.ts` too (`listGroups`, `readGroup`, `readMembers`, `GroupRead`), the CK-74 `readBilling` shape; (3) this file's Commands `npm run test` comment gains the phase's tests (the living-description precedent); (4) `reference/backend/api-reference.md`'s Groups router still says *the screens are Groups 3* and lists *the screens, initials and profile pictures (Groups 3)* as absent — left for the planning session, outside this phase's docs list. Not pushed — the CK-45 precedent. Checks `(kl)`–`(ko)` run under the HARNESS RULE's dev-deploy form, three `@example.com` throwaways, B and C joining through the API because joining has no screen until 3b. Report: `D:\projects\temp\CK-78-report.md`.
- *The 87 changelog entries that stood here — versions **1.84.0 down to 1.0.0** (2026-10-25 back to 2026-08-17) — moved VERBATIM to `CLAUDE-history.md` at 1.88.0 (2026-10-28); nothing in them was rewritten.*

---

## Commands

### Frontend (`frontend/`)

```
npm install        # once, or after dependency changes
npm run dev        # dev server
npm run build      # type-check (tsc -b) + production build to dist/
npm run test       # vitest (jsdom) — brand pins (CK-14) + gathering surface (CK-17/CK-18)
                   # + the upload surface (CK-38: the four states, the HEIC fallback,
                   #   a video refused inline, no presigned URL outside its fetch)
                   # + the words (CK-40: the name precedence caption → filename → "Photo",
                   #   the caption's null-never-"", the WHOLE tag list on every save,
                   #   the search's debounced q and its way back)
                   # + the review surface (CK-43.1: the queue only for the host of a
                   #   gated gathering, publish and decline switching on the code, the
                   #   batch refusal on the row it names, and THE STRING both ways —
                   #   the waiting line where gated, CK-38's line where open)
                   # + the host's switch (CK-44: present for the host and absent for
                   #   a member, on sends exactly `true` and off an explicit null —
                   #   never false — with §5's statement verbatim on the off path
                   #   alone; THE STRAND pinned as fixed — review off with rows
                   #   waiting keeps the queue and both acts; the waiting sentence on
                   #   every ready+pending row, one predicate with the queue)
                   # + your own photographs (CK-64: the three acts on own ready
                   #   rows only — nothing on anyone else's, the host included —
                   #   Send to bin one click, Delete permanently's second step with
                   #   the record's sentence verbatim and Keep it, Put back's hint
                   #   by seat where gated, the days-left line with nothing about
                   #   the window's end, a refusal on its row from its code,
                   #   "Photo deleted.")
                   # + the host's side (CK-67: Remove from gathering only for
                   #   the host on others' live ready rows, the second step
                   #   with the exact sentence and Leave it inert, the
                   #   Removed view host-only loading removed=true and never
                   #   both flags, its own empty state, the host bin line
                   #   with the days left, Put back with the everyone-will-
                   #   see-it-again hint, the shared delete confirmation,
                   #   and the refusal line that now names Remove from
                   #   gathering)
                   # + co-hosts on the surface (CK-69: the role matrix on
                   #   the detail page — host, co-host, null — with the
                   #   account ids disagreeing on purpose, so caller_role
                   #   is proven to decide; a co-host's edit form with no
                   #   review switch and a save body that never carries the
                   #   override; Make co-host, "Co-host" beside the name,
                   #   Remove as co-host and Step down each behind a second
                   #   step, the four 422 codes and the 404 on the row they
                   #   name; a co-host's Photos in both gate states — the
                   #   sentences, the Removed view's line and hint, Delete
                   #   permanently on their own row and never on another's,
                   #   no review anywhere; the Removed view's own row; the
                   #   refusal naming the bin the act was on; RSVP as a
                   #   co-host; roleFlags gating closed on anything unknown)
                   # + a photograph that cannot be kept (CK-71: each
                   #   reason's line from both seats as literals, the
                   #   number from MAX_PHOTO_MEGAPIXELS, the controls per
                   #   reason — Choose a smaller copy / nothing / Try
                   #   again, Dismiss beside each — the uploader's only
                   #   and none on a non-own failed row; both retry labels
                   #   opening the picker; Dismiss posting once with no
                   #   body and the row leaving on the re-read, no
                   #   confirmation, no notice; a refusal from its code on
                   #   the row with Refresh the list; the ban — deleted,
                   #   corrupt, damaged, virus, error — on every line; the
                   #   device-side "This upload didn't finish." with Try
                   #   again alone)
                   # + the notice (CK-73.3: every load-bearing statement of
                   #   version 2 — the three copies and the deleted original,
                   #   location removed, the bin's 30 days, "a former member",
                   #   invitees' addresses cleared after a week, test-mode
                   #   plans — the NEGATION of version 1's photo sentence over
                   #   the whole rendered page, the brand rule on the source,
                   #   the checkbox mechanism, TOS_VERSION === 2)
                   # + your plan (CK-74: every state as literals — free, paid
                   #   and renewing with the day in the profile zone, paid and
                   #   ending with both sentences, a change scheduled, the
                   #   usage line's three forms and the bar capped; Upgrade
                   #   and Manage your plan posting once and following the
                   #   URL, which appears nowhere else; each refusal from its
                   #   code; the return page waiting, the 2 s / 10 s cadence
                   #   and the slow line under fake timers, polling stopped
                   #   on unmount, the cancelled return saying nothing;
                   #   Recommended on the free view only; the copy ban and
                   #   no Stripe id over every state; the Settings section
                   #   and its link alone when the read fails; the Get more
                   #   space link on keeper_space_full and on nothing else)
                   # + the catch-all (CK-75.1: the route table rendered at
                   #   /groups/invitations/accept#token=abc, /groups/join#token=abc
                   #   and a mistyped path, signed in and out — the location read
                   #   back exactly as it arrived, the screen's heading rendered,
                   #   Home and sign-in absent, no request made (red first against
                   #   the old catch-all, which read / and /home); a newer worker
                   #   taking control switching the copy in through the real
                   #   wiring; the copy as literals with invitation, token, safe
                   #   and lost banned; checkForUpdate once on mount, the ready
                   #   state arriving later; Reload calling the injected reload
                   #   once with no argument; the source scan — no hash, no
                   #   location.href, no storage, no fetch, no navigation; the
                   #   other routes still their own screens at their own paths;
                   #   and the provider — useRegisterSW in exactly one source
                   #   file, the notice with Reload and Not now, Not now returning
                   #   on the next check at the hour and on visibilitychange,
                   #   online-only, a failed check swallowed)
                   # + the account-deleted screen (CK-76.1: the deletion
                   #   through the real route table — RequireAuth in the
                   #   tree, the real AuthProvider over the real session
                   #   store — landing on /account-deleted with the heading
                   #   and only then signed out, red first at / with the
                   #   sign-in form; a direct visit, signed in or out,
                   #   clearing nothing; the copy as literals; a failed
                   #   deletion's line with nothing moved; the signal one
                   #   boolean naming nothing; no request after the delete)
                   # + your groups (CK-78: Home's link above the gatherings;
                   #   the list in one request with the count and the
                   #   caller's role, the empty state as literals, a failed
                   #   read's Try again re-reading once per press; starting a
                   #   group with exactly {"name"} and no type control, the
                   #   422 on the field, a 201 landing on the page; the role
                   #   matrix — admin, co-admin, member — every row act where
                   #   the classification puts it and nowhere else; each
                   #   second step's first click posting nothing, its keep
                   #   button inert; Step down and Make admin re-rendering as
                   #   a member's; each refusal code on its row, nothing
                   #   re-read; leaving, the 409 in its card; one not-found
                   #   screen for a 404 on either read; no address and no id
                   #   in the markup; /groups/join reaching the catch-all's
                   #   screen until CK-79 and the join landing since)
                   # + joining (CK-79: the sign-in return through the real
                   #   route table and the real AuthProvider — signed out at
                   #   a gated page, parked without its fragment, and the
                   #   callback landing back there; nothing parked, Home; a
                   #   CK-25 token, its screen; a hostile or stale path, Home;
                   #   a sign-out and a 401 mid-page parking nothing; the
                   #   validator against every hostile shape; the link's
                   #   `{ expiresAt, share }` with no property holding the URL,
                   #   the device called inside the click, each share outcome's
                   #   line; Requests to join by seat, Approve's second step,
                   #   Decline in one click, each refusal on its row; Invite
                   #   people by seat and link state; the email form and
                   #   Waiting on; the two landings — the fragment consumed and
                   #   parked, no join request on opening, every outcome's
                   #   screen; no URL and no token in any markup)
                   # + gatherings in a group (CK-80: viewOf — only exactly
                   #   'full' is the full view; placesBody — everyone Invited
                   #   sends NEITHER list, pinned on the exact create body; the
                   #   group page's Gatherings section by view, New gathering
                   #   for every seat; the group form's Who it's for, the two
                   #   bulk buttons, the newcomer line, a list 422 on the row it
                   #   names; the photos-only view from a memory body — no When,
                   #   no RSVP, no Edit, no Invitations, no places, no upload, no
                   #   date, and one request; Who it's for by seat, one tap one
                   #   PUT, a co-host's row Invited alone, each refusal on its
                   #   row; the prompt once a date has started; a group
                   #   gathering's section with no email form; no membership id
                   #   in any markup)
```

### Dev database (repo root)

```
docker compose up -d             # start covey-keep-db (postgres:16)
docker compose down              # stop it (named volume persists data)
```

The container maps host port **5434** (not 5432 — a native Windows PostgreSQL 17
service owns 5432, and the stopped crowdproof-postgres container maps 5433).
All backend env vars live in `backend/.env` (gitignored; template with the full
surface in `backend/.env.example` — since CK-5 that includes `SESSION_SECRET`,
`APP_BASE_URL`, `API_BASE_URL`, `EMAIL_MODE`; the first three are required, so
an `.env` missing them crashes uvicorn/alembic on boot).

### Backend (`backend/`)

```
pip install -r requirements.txt -r requirements-dev.txt
                                 # the TWO LOCKS, hash-checked (CK-72): exactly the
                                 # tree Render installs, plus pytest / pytest-asyncio /
                                 # httpx / uv — into a FRESH venv on Python 3.13.1, and
                                 # again after any change to either lock (dev machines)
uv pip compile requirements.in --universal --python-version 3.13 --generate-hashes -o requirements.txt
                                 # regenerate the runtime lock after editing
                                 # requirements.in — NEVER edit requirements.txt by hand,
                                 # never pip freeze, always --universal (the Gotcha);
                                 # uv keeps the versions already locked, so this moves
                                 # nothing you did not change. Then the dev lock:
uv pip compile requirements-dev.in --universal --python-version 3.13 --generate-hashes -o requirements-dev.txt
uvicorn app.main:app --reload    # run from backend/
alembic upgrade head             # apply migrations (dev DB must be up)
alembic downgrade base           # tear schema back down
alembic revision --autogenerate -m "..."   # new migration; always hand-review
pytest                           # dev DB container must be up: the suite drops +
                                 # recreates covey_keep_test on it and migrates to head
python scripts/verify_schema.py  # read-only schema + data-integrity check against
                                 # the dev DB (or a deploy — see below)
python scripts/verify_r2_credentials.py   # proves the R2 credential split against the
                                 # live buckets: writes + deletes ONE generated test
                                 # object; run from the Render Web Shell (see below)
python -m app.worker             # the ingest worker (CK-35; processing since CK-36):
                                 # poll forever — Render's start command; reads
                                 # WorkerSettings (six vars; the two R2_WORKER_*
                                 # halves from the SHELL, never .env). Since CK-36
                                 # it decodes, strips EXIF, writes three layers and
                                 # deletes the original AFTER the ready commit.
                                 # Since CK-37 its `ready` line carries the
                                 # claim-to-ready time in ms (record §6.3's p95).
                                 # Since CK-41 the line after it says whether the
                                 # photograph went `live` (the gathering resolves
                                 # open) or stays `pending` for the host.
                                 # Since CK-51b a `covey-keep.ingest` INFO line
                                 # rides beside them — THE MONITOR: `charged 1
                                 # photograph; stored N bytes against 1134630
                                 # modeled (0.53x)` — charged against stored at
                                 # the one UPDATE; a ratio drifting above 1.0
                                 # across many photographs means the PRICE is
                                 # wrong, never the count.
                                 # Since CK-54 it also DESTROYS one: a row the
                                 # API marked `destroying` is claimed by the
                                 # same mechanism, its three published objects
                                 # deleted FIRST and `destroyed` committed
                                 # after - the INVERSE of the publish order,
                                 # and for the mirror-image reason. It
                                 # initiated nothing until CK-59.
                                 # Since CK-59 it SWEEPS THE BIN — DARK until
                                 # SWEEP_ENABLED=true is set in the worker's
                                 # dashboard (the seventh variable; off by
                                 # default in the code; "true" in render.yaml
                                 # since CK-73.2 — ON on the deploy since (gt),
                                 # 2026-10-19): from an
                                 # idle poll only, once per 15 min, at most 20
                                 # `ready`+`removed` rows past REMOVED_BIN a
                                 # pass, each MARKED through the one statement
                                 # (services/destruction.py) and destroyed by
                                 # the CK-54 step above — never a bulk UPDATE,
                                 # never a second routine. One INFO line per
                                 # pass that marked anything: `bin sweep: N
                                 # photograph(s) marked for destruction; their
                                 # retrieval window has closed` — the count and
                                 # nothing else. The startup line says
                                 # `sweep=on|off`.
                                 # Since CK-62 a rejected credential backs the
                                 # loop off for a MINUTE (MISCONFIGURED_BACKOFF,
                                 # jittered) instead of the 5 s idle interval it
                                 # fell through to from CK-35 — the ERROR line
                                 # still once per pass; NOT_READY (the database
                                 # unreachable or unmigrated) keeps the 5 s on
                                 # purpose, so it picks up the moment the schema
                                 # lands.
python -m app.worker --once      # drain what is claimable now, then exit
                                 # (0 = drained to idle, 1 = DB/credential not ready);
                                 # with SWEEP_ENABLED on it also sweeps once and
                                 # drains the marks first — the operator's sweep
python tests/fixtures/media/make_fixtures.py   # regenerate the GPS-bearing test
                                 # fixtures (synthetic pixels, a public landmark)
```

Render installs `requirements.txt` only — since CK-72 the universal, hash-checked
LOCK compiled from `requirements.in`, never a hand-edited file — and the dev tools
stay in `requirements-dev.in` → `requirements-dev.txt`, constrained to it;
`tests/test_requirements_lock.py` pins that no dev tool is in the runtime lock.

**The local `.env` and the seven `R2_*` lines (found at CK-43, homed here at
CK-43.1).** The dev machine's `backend/.env` carries **none** of the seven
`R2_*` variables, and since CK-33 the web `Settings` requires all seven with
no default — so anything that constructs it outside the test suite crashes at
boot with a missing-field error: **`alembic upgrade head`, `alembic check`,
and `python scripts/verify_schema.py` against the local dev DB**. `pytest`
needs nothing (`conftest.py` supplies its own seven on a reserved TLD), and
Render has the real values. The fix is placeholders **exported in the shell
for that session — never written to `.env`, never real values**:

```powershell
$env:R2_ENDPOINT_URL = 'https://r2.invalid'
$env:R2_BUCKET_QUARANTINE = 'quarantine.invalid'
$env:R2_BUCKET_PUBLISHED = 'published.invalid'
# the two key ids: exactly 32 hexadecimal characters, the shape the boot check requires since CK-61
$env:R2_UPLOAD_ACCESS_KEY_ID = '00000000000000000000000000000000'; $env:R2_UPLOAD_SECRET_ACCESS_KEY = 'placeholder'
$env:R2_SERVE_ACCESS_KEY_ID = '00000000000000000000000000000000'; $env:R2_SERVE_SECRET_ACCESS_KEY = 'placeholder'
# Stripe (CK-73): four more required settings; the key must start rk_test_ and the secret whsec_, the shapes the boot check requires
$env:STRIPE_API_KEY = 'rk_test_placeholder'; $env:STRIPE_WEBHOOK_SECRET = 'whsec_placeholder'
$env:STRIPE_PRICE_LOOKUP_100K = 'ck_photos_100k_monthly'; $env:STRIPE_PRICE_LOOKUP_300K = 'ck_photos_300k_monthly'
```

(`hide_input_in_errors` means the boot error names the missing field and
echoes nothing — so the symptom is a bare validation error, not a hint about
R2 — or, since CK-73, about Stripe: the four `STRIPE_*` settings are required
the same way, and the block above carries them.) Adding the lines — seven, and
four more since CK-73 — to `.env` with placeholders would also work and
is Steven's call, not a session's: `.env` is his file.

### Deploys (push-driven; no local commands)

| What | URL | Trigger |
|---|---|---|
| Frontend prod | https://covey-keep.netlify.app | push/merge to `main` |
| Frontend dev | https://develop--covey-keep.netlify.app | push to `develop` |
| Backend dev API | https://covey-keep-api.onrender.com | push to `develop` |
| Ingest worker dev | Render `covey-keep-worker` (no URL — serves nothing) | push to `develop` — the same push deploys both services |

- Netlify builds from `netlify.toml` (base `frontend/`, SPA fallback) on the Node version
  in `frontend/.nvmrc` — exact, `22.23.4` since 1.78.1 (its entry is in `CLAUDE-history.md`); never leave it to Netlify's default. `VITE_API_URL`
  is a Netlify env var (all contexts) — baked in at **build** time, so changing it
  requires a redeploy. Both contexts point at the dev API until the prod cutover phase.
- Render builds from `render.yaml`: service `covey-keep-api` + Postgres
  `covey-keep-db-dev` (Ohio). `preDeployCommand` runs `alembic upgrade head`
  before each deploy — migrations on `develop` apply to the Render dev DB
  automatically; a failing migration aborts the deploy.
- Backend CORS origins come from `ALLOWED_ORIGINS` (comma-separated), set in
  `render.yaml`; code default is `http://localhost:5173`.
- Auth env surface (CK-5): `APP_BASE_URL` / `API_BASE_URL` / `EMAIL_MODE=console`
  are literal values in `render.yaml`; **`SESSION_SECRET` is `sync: false`** —
  the blueprint declares the slot, the Render dashboard holds the value (Render
  never populates a `sync: false` var added after the service exists). The app
  crashes on boot without it, by design.
- WebAuthn env surface (CK-10): `WEBAUTHN_RP_ID` (bare domain) and
  `WEBAUTHN_ORIGIN` (full origin) are literal values in `render.yaml`;
  `config.py` defaults cover local dev (`localhost` / `http://localhost:5173`).
  **A passkey is cryptographically bound to its RP ID and does not survive a
  domain change** — every credential enrolled on `*.netlify.app` dies at the
  custom-domain cutover, so the passkey UI stays quiet (settings-only, never
  promoted) until that domain is final, and the prod-cutover phase must warn
  that existing passkeys need re-enrolment.
- R2 env surface (CK-33): seven variables, **all required, no defaults** —
  `R2_ENDPOINT_URL`, `R2_BUCKET_QUARANTINE`, `R2_BUCKET_PUBLISHED`,
  `R2_UPLOAD_ACCESS_KEY_ID`/`R2_UPLOAD_SECRET_ACCESS_KEY` (quarantine only,
  read+write — signs the presigned PUTs) and
  `R2_SERVE_ACCESS_KEY_ID`/`R2_SERVE_SECRET_ACCESS_KEY` (published only, read
  only — signs the presigned GETs). The dashboard values were set on
  2026-09-07, before `render.yaml` declared the slots (the SESSION_SECRET
  ordering); the blueprint carries the two bucket names as plain values and
  everything else as `sync: false` — including the endpoint URL, which
  carries the account id this repo does not record, and which a placeholder
  `value:` would overwrite on the next blueprint sync. **The worker
  credential never enters this service** (CK-35). **After the deploy, and
  after any change to a token or bucket, Steven runs
  `python scripts/verify_r2_credentials.py` from the Render Web Shell**
  (`cd ~/project/src/backend`) — the credentials never leave Render, the
  output is safe to paste, and an assertion-3 failure ("serve credential is
  REFUSED reading quarantine") is a finding about live infrastructure, never
  a reason to relax the assertion. Since CK-33 a local `.env` needs the seven
  lines too (real values only when exercising presigning — reuse the
  dashboard's two tokens, never mint a third; placeholders boot fine — since CK-61 the two access key ids must be 32 hexadecimal characters, the shape the boot check requires, and the secrets any shape).
- Upload intents (CK-34): `POST /gatherings/{id}/media/intents` mints
  presigned PUTs into quarantine and `POST /media/{id}/confirm` HEADs the
  key before moving the row to `uploaded`. **A presigned URL is a bearer
  credential and is never logged, on any path** — the response body is the
  only place one appears (pinned by test). **Since CK-50 the quota's
  subject is the gathering's RESOLVED KEEPER, never the host**
  (`_enforce_limits` → `keeping.resolved_keeper_of`; that account's row
  locked `FOR UPDATE`; **the reserved quantity the batch's ITEM COUNT
  since CK-51b** — the declared bytes until then): a gathering that
  resolves to no keeper refuses every upload — no quota subject, a
  memorial too — and a hostless gathering with a keeper accepts; the
  refusal names neither host nor keeper, and no copy describes a way to
  come to keep a gathering (the claim surface is unbuilt). **Since CK-51b
  the quota COUNTS PHOTOGRAPHS** (`decisions/2026-09-20-photographs-are-the-currency.md`
  §3, §8; the bin record §4–§5): `account_quota` is 10,000
  photo-equivalents, `account_usage` is `photo_count` plus the in-flight
  rows over the gatherings that resolve to the keeper, a photograph is 1
  whatever it weighed, and the memorial ceiling is 5,000 photographs —
  one unit across every gathering type. **The refusal has two audiences
  since CK-51b.1, and both narrowed at CK-65** (keeping-explained §5.2,
  §5.5), decided by the caller's account against the resolved keeper's,
  because only the keeper can free room: **the keeper** reads the room
  form in EVERY bin state, and no usage figure, no owner and no byte
  unit — *this space holds 10,000 photos and has room for 2 more, and
  you're adding 3*, or *…and has no room left, …* — **and no refusal
  names a bin since CK-65**: the bin clause is retired, because the
  keeper may not empty any bin (the destroy audience is the host and
  the uploader, CK-54; a binned photograph is visible only to whoever
  removed it, CK-63), and no "waiting to be cleared" line stands in
  (allowed only once the sweep is on, which the API cannot know) —
  `keeping.account_bin_count` has no route caller, kept for a
  sweep-gated keeper surface; **everyone else** — a host who does not
  keep the gathering included — reads *this space is full, so this
  photo can't be added* / *…so these 3 photos can't be added* and
  nothing more: no allowance (once members are shown who keeps a
  gathering it discloses the keeper's plan — keeping-explained §5.2),
  no room figure (usage in disguise — CK-50's rule), no bin, no
  direction naming whose space it is, and no offer-to-keep line until
  the offer flow exists (moment 6; CK-50's rule). The number a refusal
  names is CHARGED, never visible:
  a binned photograph still counts. `PHOTOGRAPH_BYTES` (1,134,630) is a
  cost model with one runtime use — the worker's monitor line — and is
  never a quota unit. **Since CK-36 the worker
  processes what confirm accepts**: within a poll it reads the original,
  decodes it (JPEG/PNG/WebP/HEIC — the real format from the bytes, and
  since CK-70 a JPEG that carries a second image, which Pillow names MPO,
  decodes from its primary frame alone with nothing past it; ≈50 MP
  guard from the header), applies the EXIF orientation, strips every byte
  of metadata, writes the three layers to `coveykeep-dev`, moves the row to
  `ready` with the derivative rows, `total_bytes` and — since CK-51a (0024) —
  `photo_count` in one transaction (the two columns in ONE UPDATE statement,
  so they cannot diverge; since CK-51b the count is what the quota reads
  and an INFO line after the UPDATE — the monitor — logs the charged
  photograph beside the stored bytes), and
  only then deletes the quarantine original; anything that cannot be
  processed dead-letters on its first attempt and its original goes after
  that commit. The 24-hour lifecycle rule is now the backstop for what a
  crash leaves behind, not the only thing that ever clears quarantine.
  **Since CK-41 `publication_state` moves at `ready`** — `pending → live`
  where the gathering resolves open through the publication ladder (every
  gathering today; the bullet below), in the same statement, and stays
  `pending` where it resolves gated, for the host — whose review (the
  queue, publish, decline) is built at CK-43 (the bullet below).
  **Uploads on the dev deploy are Steven's own test images only** — the
  private-alpha scope has not widened.
- Reading back (CK-37): `GET /gatherings/{id}/media` lists the
  photographs **the caller may see** and
  `GET /media/{id}/url?layer=web|thumbnail` mints one presigned GET through
  the serve credential for a `ready` row. **Who may see a photograph is
  decided per `publication_state`, in one SQL criterion both endpoints
  apply** (`_visible_media`): `live` → the read audience — the host, an
  invitee (a co-host is one by construction), or a member the gathering is
  shared with, and never the keeper by keeping (the CK-77 bullet below);
  **`pending` → the uploader and the host, and nobody else** — not a
  co-host, not a keeper; a `failed` row is `pending` too and is its
  uploader's alone (the CK-71 bullet below); `removed` → the bin of whoever
  removed it, for 30 days after `removed_at`: the uploader for their own
  removal, the host and co-hosts for a row someone other than its uploader
  removed, and nobody for a row with no recorded remover (the CK-63 and
  CK-66 bullets below). A row in destruction is visible to nobody. Not
  interim; never widen `pending` "for now." 404 before any other refusal;
  `archival` is never served (422); a row that is not `ready` is listed with
  its state and draws 409 `not_ready` for a URL. No read moves
  `publication_state`: the worker moves it at `ready` where the gathering
  resolves open, and publish, decline, remove and restore move it after
  that. A presigned GET is a bearer credential like the PUT — never logged,
  pinned with the root at DEBUG.
- The upload surface (CK-38): the **Photos** section of the gathering page,
  `/gatherings/:id` (`components/GatheringMedia.tsx`, `lib/media.ts`).
  Intent → PUT → confirm per file; **a HEIC's `file.type` is empty in the
  browser**, so the declared type falls back to the extension (it is signed
  into the PUT — a wrong one reads as an R2 permissions failure);
  **Content-Length is never set** by hand; the picker's `accept` mirrors the
  allowlist and is never the authority — a video draws the server's 422
  inline, the batch refused whole. **A presigned URL never leaves the
  network call**: not into state, a log, an error, or the DOM — the intent
  response is a local of the handler, and a layer is fetched into a `blob:`
  object URL rather than handed to an `<img>` (which means **the published
  bucket's CORS must allow GET from the frontend origin** — a thumbnail that
  will not show while the URL endpoint answers 200 is that rule,
  out-of-band, not code). **The copy is derived from `status` and
  `publication_state`, never fixed** (`mediaStateMessage`): a `live` row
  reads "Everyone in this gathering can see it."; a `ready`+`pending` row
  says who can see it and that it waits for the host to publish or decline
  it (the review bullets below); a removed row reads its bin's line; and
  **no string calls a pending photograph shared, or claims anything screens
  or approves it** — pinned at the source. A `failed` row's line and
  controls follow its `failure_reason` and are its uploader's alone — Choose
  a smaller copy, Try again or no retry, with Dismiss beside each, and a
  retry re-uploads from the device, never re-queues (the CK-71 bullet
  below). The list polls every 3 s only while something is in flight.
  `archival` is never requested. In the photos-only view the section offers
  no upload (the CK-80 bullet below).
- Words on a photograph (CK-39; migration 0018): the intent takes an
  optional per-item `filename` (**a display string and nothing else** —
  never a key, a path or a header; nothing backfilled, so the pre-0018 rows
  read NULL forever); **`PATCH /media/{id}`** writes a caption and REPLACES
  the tag set, **for the uploader alone — the host draws the 404** (moderation
  is removal, not re-captioning); **`?q=` on the media list** is the naive
  substring search with no index, **inside `_visible_media` and never
  beside it** — a term matching a photograph the caller may not see returns
  nothing. `media_tags` carries **no `gathering_id` and no tagged
  `person_id`, ever** (verifier-asserted); a person tag gets its own record.
  The router logs no word; `q` on the request line is the access log's, as
  every path is. **The surface is CK-40** (next bullet).
- The naming surface (CK-40; frontend only): the intent sends each file's
  name **trimmed** and **`size_bytes` from the `File` and nothing else**
  (the PUT signs `Content-Length`, which fetch forbids setting — a
  disagreement is refused on the signature and reads as a credentials
  failure; a client-side resize or strip would invalidate a size declared
  before it); a row is called by **its caption, then its filename, then
  "Photo"** (`lib/media.ts::mediaName`), so the name survives a reload;
  the caption-and-tags editor renders **on the caller's own rows only and
  never on a failed one**, the caption under the CK-22 clearing rule
  (`null`, never `""`) and **every save carrying the WHOLE tag list** —
  the server replaces the set, a partial list is silent data loss; a tag
  is text, never a link; the search box sets `q` after a debounce, sends
  none for an empty box, and renders its filtered and empty states with a
  way back. Per gathering; no person tags, no suggesting names.
- The publication gate (CK-41; migration 0019): **whether a photograph
  waits for the host is a default the product sets and the host owns,
  resolved through a ladder at publish time and never frozen at create**
  (`app/services/publication.py`; `decisions/2026-09-09-consent-gate-defaults.md`
  2.0.0 §1): the gathering's own setting (`gatherings.requires_approval` —
  the host's choice, written since CK-44 through `PATCH /gatherings/{id}`'s
  `requires_approval_override`), else the home group's default
  (empty today), else the type's template (`capability_profiles.requires_approval`,
  reachable only through a home group; empty today), else the join shape
  (privately joined does not wait; a link anyone can use does — the share
  link will be its producer), with an ORGANIZATION host gated as a
  backstop beneath the two rungs a person sets. **Every gathering today
  resolves open**, so the worker moves `pending → live` in the same
  guarded statement that moves `status` to `ready`; a gathering that
  resolves open is **unreviewed**, and no copy may call it safe, screened,
  reviewed or consent-verified. **`requires_approval` is nullable with no
  server default — NULL means inherit — and creation writes nothing to
  it** (the deliberate inversion of database-schema decision 22; do not
  "fix" the create path back). Every gathering body carries
  `requires_approval` as the EFFECTIVE value beside
  `requires_approval_override`, the host's own — **readable and not
  writable until CK-44, which ships after CK-43's review surface — built;
  writable since CK-44** (`true` / `false` / an explicit `null` = inherit;
  the effective value still refused — the switch bullet below). The
  resolver's `source` is not exposed — CK-44 did not need it (what the
  accuracy statement needs is the inherited answer, and today every
  gathering the switch can render on inherits open; the trigger is the
  share link or rung 2). `_visible_media` is untouched.
  No `groups` column, no belongs-to link, no share link, no profile rows.
- The host's review (CK-43; migration 0020): **what a host does with
  a photograph nobody has published**, decided in
  `decisions/2026-09-13-the-hosts-review.md` before it was built.
  **The host, and nobody else** — not a co-host, not a keeper, not the
  uploader on their own photograph; everyone else draws the media 404 on the
  queue and on both acts. **The queue** is
  `GET /gatherings/{id}/media?awaiting_review=true` — the `ready`+`pending`
  rows, a filter on `_visible_media` in the same `WHERE` as `q`, never a
  second criterion beside it; a `removed` row is in nobody's queue.
  **Publish** (`POST /media/{id}/publish`; the batch
  `POST /gatherings/{id}/media/publish`, up to 50, refused whole)
  moves `ready`+`pending` → `live` and stamps **`published_at`** and
  **`published_by_person_id`**; **decline**
  (`POST /media/{id}/decline`) moves it → `removed` with `removed_at` and
  the host as its remover — into the gathering's bin, where the host and
  co-hosts can put it back for 30 days and its uploader no longer sees it
  (on the host's own photograph, the host's own bin; the CK-63 and CK-66
  bullets below); no fourth state. A `live` row is refused (`not_pending`):
  taking a published photograph down is `POST /media/{id}/remove` (the
  removal bullet below). Guarded updates with stable codes (`not_ready`
  carrying the rung, `already_live`, `not_pending`); a `failed` row has
  nothing to publish; **a `removed` row is never resurrected by approval**.
  **The publisher is NULL when the rule published it** — the worker stamps
  only the date, in the same `CASE` as `live`; **nothing is backfilled**
  (every `live` row at 0020 reads NULL forever), and neither column may be
  made NOT NULL. **Approval moves no byte.** The router logs nothing. A host
  gates a gathering through the product's switch (the CK-44 bullet below);
  nothing is planted in psql.
- The review surface (CK-43.1; frontend only): **the host's review
  reached through the product** — inside the Photos section of
  `/gatherings/:id`, never a route (`components/GatheringMedia.tsx`; the
  helpers and every string in `lib/media.ts`). **One gate on all of it: the
  caller is the host AND review is on or anything the host can see is
  waiting** — `isHost && (requiresApproval || anyWaiting(items))`, the
  strand rule (the CK-44 bullet below), `requiresApproval` being the detail
  body's effective `requires_approval`, read and never written. Where that
  is false nothing of the review renders — not disabled, not
  hidden-but-present — and where review is off and nothing waits, no review
  string reaches the page (pinned at the render); a non-host's own waiting
  row names the host as the one who acts. Where it is true: **the queue is a
  view of the same list** ("Awaiting your review" → `?awaiting_review=true`,
  composing with `q`, the same rows through the same rendering; its empty
  state "Nothing is waiting for your review." — never "No photos yet."; **no
  polling** — only the host's act moves a queued row), beside "All photos"
  and "Removed from this gathering" in the view switch every organiser sees
  (the CK-67 bullet below); **Publish** and **Decline** on every
  `ready`+`pending` row the host sees, switching on the 409's **code** and
  never its wording, the refusal kept on the row (a refusal re-reads
  nothing; a refresh control is the way on); decline on a **deliberate
  second step** — "The gathering won't see this photo. You can still see it
  yourself for 30 days." on the host's own photograph, otherwise the Remove
  step's host form, "Only you and any co-hosts will be able to see this
  photo. You can put it back for 30 days." — with Decline it and Leave it
  waiting; **bulk approve** through the batch endpoint with checkboxes in
  the queue view, **the item-level 422 landing on the row it names** and
  "Nothing was published" beside the button. **THE STRING** (record §8):
  every `ready`+`pending` row reads who can see it and then **"Waiting for
  the host to publish or decline it."** for the uploader, **"Waiting for you
  to publish or decline it."** for the host — who is usually the uploader
  too. The publication stamp rides the body and is rendered nowhere. The
  switch is the CK-44 bullet's, the takedown and the gathering's bin the
  CK-67 bullet's; there is no notification copy.
- The host's switch (CK-44; no migration): **the last phase of the
  publication arc, and the arc is complete** (`decisions/2026-09-09-consent-gate-defaults.md`
  2.3.0 §10.3, §5; `decisions/2026-09-13-the-hosts-review.md` 1.2.0 §13).
  **Backend**: `PATCH /gatherings/{id}` accepts `requires_approval_override`
  — `true` gates, `false` opens, **an explicit `null` clears to inherit**
  (the CK-22 rule exactly), absent leaves alone; host-only (the gathering
  404 for everyone else); `updated_at` stamped; the body re-resolves the
  effective value; **`requires_approval` still refused** — one writable
  representation of the gate, never two; **nothing touches a media row on
  any path** — turning review off publishes nothing that waited. **The
  switch is two-state at the surface** (`routes/GatheringDetail.tsx`, the
  Edit gathering form: "Review photos before they're published"): on writes
  `true`, off writes NULL — **never `false`**, which is accepted by the API
  and produced by nothing until a group default exists for "open
  regardless" to differ from. **§5's accuracy statement renders on the
  turning-off path and only that path** — a plain hint, no block, no
  warning styling, no confirmation, no lecture; nothing on the way on: *"Turning
  this off means photos are published as soon as they're ready — everyone
  in this gathering can see them, and nobody looks at them first. Photos
  already waiting still need your decision, and “Awaiting your review”
  stays until they get it."* Its premise is structural today (the switch
  renders only for the host, a person, whose groupless, privately joined
  gathering inherits open); the body does not yet say what inherit
  resolves to — the share link or rung 2 must make it conditional. **The
  strand is closed by construction**: `components/GatheringMedia.tsx`'s
  gate is **`isHost && (requiresApproval || anyWaiting(items))`**
  (`lib/media.ts::anyWaiting`, derived from the list as loaded) — the
  review renders while anything the host can see is waiting, whatever the
  switch says, and closes by itself when the last row is decided; a
  `ready`+`pending` row's line always says what it waits on (one
  predicate for the sentence and the acts; `mediaStateMessage` lost
  `gated`). No auto-publish, no refusal of the switch, no new state, no
  change to `_visible_media`; whether the switch is delegable to a co-host
  is `co-hosts.md`'s question, recorded there.
- Groups (CK-45; migration 0021): **the first surface on a table that has
  existed since 0001 with no writer** — `app/api/groups.py`, the ninth
  router (`decisions/2026-09-14-groups-get-a-surface.md`). `POST /groups`
  creates a **HOUSEHOLD** group — and only that: `TEAM`, `CONGREGATION`
  and `CLUB` are schema-valid and endpoint-refused (a field-level 422
  naming rung 2 of the publication ladder — the CK-25 `SMS` shape, binding
  until the home group's default exists; `capability_profiles` keeps its
  one seeded row and the router seeds nothing). **The creator is admin
  and first member in one transaction** — a group never exists with zero
  members, even transiently (verifier-asserted on every deployed row) —
  with the membership's `household_id`, `sub_group_id` and `role_id` left
  NULL: no reader consumes them, and one of the seeded rungs is
  `observer`, the retired word. `GET /groups` (member-or-admin, one
  statement), `GET /groups/{id}`, `PATCH /groups/{id}` (rename, admin only;
  `name` never clearable; `updated_at` stamped by patches alone).
  **Both authorization checks live on the PERSON spine** —
  `groups.admin_person_id`, `memberships.person_id` — and the gatherings
  rule (an account fact plus a person fact) does not transfer; do not reach
  for `account_id` here. 404-not-403 byte-identical to a missing id;
  `member_count` computed at read time; **no body carries a roster**, an
  email, or a person id beyond the two admin columns; `name` is never
  logged. **No delete, no leave**: `gathering_invitations.group_id`
  carries no delete rule, so a group delete would 500 exactly as
  `delete_occurrence` did before 0015 — the rule is the delete phase's.
  **`POST /me/delete` relinquishes group admin** (both columns NULL
  wherever the person held them, the backup never promoted) **and keeps
  the membership** — `services/groups.py`, beside the kept-status lapse.
  Not built: membership of anyone else, invitations, sub-groups, the
  belongs-to link and the group default (the next phase), the thread.
- The ingest worker (CK-35): a **second Render service, `covey-keep-worker`**,
  off the same push and the same database — **with NO `preDeployCommand`,
  ever**. Only the web service runs `alembic upgrade head`; two migration
  processes racing one database fail on the first deploy after the worker
  exists (pipeline record §8), so the worker tolerates an unmigrated schema
  by logging and retrying, never crash-looping. **Two paces after a poll
  that settled nothing (CK-62)**: a rejected worker credential
  (`Poll.BACKOFF`) sleeps `MISCONFIGURED_BACKOFF` — 60 s, jittered —
  because only a dashboard edit clears it and that edit redeploys the
  worker, so the interval is never on the recovery path (from CK-35 to
  CK-62 it fell through to the 5 s idle sleep, one doomed store call and
  one ERROR line per pass — check (gx) counted 24 minutes of it); and
  `NOT_READY` — the database unreachable or unmigrated — keeps the 5 s
  idle interval DELIBERATELY, because picking up the moment the schema
  lands is exactly the behaviour the sentence before this one describes.
  Its environment is **six
  variables, exactly, REQUIRED — plus, since CK-59, one optional boolean,
  `SWEEP_ENABLED`, the bin sweep's switch, off by default; the count
  changed and the rule did not, because a boolean grants no powers**
  (`WorkerSettings` in `config.py`): `DATABASE_URL`
  (`fromDatabase`), `R2_ENDPOINT_URL` (`sync: false`), the two bucket
  names, `R2_WORKER_ACCESS_KEY_ID` / `R2_WORKER_SECRET_ACCESS_KEY`
  (`sync: false`) — **not `SESSION_SECRET`, not `R2_UPLOAD_*`, not
  `R2_SERVE_*`**, for which it has no field; and **`R2_WORKER_*` must never
  be entered in `covey-keep-api`'s dashboard** (read-write on both buckets,
  the combination the split prevents, invisible to the verifier script).
  A service created from the blueprint with `sync: false` slots boots once
  into failure by design: set the values in the worker's own dashboard,
  then redeploy — harmless there (no request depends on it), never
  acceptable on the API. **Render runs two workers for ≈61 s on every
  deploy** (measured at CK-35): the row is protected by `SKIP LOCKED`, the
  bucket-side delete by the rule that deleting an absent object is a
  success (CK-36). Detail: `reference/operations/deploy.md`,
  `reference/backend/media-pipeline.md` §5.6–5.7.
- The archival respec (CK-46): `processing.py` writes the archival layer at
  **3200 px long edge, JPEG q85** — it was 4000 px q90 until 2026-09-16, and
  **every photograph ingested before then keeps that spec forever**: no
  migration, no backfill, no re-ingest path, because transcode-on-ingest is
  unfixable retroactively and reprocessing a print master to reclaim bytes
  is refused (`decisions/2026-08-25-media-derivative-layers.md` 1.2.0 §2/§9).
  So a deployed archival row's `size_bytes` says which spec wrote it, and a
  gathering's `total_bytes` mixes the two honestly. The target is the real
  print requirement's (a 300 dpi 8×10 needs 2400×3000, a full-bleed page
  about 2475×3075; 3200 covers both with margin) and it is measured, not
  assumed: roughly half the archival bytes and 40–45% of the three-layer
  total, web and thumbnail unchanged. **The targets are ordered largest-first
  — `ARCHIVAL_LONG_EDGE > WEB_LONG_EDGE > THUMBNAIL_LONG_EDGE`, pinned** —
  because the layers derive from each other and the resize never upscales;
  an archival target at or below the web target would silently serve print
  masters as web images. The web layer's spec is a separate decision with
  its own arithmetic; do not fold it into a "while we're here."
- The keeper, resolved (CK-49a the shape, migration 0022; CK-49b the
  cutover, no migration; CK-49c the contract, migration 0023): **who keeps a gathering is a column, answered
  through the resolver, and every consumer asks it**
  (`decisions/2026-09-17-keeper-model-v2.md` 1.4.0 §3.1). Three nullable
  columns — `gatherings.owning_group_id` (FK→groups, **written since
  CK-76**: the belongs-to link's column, present from 0022 so the CHECK
  was honest and read by the resolver's first rung, written by `POST
  /gatherings` with a `group_id` since CK-76 — the CK-76 bullet below;
  publication rung 3 reached through it since then, rung 2 still
  unbuilt), `groups.keeper_account_id` and
  `gatherings.keeper_account_id` (FK→accounts) — backfilled once at 0022,
  under the CHECK `ck_gatherings_group_gathering_has_no_keeper` (at most
  one of the two set; both NULL is the Unkept rung, a state). **Since
  CK-49b the column is the truth**: `services/keeping.py::resolve_keeper`
  (the group's keeper, else the gathering's own, else `UNKEPT`; every
  answer names its rung; `groups.archived_at` is never an input — do not
  add the parameter; both set is refused) is asked by the quota sum
  (`account_usage`, over the gatherings that resolve to the account), by
  the deletion lapse, and — FROM CK-49b TO CK-77 — by the read audience
  (`resolved_keeper_of` for a loaded row; `keeps_gathering`, the same
  ladder as ONE SQL criterion, in the list's one statement and
  `_visible_media` — safe only because of the CHECK, pinned to agree with
  the resolver); **since CK-77 KEEPING LETS NO ONE IN** (keeping-explained
  §5.11): no audience criterion names a keeper column or the resolver,
  `keeps_gathering` has no caller and is kept for the storage screen, and
  the keeper is still charged — the CK-77 bullet below; `keep()`
  writes the column and `unkeep()` NULLs it, the stamp unchanged in
  meaning. **The old kept relation is GONE (CK-49c, migration 0023)**: it
  stayed through CK-49b's deploy because Render runs the pre-deploy
  migration while the old instance still serves, and 0023 re-ran 0022's
  backfill under the release guard — `keeper_account_id IS NULL AND
  last_keeper_left_at IS NULL AND owning_group_id IS NULL`, and the kept
  row's account not anonymized — and THEN dropped it; the column is the
  only representation there is, and no relation, boolean or counter may
  ever stand beside it "for safety" (two representations is decision 20's
  defect). **The index on both `keeper_account_id`s LANDED at 0024 (CK-51a)** —
  `ix_gatherings_keeper_account_id` and `ix_groups_keeper_account_id`, owed
  since the 0023 kickoff's migration was the re-run and the drop alone and
  re-homed past CK-50's "no migration"; `account_usage`'s WHERE is their
  reader; `owning_group_id` gained its index at 0033 (CK-76), with its
  writer and its first readers by the column. Do not build the five-rung ladder or touch `grace_state`'s 30/90 ahead of
  its surfaces — that is behaviour, not representation, and it is deferred
  with its reason (v2 1.4.0 §5). **The upload gate asks the resolver too,
  since CK-50** (v2 §6): `api/media.py::_enforce_limits` resolves the
  keeper through `resolved_keeper_of`, locks that account's row
  `FOR UPDATE` and checks its headroom — the host is not consulted; a
  gathering that resolves to no keeper refuses the upload (no quota
  subject — a memorial too), a hostless one with a keeper does not, and
  the refusal names neither host nor keeper. **The reserved quantity is
  the batch's item count since CK-51b, and the unit is the photograph**
  (`decisions/2026-09-20-photographs-are-the-currency.md` §3): the
  "modeled reservation size" that CK-50 queued behind a decision record
  was DISSOLVED by that record rather than chosen — nothing is reserved
  in bytes, so there is no modeled size to pick — and the "HEIC
  under-reserves by 30–54%" premise it rested on was measured at the
  4000/q90 spec CK-46 retired (post-respec the declared size
  OVER-reserves by 90%; record §10). Do not reintroduce a byte quantity
  into the reservation, the quota or a refusal; `PHOTOGRAPH_BYTES` audits
  the count from the worker's monitor line and derives nothing.
- Removal and destruction (CK-54; migration 0025): **the path that destroys
  a photograph's stored bytes**
  (`decisions/2026-09-20-the-bin-counts-and-empties.md` §6, §7.1, §7.2).
  **Two endpoints, never one flag**: `POST /media/{id}/remove` (to bin
  — destroys nothing and **frees nothing**: the photograph is still stored,
  so it still counts, bin record §3 — and it is the takedown of a `live`
  photograph) and `POST /media/{id}/destroy` (immediate, irreversible, and
  it reaches a `removed` row too — the per-photograph *empty the bin*). A
  `permanent` flag would mean one client bug permanently destroys what
  should have gone to the bin, and there is no restore. **`decline` is
  separate** — pending-only, a `live` row 409 `not_pending`. **Who may
  act**: `remove` is the host's, a co-host's, or the uploader's own
  (`_may_send_to_bin`); `destroy` is the host's or the uploader's own, never
  a co-host's (`_may_destroy`); **NEVER THE KEEPER**, who holds a reference
  and not a right to destroy; everyone else draws the media 404. **The API
  marks and the worker destroys**: the mark moves `ready` → `destroying` and
  drops `photo_count` and `total_bytes` in **ONE statement**, in the
  transaction that moves the row off `ready`
  (`services/destruction.py::mark_for_destruction` — one copy with two
  callers, this endpoint and the 30-day sweep; its own `ready` guard the
  concurrency guard, and it never commits) — so the room is free the instant
  the request returns and the verifier's two count invariants hold
  unchanged. Then the worker deletes the three published objects and commits
  `destroyed`, **in that order — the INVERSE of the publish transaction's**,
  because a row claiming destruction over bytes still in the bucket is the
  one promise this routine exists to keep; delete-first fails safe, since
  deleting an absent object is a success. **A row in destruction is visible
  to NOBODY** (`_visible_media`'s destruction term — what makes the bin
  record §7.2's surviving filename, caption and tags unreachable by
  any list, search or surface), so a second destroy draws the 404, not a
  refusal; its `publication_state` is left as it was, which is why the
  verifier's live-row assertion admits both destruction rungs. **A spent
  destruction stays at `destroying`** with its `last_error`: uncounted,
  invisible, and owed a bucket operation — never `failed`, which would make
  it visible again. The sweep (the CK-59 bullet below), restore (CK-63) and
  both bins' surfaces (CK-64, CK-67) are built; not built: the account-level
  bin with its empty-the-bin action (Phase C), a per-account bin ceiling. A
  host who removes someone else's photograph reaches it again in the
  gathering's bin, and its uploader never does (the CK-66 bullet below).
- The sweep (CK-59; no migration): **Phase B — the bin's automatic half,
  shipped DARK.** `services/destruction.py::sweep_expired_bin` finds the
  `ready` + `removed` rows whose `removed_at` is at or past
  `now − REMOVED_BIN` — the same constant `_visible_media` reads, so the
  two clocks the bin record §6.1 names meet at one instant: nothing is
  swept while someone could still see it, and nothing sits
  invisible-and-still-charged past the window — and calls
  `mark_for_destruction` on each **row by row, never a bulk UPDATE**,
  committing per row: the statement's own `ready` guard is the
  concurrency safety (two workers cannot double-decrement) and it only
  works per row. **It marks; the CK-54 worker step destroys** — no
  second routine, no second decrement, no `delete_published_object` call
  here. **No memorial branch, no type branch, no account branch, and NO
  FIXTURE EXEMPTION** — no id allowlist, no date floor (bin record §7.4,
  §8; each decided). **The worker runs it only when `SWEEP_ENABLED` is
  on** — `WorkerSettings.sweep_enabled: bool = False`, the seventh
  worker variable, `"false"` in `render.yaml` until CK-73.2 and `"true"`
  since — ON on the deploy since `(gt)`, 2026-10-19 — turned on by hand in the
  worker's dashboard with no deploy — and only from an idle poll (the
  queue drains first, always), once per `SWEEP_INTERVAL` (15 min; the
  first pass at the first idle poll after boot), at most `SWEEP_BATCH`
  (20) rows a pass, because every mark is a destroy job claimed AHEAD of
  any fresh upload (`claim_next` orders by `created_at` across both
  ladders) and twenty bounds that at ≈11 s; a pass that marked anything
  is drained before the loop sleeps, so `--once` with the switch on is
  the operator's sweep from a shell. One INFO line per pass that marked
  anything — the count, nothing else; silence otherwise. **The module
  boundary is the caller set**: `destruction.py` holds what the API and
  the worker both call and never imports `ingest`, `processing`,
  `storage` or botocore (the Gotcha below); `handle_destroying` stays in
  `ingest.py`. **The two decline rows** (`ck43-eg-decline.png`,
  `ck44-em-decline.png`, `removed_at` 2026-09-14, the project's only
  decline evidence) are captured in CK-59's report as far as this
  machine could reach them; the psql row state is Steven's BEFORE the
  switch, and they go on the first pass at or after **2026-10-14** with
  it on. Not built: Phase C (the bin surface, empty-the-bin, every
  user-facing quota surface), restore-from-bin, a per-account bin
  ceiling; CK-57 (what a `destroying` row's `last_error` means) should
  follow, because the sweep makes a stuck destruction likely rather than
  theoretical once it is on.
- Who removed it, and restore (CK-63; migration 0026): **two bins, and a
  photograph is in exactly one — the bin of whoever removed it**
  (`decisions/2026-09-27-two-bins.md` §1–§4). `media.removed_by_person_id`
  — nullable, a person FK with no delete rule, no default, NOTHING
  BACKFILLED — is written by `POST /media/{id}/remove` (the caller's id)
  and `POST /media/{id}/decline` (the host's) in the SAME guarded
  statement as `removed_at`, cleared with it by `POST /media/{id}/restore`,
  and left alone by `destroy` and the sweep (a destroyed row keeps its
  remover as provenance). **`_visible_media`'s `removed` branch admits
  the uploader only when the remover is them**: a photograph the host
  removed or declined is in the GATHERING's bin — no reader until CK-66
  gave it the host (the CK-66 bullet below); a row with NO recorded
  remover (every removal before 0026, the two 2026-09-14 declines among
  them) is visible to nobody, on purpose — do not "fix" NULL to mean the
  uploader, and do not backfill; a host removing their OWN upload keeps
  it in their own bin; an uploader can never reach a host-removed row.
  **The uploader's restore is theirs alone, on their own self-removed
  photograph, within `REMOVED_BIN`**; everyone outside the row's bin
  draws the media 404 byte-identical to a missing id.
  **Where it goes, the gate decides and the restorer does not** — never
  a parameter, never "back to what it was": `publication.resolve_gathering`
  at restore time with the two facts the worker's publish step reads;
  gated → `pending` (the queue, both publication stamps cleared), open →
  `live` (an existing stamp kept; a never-published row stamped now with
  a NULL publisher). **No count moves** — a binned photograph was never
  uncounted. One guarded UPDATE; a rowcount of 0 is the lost race (the
  sweep marked it), refused. The remover's person id rides no body. The
  sweep never reads the column: both bins clear at the window. The only
  frontend change at CK-63 was the decline confirmation's copy; the
  uploader's controls are CK-64's (the bullet below). Detail:
  `reference/backend/api-reference.md` (`POST /media/{id}/restore`),
  `reference/backend/media-pipeline.md` §5.16.
- Your own photographs (CK-64; frontend only): **the three acts, on the
  caller's own `ready` rows and nowhere else** — `Send to bin` (one click,
  undoable), `Put back` (the server decides where it goes; a hint from
  the reader's seat where the gathering requires approval) and `Delete
  permanently` (an inline second step with the bin record §7.1's sentence
  verbatim, `Keep it` beside it — never a browser dialog) — through
  `lib/media.ts::binMedia` and `binRefusalMessage`, the codes the
  contract and `not_pending` the lost race on all three. Never on someone
  else's row, the host included (the host's controls on someone else's
  row are CK-67's, and different acts — the bullet below); never on a
  failed or in-flight row. The
  bin's line counts the days the way back stays open (`binDaysLeft`,
  rounded up, never negative) and **never says a binned photograph is
  deleted, emptied or cleared after the window** — written while the sweep
  shipped off; it has been on since `(gt)`, 2026-10-19, and whether the
  line should now say so is a copy decision not yet made. A destroyed
  row leaves the
  list on the re-read and *Photo deleted.* says why. No backend change:
  every endpoint existed and was verified on the deploy before this
  phase. Detail: `reference/frontend/components.md`, the Photographs
  convention's personal-bin bullets.
- The gathering's bin (CK-66; backend only, no migration): **the host and
  co-hosts read it and restore from it, and the host empties it, one
  photograph at a time** (`decisions/2026-09-27-two-bins.md` §1, §4; the
  surface is the CK-67 bullet below). `_visible_media`'s `removed` branch
  has a second seat: **the host or a co-host sees a removed row whose
  RECORDED remover is someone other than the uploader** — a moderation
  removal or a decline — within the same window; the role test is
  **`_moderates`**, ONE named expression — the SQL `may_administer` — and
  `destroy` never reads it: it stays behind `_may_destroy` (the host, or the
  uploader for their own), so a co-host reads and restores and never empties
  (co-hosts §4 as amended). The bin's shape is **`_in_gathering_bin`** —
  `IS DISTINCT FROM`, never `!=`, because a guest upload's NULL
  uploader would make `!=` NULL and silently hide the row. **`?removed=true`
  on the media list is the bin as a view**: gathering-bin rows only,
  composing with `q`; NO organiser test is written on the flag — the
  criterion composed with visibility IS the test — so anyone else reads a
  200 and an empty list, never a refusal that confirms the bin exists
  (deliberately not the queue's 404); **the DEFAULT list excludes
  gathering-bin rows** while personal-bin rows stay in the
  uploader's default list; the two flags together are a 422. **The host's
  restore goes `live`, whatever the gate says** — review is the host's, so
  putting it back IS approving it (two-bins §4): the publication pair kept
  WHOLE where `published_at` is set (a rule-published row keeps its NULL
  publisher — a fact, not a blank), a declined never-published row stamped
  at restore time with the HOST's person id. **A co-host's restore passes
  through the gate**, as the uploader's restore of their own removal does —
  `pending` where the gathering requires approval, back in the host's queue
  and out of the co-host's sight, `live` where it is open. `destroy` needs
  nothing of its own here — the host reaches gathering-bin rows because the
  audience shows them: the per-photograph empty; no bulk empty exists. **The
  uploader of a row someone else removed still sees nothing, ever**;
  NULL-remover rows stay hidden from everyone; the keeper, invitees and
  strangers gain nothing; no count moves; the sweep clears both bins at the
  window. Detail: `reference/backend/api-reference.md` (the `removed` view;
  the restore section), `reference/backend/media-pipeline.md` §5.16.
- The host's side (CK-67; frontend only): **Remove from gathering, and the
  gathering's bin as the Removed view** — the surface for CK-66's backend
  (`decisions/2026-09-27-two-bins.md` §1–§4), for every ORGANISER: the host
  or a co-host, read from the body's `caller_role` (the CK-69 bullet below).
  `Remove from gathering` renders on someone ELSE's `live`, `ready` row and
  on no other — a pending row keeps the host's Decline (one act per state),
  an organiser's own rows keep CK-64's controls, anyone else is offered
  nothing — behind a deliberate second step whose sentence follows the seat
  and the gate (`takedownSentence`): the host reads "Only you and any
  co-hosts will be able to see this photo. You can put it back for
  30 days."; a co-host reads "Only the host and co-hosts will be able to see
  this photo." and then "You can put it back for 30 days." where the
  gathering is open, or "If you put it back within 30 days, the host will
  look at it again before anyone else sees it." where it requires approval —
  Remove it / Leave it, posting CK-54's `remove` through `binMedia`; the
  step shares a row with no other step. The **Removed view** ("Removed from
  this gathering") is a third view on the same list (`removed=true`, never
  both view flags, composing with `q`) in a view switch every organiser
  sees, and nobody else gets a switch at all; it has its own empty state
  ("Nothing has been removed from this gathering.") and every row in it is a
  gathering-bin row, whoever uploaded it, with the bin line by seat —
  "Removed from this gathering. Only you and any co-hosts can see it, and
  you can put it back for N more days." for the host, "Only the host and
  co-hosts can see it" for a co-host — on the personal line's clock, forms
  and ban. **Put back** is one click to `restore`, its hint saying everyone
  will see it again, or — on a co-host's restore where the gathering
  requires approval — that the host will look at it again. **Delete
  permanently** is CK-64's step with the same constant and sentence, to
  `destroy`, one photograph at a time — on someone else's row the host's
  alone. No bulk empty, no multi-select, no notice to the uploader (two-bins
  §8, open). The decline-on-a-live-row refusal points at Remove from
  gathering. Detail: `reference/frontend/components.md`, the Photographs
  convention's host-side bullets and the Co-hosts on the surface convention.
- Co-hosts (CK-68; migration 0027): **the host stays singular and stays the
  consent controller; a co-host is a row beside them**
  (`decisions/2026-09-03-co-hosts.md` §1–§5, as amended by two-bins §4).
  `gathering_co_hosts` — one row per (gathering, account), keyed on the
  ACCOUNT as `host_account_id` is, `added_by_account_id` as provenance, no
  delete rule anywhere, no capability column ever (one flag and a reserved
  list, never a permission matrix). **Two helpers, and every check in the
  backend is one or the other** (`api/gatherings.py`): `is_host` — the
  RESERVED set: `pending` visibility, the queue, publish, decline, the
  batch, the review switch (a co-host's `requires_approval_override` on
  `PATCH /gatherings/{id}` is a field-level 422 and the whole request is
  refused), destroying someone else's photograph, adding or removing
  co-hosts; `may_administer` — the host OR a co-host: the gathering's
  PATCH, occurrences, invitations, the full RSVP list, taking a published
  photograph down, reading the gathering's bin and restoring from it
  **through the gate** (`pending` where gated — only the host's restore is
  the host's approval). The loaders are `_gathering_for_organiser` /
  `_occurrence_for_organiser` and `_gathering_for_host`; no bare "admin"
  names a gathering role. **`api/media.py::_moderates` IS the SQL
  `may_administer`** and `_may_remove` is split into `_may_send_to_bin`
  and `_may_destroy`, so `remove` widened and `destroy` did not. **The
  three endpoints** (`api/co_hosts.py`): `POST /gatherings/{id}/co-hosts`
  (the host alone; the subject an accepted invitee named by the accepted
  invitation's id — the handle the host already reads; 422 codes
  `not_invited` / `is_host` / `already_co_host` / `account_deleted`),
  `GET …/co-hosts` (the organisers; display names and the handle,
  `is_self`), `DELETE …/co-hosts/{invitation_id}` (the host removes
  anyone; a co-host steps down; a co-host naming another is hidden).
  **`caller_role`** — `host` | `co_host` | `null` — on every gathering
  body; never the co-host list itself. Account deletion deletes the
  account's co-host rows beside relinquishing host; a co-host persists on
  a hostless gathering and still organises it (co-hosts §7,
  provisionally). A keeper who holds no accepted invitation cannot be made
  a co-host through this surface (recorded). The frontend is CK-69 (the
  bullet below). Detail: `reference/backend/api-reference.md` (Co-hosts
  router; the classification, one line per check).
- Co-hosts on the surface (CK-69; frontend only): **the role comes from the
  body, and every gated control reads one of two flags on purpose**
  (`decisions/2026-09-03-co-hosts.md` §4, §7 as amended; CK-68's
  classification, one line per control in `reference/frontend/components.md`'s
  Co-hosts convention). `lib/gatherings.ts::roleFlags(gathering.caller_role)`
  → `isHost` (the reserved set) and `organises` (the host or a co-host —
  the delegable set); anything else gates closed; **no surface compares
  account ids to decide a role** (`host_account_id` stays on the type and
  gates nothing). A co-host gets the edit form without the review switch
  (`gatheringPatch` never writes `requires_approval_override` for anyone
  but the host — the server refuses a co-host's whole body on it), the
  date controls, the Invitations section, the full RSVP list and its
  total, Remove from gathering, the Removed view and Put back from it
  (through the gate — the sentence and the hint say so where the gathering
  requires approval); the host alone keeps the review, Delete permanently
  on someone else's photograph, and choosing co-hosts. **Co-host management
  lives inside the Invitations section**: the list loads with the
  invitations; the host reads a hint saying what they hand over, makes a
  co-host from an Accepted row in one click (the accepted invitation's id
  — the handle the host already reads), and removes one behind a second
  step; a co-host steps down from their own row alone, behind a second
  step, and the page re-renders as an invitee's; refusals switch on the
  422's code (`lib/coHosts.ts`). **Every row in the Removed view is a
  gathering-bin row, whoever uploaded it**, and the copy that said "only
  you" now names the organisers from the reader's seat (the CK-67 bullet's
  restatement above). Nobody is told they were made or unmade a co-host —
  no notification exists (open, in the record). Detail:
  `reference/frontend/components.md` 1.23.0, the Co-hosts convention.
- A photograph that cannot be kept (CK-71; migration 0028): **a `failed`
  row says WHY, for the person, and its uploader can dismiss it**
  (`decisions/2026-09-06-media-pipeline-architecture.md` §6.5 as amended).
  `media.failure_reason` — `too_large` | `unreadable` | `upload_incomplete`
  | `interrupted`, nullable, no default — is written by the worker at the
  dead-letter in the SAME guarded statement as `failed` and `last_error`,
  set iff the row is `failed` (verifier-asserted), and **never derived from
  `last_error`** at runtime: `last_error` stays operator-only and rides no
  body; `failure_reason` rides every media body. **A `failed` row is
  visible to its uploader alone** — `_visible_media`'s second `status`
  term; the host no longer lists a guest's failed row and draws the media
  404 on it everywhere (the host's own failed row is still theirs; a guest
  upload's failed row is visible to nobody — the guest flow is unbuilt).
  **`POST /media/{id}/dismiss` deletes the row** — 204, the uploader's
  alone, 409 `not_failed` for a row that has not failed, the tags by
  CASCADE, no store call, no count moved, no bin, no window. The frontend's
  line and controls follow the reason (`lib/media.ts::failureMessage`,
  `failureRetry`): Choose a smaller copy / nothing / Try again, and Dismiss
  beside each, the uploader's only; the device-side lines are untouched.
  **The deploy's three `IMG_1721.jpeg` rows backfill to `unreadable`**
  (0028's INFO line reports the count per reason and the count left NULL —
  zero expected); a dead-letter by the OLD worker in the deploy window
  would land with a NULL reason and fail the verifier's line until
  classified by hand with the same prefixes. Detail:
  `reference/backend/media-pipeline.md` §5.17, `reference/backend/api-reference.md`
  (`POST /media/{id}/dismiss`), `reference/frontend/components.md`.
- Paid tiers (CK-73, the backend; CK-74, the screens; migrations 0029–0031):
  **two photo plans on Stripe — 100,000 photographs at $4.99 a month,
  300,000 at $9.99 — sold through Stripe-hosted Checkout and the Customer
  Portal, and the allowance read from a local row**
  (`decisions/2026-10-10-paid-tiers-on-stripe.md`). **Stripe owns the money;
  CoveyKeep owns the allowance**: `GET /billing` (the plan, Stripe's status,
  the period end, `ends_at`, `scheduled_change`, the allowance, `used`,
  `plans` and `next` — never a Stripe id, and no Stripe call),
  `POST /billing/checkout` (409 `already_subscribed` for an account already
  holding a paid plan), `POST /billing/portal` (404 with no customer) and
  the unauthenticated `POST /billing/stripe/webhook` — the signature
  verified over the raw body, the subscription FETCHED by id for the ten
  handled types (the four subscription and Checkout events, and the six
  `subscription_schedule.*` events, because a schedule can change without
  any field on the subscription changing) and upserted into `subscriptions`
  (the nudge, never the payload; out-of-order and duplicate delivery
  converge on Stripe's current state), one INFO line per handled event
  carrying the type and id and nothing else, and a subscription Stripe no
  longer holds answered with a 200 and one ERROR line naming the event and
  subscription ids, never the 503. **`ends_at`** is when the plan ends if it
  is ending — `cancel_at` when set, else the period end when the boolean is
  true — derived and never stored: under `2026-09-30.endive` the portal
  cancels through `cancel_at` with `cancel_at_period_end` left false, and
  migration 0030 stores `cancel_at` beside the boolean.
  **`scheduled_change`** is a downgrade waiting for renewal — the next plan,
  its allowance and the instant — from migration 0031's `scheduled_plan` and
  `scheduled_plan_at` (both or neither), which the upsert writes from the
  one fetch's four-level expansion (`schedule.phases.items.price`); null
  whenever `ends_at` is set, and never read by the allowance. **`used`** is
  the caller's own charged count (`keeping.account_usage`, the gate's
  reading) and **`plans`** the three offers with the prices from
  `keeping.PLAN_MONTHLY_PRICE_CENTS`. **`keeping.account_quota` reads the
  row and never calls Stripe** — `active` and `past_due` are paid (a card
  Stripe is still retrying keeps the plan; revenue recovery cancels after
  the final retry, and `canceled` is the free tier with nothing frozen,
  hidden or deleted), every other status is the free tier; no allowance is
  stored anywhere; the quota path, the upload path and the worker never
  import `stripe`. **Checkout offers cards only, and no Link**: every
  Checkout Session carries `allowed_payment_method_types: ["card"]`
  (Steven's decision of 2026-10-22: cards with Apple Pay and Google Pay
  riding them cover nearly everyone, and the list is fixed in code so
  sandbox and live match) and
  `wallet_options: {"link": {"display": "never"}}` (Stripe Link off by
  Steven's decision of 2026-10-21 — the card filter alone did not hide it);
  check `(jk)` confirmed on 2026-10-22 that Link is gone from Checkout and
  *Bank* with it, so the Dashboard's Link switch was never needed. **The
  screens** (CK-74): `/plan` and Settings → Your plan, every number from
  `GET /billing`; the keeper's own room refusal carries `keeper_space_full`,
  which the upload form's Get more space link to `/plan` hangs on; the
  return from Checkout is a wait on `/plan?checkout=complete`, never an
  error; an ending plan's Free card carries no cancel line, a failed read
  has Try again, and the waiting page has its heading and a way back.
  **Deleting an account reaches Stripe first**: the customer deleted — which
  cancels its subscriptions at once — BEFORE the anonymization transaction,
  refused with a 503 `billing_unavailable` and nothing anonymized if Stripe
  cannot be reached, the two billing rows deleted in the transaction. **Four
  dashboard values on `covey-keep-api` ALONE, required with no default** —
  `STRIPE_API_KEY` (a RESTRICTED sandbox key, boot-checked to
  start `rk_test_`: a full-access `sk_` key and a live `rk_live_` key each
  refuse to boot naming the field), `STRIPE_WEBHOOK_SECRET` (`whsec_`),
  `STRIPE_PRICE_LOOKUP_100K`, `STRIPE_PRICE_LOOKUP_300K` — set in
  the dashboard before the push that first declared them, as any new one
  must be (the SESSION_SECRET / R2 ordering: a push made first crash-loops
  the API naming the first missing `stripe_*` field, fixed in the dashboard
  and never by relaxing the check), never on the worker. The webhook
  endpoint is registered at
  `https://covey-keep-api.onrender.com/billing/stripe/webhook` against the
  SDK's API version, `2026-09-30.endive` (`stripe==16.0.0`). **Test cards
  only, in the sandbox; live mode is its own gate** (record §13 — the boot
  check refuses a live key until it is discharged). A Checkout or portal URL
  is a bearer credential for a payment surface and is never logged; the
  `stripe` logger is held at WARNING, and the API's own log lines reach the
  deploy through `app/logging_setup.py` (the Gotcha below). Not built: the
  keeping flows that read `holds_paid_plan` (checkout's 409 is its one
  reader today), annual prices, a third plan, a trial, metering, a retention
  offer, notifications, live mode. Detail:
  `reference/backend/api-reference.md` (Billing
  router), `reference/backend/database-schema.md` (migrations 0029–0031),
  `reference/operations/deploy.md` (Stripe env surface).
- Groups 1 (CK-75; migration 0032): **a group is joined through one link the
  family shares — every join waiting for the admin's or a co-admin's yes —
  or an emailed invitation that admits directly; every member sees the
  member list; co-admins; leaving, removal and handing over; the keeper
  written at creation** (`decisions/2026-10-23-joining-a-group-and-co-admins.md`
  §2, §3, §5–§8; the screens are Groups 3; the belongs-to link is Groups 2a,
  CK-76 — the bullet below).
  **The link's token is never stored**: `<link id>.<MAC>` under the
  session secret (`security.py`), recomputed for any member on every
  read, never logged, in the URL fragment —
  `${APP_BASE_URL}/groups/join#token=…` — a route no bundle has until
  Groups 3, which since CK-75.1 the app's catch-all keeps exactly as it
  arrived, fragment and all, saying the page isn't available (until
  CK-75.1 it redirected to `/` and dropped the token — CK-75's finding 1,
  the CK-75.1 bullet below); rotating
  `SESSION_SECRET` kills every link as it kills every session. **No new
  environment variable**, nothing at Stripe, nothing in a dashboard.
  **Every check on the person spine** — `is_group_admin` (reserved:
  appointing and removing co-admins, handing over) and
  `may_administer_group` (the admin or a co-admin: renaming, approving
  and declining joins, the link, emailed invitations, removing ordinary
  members); the read audience a member or the admin. **Every group body
  carries `caller_role` and no longer `backup_admin_person_id`** — the
  column is retired, written by nothing, verifier-asserted NULL, and NOT
  dropped: the old instance selects it during the pre-deploy window, so
  the drop is a later contract step (UNMAPPED at CK-76 and DROPPED at
  0034, CK-77 — the bullets below; the verifier asserts its absence
  since). **Running a group and keeping it
  never touch**: no hand-over, promotion, leave or removal moves
  `keeper_account_id`. **The deletion leg** (`services/groups.py::
  lapse_group_roles`) promotes the longest-serving co-admin or NULLs the
  admin, deletes the person's co-admin rows and open join requests, keeps
  memberships. **The backfill's INFO line on the deploy is check `(jl)`'s**:
  `0032 backfilled groups.keeper_account_id from the admin's account: N
  group(s) …` — every group created through the API since 0022 whose
  creator still holds an account should be counted, and zero is a
  finding. The reaper's three new customers: invitations and links by
  `expires_at`, join requests by `decided_at`. Detail:
  `reference/backend/api-reference.md` (the Groups router, rewritten;
  the classification one line per check),
  `reference/backend/database-schema.md` (migration 0032; decision 48).
- A gathering in a group (CK-76; migration 0033): **the belongs-to link,
  written at last — any member creates a gathering IN a household group,
  the group's keeper keeps it, and every other member is invited by a
  row** (`decisions/2026-10-23-joining-a-group-and-co-admins.md` §4;
  `decisions/2026-09-02-groups-as-homes.md` §3; the archive record §6.1;
  `decisions/2026-10-04-a-groups-gathering-stays-in-the-group.md` §4, §9;
  the screens are Groups 3; the host's choice of who is invited — shared
  with, left out — is CK-77, Groups 2b, BUILT — the bullet below). `POST /gatherings` with a
  `group_id`: the caller's PERSON a member (`member_of`; else the GROUP's
  404, nothing written) and the group a HOUSEHOLD (else a 422 at
  `group_id`); one transaction writes `owning_group_id`, NO keeper of the
  gathering's own (the CHECK; `keep()` does not run — the group's keeper
  answers through the resolver's first rung, and **the upload gate
  charges that account**, its first real group subject), the creator as
  host, the dates, and one person-targeted `gathering_invitations` row
  per other live member, `invited_by` the creator
  (`services/groups.py::invite_group_members`). **Every member's place
  is a row, never a lookup**: leaving and removal change none of them. A
  newcomer gets rows for the group's UPCOMING gatherings when they join —
  both admission paths, one helper (`invite_newcomer_to_upcoming_gatherings`),
  `invited_by` NULL (the rule), never the past; upcoming is a date whose
  end is at or after now (a season with a date ahead, a date in
  progress). **Members only**: an emailed invitation to a group gathering
  is a 409 `members_only` before anything is written or sent, never a
  destination lookup. **The list is the read audience** — kept OR
  invited OR host OR co-host at CK-76, one statement (the CK-68 gap
  closed); since CK-77 invited OR host OR co-host OR shared with, the
  kept term gone — and
  `GET /groups/{id}/gatherings` lists the group's gatherings for its
  members; **`group`** (`{"id", "name"}` or null) on every gathering
  body. **Rung 3 of the publication ladder is reached through the home
  group**: `resolve_gathering` carries `template_default` from all three
  callers, and a household group's gathering resolves open from TEMPLATE
  (the same `live`). **`groups.backup_admin_person_id` is unmapped and
  not dropped** — DROPPED at 0034, CK-77, with its FK and the
  `alembic/env.py` `include_object` hook that passed it over until then. A gathering never moves between groups or
  gains one later. Detail: `reference/backend/api-reference.md` (the
  Gatherings router's group paragraph, `POST /gatherings`, `GET
  /groups/{id}/gatherings`, the Invitations router's members-only
  paragraph), `reference/backend/database-schema.md` (migration 0033;
  decision 49).
- Choosing who is invited (CK-77; migration 0034): **on a group's gathering
  each member holds one of three places, every one a row the host
  controls, and keeping lets no one in**
  (`decisions/2026-10-04-a-groups-gathering-stays-in-the-group.md` §4, §9,
  §10, §11; `decisions/2026-09-02-participation-terminology.md` §4, §5;
  `decisions/2026-09-27-keeping-explained.md` §5.11; the screens are
  Groups 3). **INVITED** is the person-targeted `gathering_invitations`
  row — logistics and memory; **SHARED WITH** and **LEFT OUT** are rows
  in `gathering_member_places` (`member_place`: `shared_with` |
  `left_out`), a SIBLING relation and never a kind on the invitation row,
  so a place row grants nothing until a read path opts in — `shared_with`
  is opted into by exactly `_gathering_for_memory` and `_visible_media`'s
  `live` branch, `left_out` by nothing. **Two read tiers**
  (`api/gatherings.py`): `_gathering_for_invited` (named
  `_gathering_for_read` until CK-77 — the host, a co-host, an invitee;
  the upload intent, RSVP, the publish batch) and `_gathering_for_memory`
  (the invited tier or a `shared_with` row; the detail and the media
  list), and **`caller_view`** — `full` | `memory` — on every gathering
  body: in the memory view `occurrences`, `rsvp_list_visibility`,
  `next_occurrence` and `occurrence_count` are NULL, withheld and never
  empty (the CK-30 precedent). **THE KEEPER IS NO AUDIENCE**: from CK-49b
  to CK-77 the resolved keeper was a term of the detail, the list and the
  `live` media branch; since CK-77 no audience criterion names a keeper
  column or the resolver — a keeper who is neither host, co-host, invited
  nor shared with draws the 404 a stranger draws, a gathering in their own
  group they are left out of included (the surprise party is for them) —
  and **the quota path is untouched**: `_enforce_limits` and
  `account_usage` still charge the resolved keeper for every photograph in
  what they keep. `keeps_gathering` has no caller and is kept for the
  storage screen; a pin fails if any router names it. **The host chooses
  at create** — `POST /gatherings` with `group_id` takes `invited` and
  `left_out`, lists of membership ids; the rest are shared with
  (`services/groups.py::place_group_members`); item-level 422s
  `not_a_member` / `is_host` / `duplicate`, nothing written on any — **or
  through the places routes**: `GET /gatherings/{id}/places` (who stands
  where, by membership id and display name; `place` null for a member
  with no row of either kind) and `PUT /gatherings/{id}/places/{membership_id}`
  (`{"place"}`; delegable; 409 `is_co_host` and 409 `has_answered` keep an
  invited member invited, 422 `is_host`, 409 `not_in_a_group` on a
  standalone gathering, the member 404 for a bad id). **Once chosen,
  chosen**: `gatherings.invitees_chosen` (default false, under the CHECK
  that keeps it off a standalone gathering) moves only toward true and
  decides a newcomer's place — an invitation row on a whole-group
  gathering, a `shared_with` row on a chosen one (both admission paths,
  one helper). **The upload audience is the invited tier**: a member only
  shared with sees the photographs and adds none. **The contract step**:
  `groups.backup_admin_person_id` is dropped at 0034 with its FK and the
  `alembic/env.py` hook (retired CK-75, unmapped CK-76). No notification,
  no screens, no sharing outside the group, nothing on a standalone
  gathering (its memory tier has no writer yet). Detail:
  `reference/backend/api-reference.md` (the Gatherings router's
  authorization paragraph — the two tiers — `POST /gatherings`'s two
  lists, the places routes, `GET /gatherings` and `GET /gatherings/{id}`),
  `reference/backend/database-schema.md` (migration 0034; decision 50).
- The catch-all keeps the address (CK-75.1; frontend, and two backend
  docstrings): **`<Route path="*">` renders `routes/PageNotAvailable.tsx`
  and never navigates** — the address a person arrived at stays exactly as
  it arrived, path, query and fragment, signed in or out — where until
  CK-75.1 it was `<Navigate to="/" replace />`, which replaced the whole
  address with `/` and sent a signed-in person on to `/home`: the group
  invitation CK-75 mints lost its `#token=` that way (check `(jo)`), and a
  tab on a stale bundle sent a typed `/plan` to Welcome (CK-74's checks).
  The screen reads nothing from the address (pinned by a source scan),
  asks the one service-worker owner for an update once on mount, and when
  a newer version has taken control (CK-8.1's `onNeedReload`) offers
  **Reload** — a plain reload of the same address, which the newer bundle
  then routes — above *This page isn't available* and **Go to CoveyKeep**
  → `/`. **The service worker has ONE owner**, `components/AppUpdateProvider.tsx`
  (`useRegisterSW` exactly once, pinned by a glob over every source file;
  `updateReady`, `dismissed`, `checkForUpdate`, the hourly and on-visible
  checks), read by the notice and by the catch-all through `useAppUpdate()`;
  `injectRegister: null` and `registerType` untouched, no reload ever
  forced. Under tests the plugin's virtual module is aliased to an inert
  stub in `vitest.config.ts` (the Gotcha below). Check `(jt)`, the update
  path, rides the next push that changes `frontend/`: a tab left on this
  bundle, a new route opened in it, the newer-version line, Reload.
- Your groups (CK-78; frontend only): **Groups 3a — the list, a group's
  page, its members, and running it**, the screens for CK-45's and CK-75's
  backend (`decisions/2026-10-23-joining-a-group-and-co-admins.md` §5–§7).
  Three routes behind `RequireAuth`, linked from Home's *Your groups*:
  `/groups` (one request; name, count, the caller's role; a real empty
  state; Try again on a failed read), `/groups/new` (one field, **no type
  control**, `group_type` never sent) and `/groups/:id` (the member list
  with initials, renaming, co-admins, removal, handing over and leaving —
  beside joining's sections and the group's gatherings, the next two
  bullets). **The role is the body's `caller_role` through
  `lib/groups.ts::groupRoleFlags`** — `isAdmin` for the reserved acts,
  `organises` for the delegable ones, anything unknown closed; no surface
  compares person ids. Every act but Make co-admin takes a second step
  inline on its row; a refusal lands on its row from its code; a 404 on
  either read is one not-found screen; nothing identifying is ever rendered
  — the membership id is the handle in calls alone. **`/groups/join` and
  `/groups/invitations/accept` are joining's landings** (the CK-79 bullet
  below), routes of their own outside `RequireAuth` that `/groups/:id` never
  captures, so a join URL keeps its fragment. Not built: notifications, the
  claim flow. Detail: `reference/frontend/components.md`, the Groups on the
  surface convention.
- Joining on the surface (CK-79; frontend only): **Groups 3b — the group's
  link, requests to join, emailed invitations, the two landings, and the
  sign-in return** (`decisions/2026-10-23-joining-a-group-and-co-admins.md`
  §2, §3, §12). The group page gains **Requests to join** (organisers:
  initials, name and the day asked; Approve behind a second step that says
  the person will see the members and the group's upcoming gatherings;
  Decline in one click) and **Invite people** (every member: Share the link,
  the day it stops working; organisers make it, replace it and turn it off,
  and invite by email with *Waiting on* — the one place an address shows,
  to organisers alone). **The link never leaves its call**:
  `lib/groupJoining.ts` hands the page `{ expiresAt, share }`, and `share`
  gives the URL to the device's share sheet or clipboard inside the click —
  never rendered, kept in state, logged or sent. **`/groups/join`** and
  **`/groups/invitations/accept`** are landings outside `RequireAuth`: the
  fragment consumed and parked across the sign-in round trip, the preview
  first; **asking to join is a press, never an opening** (Steven), while an
  emailed invitation **accepts on opening** (CK-25). **The sign-in return**
  (`lib/returnPath.ts`): `RequireAuth` parks the path and query — never the
  fragment — of a gated page opened signed out, and `AuthCallback` lands
  there after the magic link; a sign-out or a 401 that ends a session parks
  nothing, and a sign-out clears what is parked. **A declined requester is
  not told, and nobody is notified of anything.** **Building is not using**:
  sending the link outside the household is the name gate's. Not built: a
  gathering's share link, texts sent by CoveyKeep, the contact picker, a QR
  code, notifications, 3c (gatherings in a group — built at CK-80, the
  bullet below). Detail:
  `reference/frontend/components.md` 1.31.0, the Joining on the surface and
  Sign-in return conventions.
- Gatherings in a group (CK-80; frontend only): **Groups 3c — the group's
  gatherings, each member's place, the photos-only view, and the prompt to
  share** (`decisions/2026-10-04-a-groups-gathering-stays-in-the-group.md`
  §4, §9–§11). The group page lists its gatherings (`GET
  /groups/{id}/gatherings`) with **New gathering** for every member, which
  opens `/groups/:id/gatherings/new` — `GatheringNew` with the group's
  members: each member but the caller **Invited**, **Sees the photos** or
  **Kept a surprise** (Steven's words for the API's `invited`,
  `shared_with` and `left_out`, which stay the terms; `lib/places.ts`
  holds the one table). **Everyone Invited sends neither list** — the
  whole-group create, so a later newcomer is invited too
  (`placesBody`). **The photos-only view**: wherever `viewOf(caller_view)`
  is not `full`, the gathering page shows the header, one line and the
  photos — no dates, no RSVP, no upload, no date on a photo — and never
  reads or asks for what the view withholds. On a group's gathering the
  organisers get **Who it's for** (one tap, one PUT per change; a co-host
  stays Invited) and, once a date has started, **the prompt to share** for
  each member still kept a surprise; the Invitations section is co-host
  management alone, because every emailed invitation to a group's gathering
  is the 409 `members_only`. **Nobody is told their place**: no
  notification, email or message exists. Not built: sharing outside the
  group and its setting, the line at the top (§6), the alert, the group
  chat, calendars, the history setting, profile pictures. Detail:
  `reference/frontend/components.md` 1.32.0, the Gatherings in a group
  convention.
- Browser session (CK-6, lifetime CK-9): `/auth/verify` 302s to
  `${APP_BASE_URL}/auth/callback#token=<jwt>` — the JWT rides the URL
  **fragment**, never the query string; the frontend stores it in
  `localStorage` (must survive a browser restart — the trusted-device
  promise; httpOnly cookie deferred to the prod cutover). Sessions are
  **90-day sliding** (pushed forward on use, refreshed at most daily) with a
  **365-day absolute cap** from `issued_at`; revoked/expired sessions are
  never extended. Decision records: docs root
  `decisions/2026-08-20-browser-session-storage.md`,
  `decisions/2026-08-20-sign-in-ergonomics.md` §2.
- Email is **console mode**: magic links print to the Render service logs; no
  provider, no real sends. The flip to real delivery is its own later phase
  (family transactional-email standard v1.0.0) — never flip `EMAIL_MODE` as a
  side effect of another change.
- **Verifying a deployed migration (CK-13.1):** a green deploy proves `alembic
  upgrade head` *ran*, not what shape it left — and a backfill only has real
  rows to act on in the deployed DB, which is exactly what local tests never
  exercise. Run `python backend/scripts/verify_schema.py` after every migration
  that reaches Render, with the **external** connection string supplied by env
  var and nothing else:
  ```powershell
  $env:VERIFY_DATABASE_URL = Read-Host "Render external connection string"
  python backend/scripts/verify_schema.py
  ```
  `Read-Host` keeps the value out of PSReadLine's on-disk history. **That string
  is a live credential for a database holding real email addresses** — never
  commit it, never put it in `.env`/`.env.example`/`render.yaml`/a fixture, and
  never paste it into a chat window. The script is read-only (enforced by
  `default_transaction_read_only=on`, not just by intent), prints only counts
  and shapes, and exits non-zero on any failed assertion. **Two rules:**
  extending the assertions is part of shipping a migration, and a failed
  assertion is a **finding** — a schema repair is its own phase with its own
  migration, never a relaxed assertion. With no `VERIFY_DATABASE_URL` it checks
  the local dev DB, which is how the assertions earn trust before a deploy run.
- No backend prod service yet — dev-first; prod cutover is its own later phase.

## Gotchas & lessons learned

- ⚠️ **A body's withheld field is NULL and is never read as empty: `viewOf` decides what the page asks for, and in the photos-only view nothing reads `occurrences`, `rsvp_list_visibility`, `next_occurrence` or `occurrence_count`.** Since CK-77 a member only shared with a group's gathering reads the memory view — `caller_view: "memory"` with those four NULL — and until CK-80 the gathering page read `gathering.occurrences` unguarded, so opening such a gathering broke the page. Three rules. **(1)** The view is read in one place, `lib/gatherings.ts::viewOf`, and only exactly `'full'` is the full view: `'memory'`, null, a missing field and a value this build does not know are the photos-only view, so a body the page does not understand shows less, never the dates (the `roleFlags` rule, applied to the view). A fixture that omits `caller_view` therefore renders the photos-only view — every detail fixture carries `caller_view: 'full'` since CK-80. **(2)** Never turn a withheld NULL into `[]` or 0 to make a render branch work — that claims a gathering with no dates (the CK-30 precedent: withheld is not empty). The photos-only branch returns before anything reads the dates, and the full branch reads them with a fallback that only satisfies the type. **(3)** The view decides what is ASKED FOR, not just what is shown: the photos-only page requests nothing the server withholds from it (no RSVP list, no places, no invitations, no co-hosts — pinned at one request) and offers nothing it refuses (no upload). A new read on the gathering page asks `viewOf` first. (CK-80.)

- ⚠️ **The sign-in return parks a path and its query — never a fragment, never on a sign-out — and honours only a same-origin relative path.** Since CK-79 `RequireAuth` parks `location.pathname + location.search` (`lib/returnPath.ts`) before its unchanged redirect to `/`, and `AuthCallback` navigates there after the magic link. Three rules, each with the defect it prevents. **(1) Never the fragment**: this app carries tokens in fragments — the sign-in link, both invitation links, the group's link — so a parked fragment would put a bearer credential in storage for half an hour and hand it to whoever signs in next; `parkReturnPath` drops anything from `#` on, and a stored value carrying one is refused on the way out. **(2) Never on a sign-out or a 401 that ends a session**: the guard parks only when `AuthState.signedOutSinceLoad` is true — this page load has been signed out since its auth state first settled and never signed in, derived during render in `AuthProvider` — because the page a signed-in person was on when their session ended is theirs, and the next person to sign in on a shared device must land on Home, not on it; `signOut` clears whatever is parked. A stored session that fails its FIRST check counts as a signed-out visit and does park — a choice, reversible in one line. `signedOutSinceLoad` is optional on `AuthState`, so a hand-built test context parks nothing: **a test of the return renders the real `AuthProvider`** (the CK-76.1 Gotcha, again). **(3) Only a same-origin relative path reaches `navigate()`**: exactly one leading `/`, no backslash, no control character or space, no fragment, at most 2,000 characters, resolving to its own origin — validated at park AND at take, because whatever wrote storage is not to be trusted, and `//evil.example` is another host to a browser (an open redirect). Fresh is 30 minutes (`RETURN_PATH_TTL`). A new landing screen that sends a person to sign in parks its own address on the way (`/groups/join`, `/groups/invitations/accept`, `/invitations/accept`); never park anything a person did not open. (CK-79.)

- ⚠️ **A wholesale replacement — delete, then insert — is not atomic under READ COMMITTED: two writers each delete only what they can see and insert beside each other, giving a unique violation, a union of two lists, or a case twin. Make the writers take turns on the parent row (`SELECT … FOR UPDATE OF` the parent, `_review_row`'s shape), or check that something already does (`put_rsvp`'s own UPDATE). And a single-use token is consumed by a guarded `UPDATE … WHERE consumed_at IS NULL` with its rowcount checked, never by assigning the attribute on a row read earlier: read-then-assign lets two requests at once both redeem it.** Both halves were live until CK-77.2. **(1)** `api/media.py::patch_media` took no lock before its `delete(MediaTag)` + inserts, so two tag saves at once each deleted nothing of the other's (the other's rows were uncommitted, invisible to the delete's snapshot and not blocking it) and then inserted beside each other: an identical list met `uq_media_tags_media_id_tag` when the first committed — a 500; two different lists stored their union; `Tommy` beside `tommy` stored the case twin `scripts/verify_schema.py` forbids. No `INSERT … ON CONFLICT` can make a replacement atomic (the problem is the rows the delete cannot see, not the insert), so the only fix is taking turns on the parent row — `.with_for_update(of=Media)` on the route's own SELECT, the lock `_review_row` has taken since CK-43 for the same reason — after which the second save waits, deletes what the first committed, and its whole list holds. Before adding a lock, check whether a write on the parent already runs first: `put_rsvp` writes the RSVP row itself (the INSERT and flush on a first answer; `updated_at`, always stamped, on a change — autoflushed by the companions' delete), so `_replace_companions` was serialised all along, and the worker's derivative replacement runs behind `_settle`'s guarded UPDATE on the media row. **(2)** `api/auth.py::verify` did `row.consumed_at = now` on the token row it had read: two openings of one link at once both read it unconsumed, both assigned, both minted a session — a double click on an email that says the link can be used once. A guarded `UPDATE … SET consumed_at = now WHERE id = :id AND consumed_at IS NULL AND expires_at > now`, its rowcount checked BEFORE anything is looked up or written, makes the second opening wait on the first's row lock, re-evaluate, find the stamp set and answer the uniform error (a return without a commit rolls the stamp back with the session, so a refusal after the consume leaves the row as it was). Five more consumes still read-then-assign — the email change, both invitation accepts (whose double tap CK-77.1's backstop catches one step later), the two passkey challenges — enumerated in CK-77.2's report and the planning session's. **(3)** Test either by STAGING, never by timing (`tests/test_double_requests.py`): a consume race with `_stage` after the token's SELECT; a replacement race with a HELD competitor — a second session that locks, deletes, inserts and flushes without committing while the route runs as a task, committed when a third connection sees the route's ungranted lock in `pg_locks` (bounded, no fixed sleep); a competitor committed before the delete is simply deleted by it and shows nothing. (CK-77.2.)
- ⚠️ **A race backstop's `try` must enclose every statement from the first conflicting write to the commit, because autoflush raises the conflict at the next `execute` — or the write is an `INSERT … ON CONFLICT` and needs no backstop. And never read an ORM object after `db.rollback()`: a rollback expires everything, even with `expire_on_commit=False`, and on an async session any read of an expired object raises `MissingGreenlet`, its id included; `ctx.person` lives in the request's session, so copy `ctx.person.id` to a local before any write that might roll back.** The shape, repeated since CK-25: check whether the row exists, write it, commit, and on the `IntegrityError` a concurrent request's commit causes, roll back and answer the idempotent outcome. Six sites did it and every one answered 500 instead, for one reason or both. **(1)** SQLAlchemy flushes pending adds before the next `execute` — a `delete`, an `INSERT … SELECT`, any statement — so a route that adds a row and then runs one more statement before `db.commit()` meets the unique violation AT THAT STATEMENT, and a `try` around the commit alone never sees it (`put_place` from CK-77, reproduced on the deploy 2026-10-25; the two group admissions, whose newcomer helper's first statement flushed the membership add). Either the `try` starts at the first conflicting write, or the write cannot conflict: `put_place` writes both rows `ON CONFLICT` since CK-77.1 and has no backstop at all. **(2)** `app/db.py` sets `expire_on_commit=False`; that governs COMMITS. `rollback()` expires every object in the session unconditionally, and an expired attribute on an `AsyncSession` object is a lazy load that cannot run outside a greenlet — `row.id` raises `MissingGreenlet` as surely as a relationship would (proved on the dev DB, 2026-10-24). `get_auth_context` loads the `Person` through `Depends(get_db)` and FastAPI caches that dependency per request, so the route's `db` and `ctx.person` are ONE session, and `ctx.person.id` after a rollback raises too. A backstop works from plain values captured before the write — a path parameter, `person_id = ctx.person.id` at the top of the handler — or reloads by one (`await db.get(Model, captured_id)` issues its own SELECT, an expired identity-map entry included). **(3)** Test a race by STAGING it, never by timing two requests: the competitor commits from a second session after the route's existence check and before its first flush (`tests/test_race_backstops.py::_stage`, on the route's own statements); staged at the commit the two block each other on the unique index, and the autoflush defect never shows. Nothing is lost on either defect — the first request's write stood — but the second caller was told something had failed that had worked; the likeliest real case is a double tap on a slow phone. (CK-77.1.)
- ⚠️ **Who sees a gathering is decided by rows the host controls — never by keeping, and never by membership at read time; a place row grants nothing until a read path opts in, and `left_out` is opted into by nothing.** From CK-49b to CK-77 the resolved keeper was a term of every read — `resolved_keeper_of` in the detail's loader, `keeps_gathering` in the list's statement and `_visible_media`'s `live` branch — because the cutover swapped the kept relation for the column and kept the audience the relation had given. Keeping is holding photographs in your space and nothing else (keeping-explained §5.11, Steven 2026-10-24): in a family group the keeper is often the very person a surprise is for, and a group can be kept by someone outside it (CK-75), so since CK-77 no audience criterion names `keeper_account_id` or the resolver, and the keeper is still charged for every photograph in what they keep (`_enforce_limits`, `account_usage` — the quota path, untouched). Four rules. **(1)** A read path admits a caller through `_gathering_for_invited` (the host, a co-host, an invitation row) or `_gathering_for_memory` (that, or a `shared_with` row in `gathering_member_places`) and through nothing else; `keeps_gathering` stays in `services/keeping.py` with no caller, for the storage screen — a listing of what is charged — and `tests/test_member_places.py` fails if a router names it or if any router but `api/media.py` names `resolved_keeper_of`. **(2)** The two places that are not *invited* are rows in a SIBLING relation, never a `kind` on `gathering_invitations`: every check that reads the invitation row means *invited* and stayed correct by construction, and a place row is read by nothing until a read path opts in — `shared_with` by exactly the memory loader and the `live` media branch, `left_out` by nothing. Do not add a kind column, and do not make a surface compute a place from membership — a member's place is a row (`place_group_members` at create, `invite_newcomer_to_upcoming_gatherings` at join, the places route), so leaving and removal change nothing (the archive record §6.1). **(3)** The memory view withholds with NULL — `occurrences`, `rsvp_list_visibility`, `next_occurrence`, `occurrence_count` — never `[]` or 0, which would claim a gathering with no dates (the CK-30 precedent). **(4)** A test that seats a keeper who is neither host nor invited expects the stranger's 404, byte-identical, and still asserts the charge — eleven test files had read the keeper as admitted and every one moved at CK-77; `test_media_reads.py`'s `_cast` is the seat's one definition. (CK-77.)
- ⚠️ **A navigation in React Router 7 is a transition; an auth or session change made in the same handler is urgent and renders first, so a guarded route can redirect before the navigation lands — never clear a session in the same tick as navigating away from a guarded route.** `useNavigate()` ends in `MemoryRouter`'s / `BrowserRouter`'s location update, which both wrap in `React.startTransition` (unless `useTransitions === false`), so the new location is low-priority work; `clearToken()` notifies `lib/session.ts`'s listeners and `AuthProvider`'s subscriber calls `setStatus('signedOut')`, an urgent update. React renders the urgent update alone first — the route still the old one — so `RequireAuth` on that route sees signed-out, renders `<Navigate to="/" replace />`, and that navigation supersedes the pending one. From CK-8 to CK-76.1 `Settings.tsx::handleDelete` did exactly this — `navigate('/account-deleted')` then `clearToken()`, with a comment promising one batched render — and a person deleting their account landed on the sign-in form at `/` with no explanation (CK-76's observation 1, six samples; CK-75's checks had seen it and could not tell why). The lockfile has carried `react-router` 7.18.2 and React 19.2.8 since CK-6, so the batching was never real: nothing drove the deletion through the real route table with `RequireAuth` until `routes/account-deleted.test.tsx`, whose red run read `/`, the sign-in form and `signedOut`. Three rules. **(1)** A handler on a guarded route that must end the session navigates and does nothing else; the destination — an unguarded route — ends the session once it has rendered, on a one-shot signal carried in the navigation's state (`ACCOUNT_DELETED_SIGNAL`, `lib/accountDeleted.ts`), and spends the signal by replacing the entry's state, so a reload, Back or a later visit finds none; a direct visit to the destination never signs anyone out. **(2)** A signal in navigation state rides the history entry, which outlives the session it ends: it carries no id, no email and no token, ever (pinned as the exact object and by a source scan). **(3)** A test of a flow that crosses a guard renders the REAL route table with the REAL `AuthProvider` over the real session store — a component rendered alone under a fake context value cannot see the ordering, which is how `routes/settings.test.tsx`'s three stayed green beside the defect — and `useTransitions={false}` on the router is not the fix: it would make every navigation urgent to win one race. The same holds for `authFetch`'s 401 rule: a 401 arriving while a guarded route is on screen clears the token urgently and bounces, so the window between a deletion's 204 and the clear must hold no request (the test's server answers 401 to everything after the deletion, and the log holds nothing after `POST /me/delete`). (CK-76.1.)
- ⚠️ **A catch-all route that navigates destroys the address it caught — a fragment-carried token included — so it renders and never redirects; and a backend that mints a URL into a route not yet built says only that the route doesn't exist yet, never where the link lands.** From CK-6 to CK-75.1 `App.tsx`'s last route was `<Route path="*" element={<Navigate to="/" replace />} />`: any address the running bundle had no route for was replaced with `/` — path, query and fragment — and `/` sent a signed-in person on to `/home`. Two faces of one line: a route the deploy did not have yet (CK-75's `/groups/invitations/accept#token=…`, which check `(jo)` watched lose its token on a CURRENT bundle, 2026-10-23) and a route a stale bundle did not have yet (`/plan` typed into an open tab at CK-74's checks showed Welcome until the update notice was taken). Since CK-75.1 the catch-all renders `routes/PageNotAvailable.tsx`, which never navigates, never reads the address, asks the one service-worker owner (`components/AppUpdateProvider.tsx`) for an update once on mount, and offers Reload when a newer version has taken control — the reload loads the same address, fragment intact, and the newer bundle routes it. Three rules. **(1)** The catch-all renders; nothing in it may navigate — no `Navigate`, no `navigate()`, no `window.location` assignment — and nothing in it may read, store, log or show the address (pinned by a source scan with comments stripped; the one `window.location` use is `.reload`). **(2)** A router docstring, a kickoff or a record that mints a URL into a route the frontend has not built says only that the route does not exist yet — never *lands on the not-found screen*, never *the `/plan` precedent*: CK-75's kickoff put that claim in two docstrings and three Hub documents, and the app had no such screen. **(3)** The service worker has ONE owner: `useRegisterSW` is called in `AppUpdateProvider.tsx` and nowhere else (pinned by a glob over every source file), `injectRegister` stays `null`, and a new reader of the update state goes through `useAppUpdate()`. Under tests the plugin's virtual module is aliased to an inert stub (`src/test-support/pwaRegister.ts`) in `vitest.config.ts`, because Vite's import analysis refuses an unresolvable import before any `vi.mock()` can intercept it — mock the id, never import the stub. (CK-75.1.)
- ⚠️ **Checkout's Link is not a payment method the `allowed_payment_method_types` filter governs — and a Stripe parameter's documentation says what a session ACCEPTS, not what Checkout SHOWS.** CK-74.1 sent `allowed_payment_method_types: ["card"]` to turn Stripe Link off, on the strength of the SDK's own words: the key is *a filter on the dynamically computed set of eligible payment methods*, `link` is among its literals, so leaving `link` out would leave Link out. Check `(jh)` on the deploy (2026-10-22) measured otherwise: the filter worked as a filter — Cash App Pay, Klarna and Amazon Pay were gone — and Link stayed whole: the pre-ticked *Save my information with Link for faster checkout* box, the phone-number field beneath it, *By paying, you agree to Link's Terms and Privacy.* and the Link button in the wallet row. Link is a WALLET with a setting of its own — `wallet_options: {"link": {"display": "never"}}` (`SessionCreateParamsWalletOptionsLink.display`, *Specifies whether Checkout should display Link as a payment option*, `auto` or `never`) — which `checkout_url` sends since CK-74.2 beside the filter, the filter now standing as Steven's decision of 2026-10-22 in its own right. Three rules. **(1)** A Checkout change is not done until someone has LOOKED at the sandbox's Checkout page on a fresh throwaway: a probe against the installed SDK proves a parameter exists and what it accepts, never what the hosted page renders. `(jk)` was that look for this one, and it passed on 2026-10-22 — Link gone from Checkout, and *Bank* with it — so the fallback it held ready, the Dashboard's Link switch, was never needed. **(2)** Do not read a payment-method list's literals as the set of things Checkout can show: wallets ride other methods or carry settings of their own — Apple Pay and Google Pay ride `card` and appear in neither list, and Link appears in the `allowed_` list and is governed by `wallet_options` anyway. **(3)** A record that says a surface is off because the code sends a parameter is a claim about the code until a check confirms it on the deploy. CK-74.1's banner, §13 item 7 and DATA-HANDLING said Link was off from the day they were written while the deploy offered it to anyone who pressed Upgrade; CK-74.2 says so beside each of them under new banners rather than rewriting them, and the 1.76.0 entry (in `CLAUDE-history.md` since 1.88.0) stands as written. (CK-74.2.)
- ⚠️ **`/tos` is a living description of what the product stores, and a phase that stores a new kind of data, or changes what deletion does, owes it a NEW version — the pin on a sentence about something not built yet is what kept this one false for six weeks.** `routes/Tos.tsx` is the text the sign-in checkbox records agreement to, by number alone: `TOS_VERSION` on both sides, written into `tos_acceptances` by `api/auth.py::verify` at account creation, and nothing re-asks. From CK-36 (2026-09-09) to CK-73.3 (2026-10-19) it said *"Photo upload doesn't exist yet, so no photos are stored"* while photographs, captions, tags, companions' names, groups, invitees' addresses and passkeys arrived — nine phases stored a new kind of data about a person and none opened the page — and `routes/tos.test.tsx` PINNED the sentence present, so the suite was green the whole time: a test on a claim about what is NOT built passes until the thing is built and then goes on passing, because nothing fails when a negative stops being true. Four rules. **(1)** A phase that stores a new kind of data about a person, or changes what deleting an account leaves behind, amends `Tos.tsx` as a new version: `TOS_VERSION` +1 on both sides, the published terms' number moving up with it, the new text recorded word for word in `decisions/2026-08-31-private-alpha-scope.md` §3.1 beside every earlier one, the tests moved with it. **(2)** Never rewrite the text under an existing number once any account has accepted it — one number means one text, and an acceptance row that names a number must name what its person read — and never narrow the validator's lower bound (`1 <= value <= TOS_VERSION`): a browser still on the old bundle sends the number of the text it showed, and that is the true record. Before the first acceptance a version's text may still change; after it, a change is the next number. **(3)** Pin what the product DOES, and the negation of what the page no longer says — never a sentence about something not built. The version 1 pin stood because the kickoff that built the first photograph had no reason to open a test about a notice; this Gotcha is here so the next one does. (CK-73.3.) **(4)** A sentence that tells a person what they can DO is checked against what the product lets them do — the frontend's own rule, never offer a control the API would refuse, applied to prose. Version 2 as approved said *"Delete them first if you'd rather they went"* of photos AND answers, and no answer can be deleted (CK-27 shipped no RSVP delete, deliberately — an answer can only be changed to *Can't make it*, which clears its companions); its server-log sentence named sign-in links where console mode prints every email the app sends with its address, an invitee's among them. Both were corrected at CK-73.4 under the same number, before any account had accepted version 2 — nothing had been pushed, the case rule (2) allows — and the `no` label the new sentence quotes is read from `lib/rsvps.ts` in the test, so the words and the button cannot drift apart unnoticed. (CK-73.4.)
- ⚠️ **The API process configures ONLY the `covey-keep` logger namespace, never the root, and keeps `propagate` True — and until CK-73.1 it configured nothing, so every INFO line the API ever wrote was dropped.** The worker calls `logging.basicConfig(level=INFO, stream=sys.stdout)` in its own entry point (`app/worker.py::main`), which configures the ROOT; the web service has no entry point of its own — uvicorn imports `app.main` — and nothing in it ever configured logging, so Python's root sat at WARNING with no handler, every INFO record from `covey-keep.billing` (and from any other app logger) was dropped before it reached a stream, and WARNING/ERROR lines surfaced only through Python's last-resort handler on stderr. CK-73's check (iq) looked for the webhook's INFO line in Render's log and found uvicorn's access lines alone — the first time anyone had looked for an API INFO line at all. Since CK-73.1 `app/logging_setup.py::configure_logging`, called once at `app.main`'s import, sets the **`covey-keep` namespace** to INFO with ONE marked handler to stdout in the worker's format, idempotent (a reimport or uvicorn's reloader finds the mark and adds nothing). Two rules bind whoever touches it: **(1) never the root** — a root `basicConfig(level=INFO)` makes every library's INFO line visible too, and the `stripe` and `botocore` INFO lines carry request URLs, which is why storage.py and services/billing.py pin those loggers and why only our own namespace is turned on; **(2) never `propagate = False`** — the suite's `caplog` captures at the root, and CK-73's never-log pins ("no URL, no email, no payload in any log record, with the root at DEBUG") read `caplog.records`, so a namespace that stopped propagating would make every one of them pass VACUOUSLY over an empty list; in production the root has no handler (uvicorn configures only `uvicorn.*`, with `disable_existing_loggers: False`), so nothing is written twice. Two consequences: the worker must never import `logging_setup` (a namespace handler beside its root handler would write every worker line twice — its import graph does not load `app.main`, pinned since CK-59 and re-asserted at CK-73.1), and **turning a line on is a data-handling act** — every INFO-or-above call the web import graph reaches was enumerated at CK-73.1 (nine, all on `covey-keep.billing`, ids and plan names only), and a new logger under the namespace is visible on the deploy the moment it is written. (CK-73.1.)
- ⚠️ **A `StripeObject` is NOT a dict in stripe-python 16 — `.get()` and `.items` raise, and subscript is the one spelling.** The SDK's objects no longer subclass `dict`: at 16.0.0 `sub.get("customer")` raises `AttributeError: 'get' is a dict method, but a Subscription is not a dict`, and `sub.items` is refused the same way — so is any field whose name is a dict method's. Read a field as `sub["items"]` / `sub["customer"]` (a missing field is a `KeyError`) or by attribute where the name is safe (`sub.status`, `sub.id`); `services/billing.py::_field` is the one helper, and it is why `sync_subscription` never spells `.get`. Found by the first probe against the installed SDK, before any test ran — and the trap for a TEST is the mirror image: a stub that hands the upsert a plain `dict` passes where the real object fails, which is why every subscription a test hands it is built with the SDK's own `construct_from`, in the pinned API version's shape. (CK-73.)
- ⚠️ **The lock is universal and must stay so — compile it with `uv pip compile --universal`, never with `pip freeze` or a platform-specific `pip-compile` on Windows, which drops `uvloop` from the Linux deploy.** `uvicorn[standard]` requires `uvloop` only where `sys_platform != 'win32'` (and not on cygwin or PyPy — read from the installed `uvicorn-0.53.0` METADATA), and `pytest` requires `colorama` only ON Windows; a resolve performed on this machine without `--universal` would omit the first and include the second with no marker, and Render would then build without the event loop uvicorn is deployed with — a lock that passes every local check and changes the production runtime. Since CK-72 `requirements.txt` carries environment markers (`uvloop==0.23.0 ; … sys_platform != 'win32'`, `cffi` and `pycparser` excluded on PyPy) so ONE file serves the Linux deploy and the Windows dev machine, and `tests/test_requirements_lock.py` fails if `uvloop` leaves the lock or loses its marker. Two companions: `uv` keeps the versions already in a lock, so a recompile after editing `requirements.in` moves nothing else — a version move is `--upgrade-package <name>`, deliberately, and its own reviewed change — and `requirements.txt` is never edited by hand (the header says how it was made; the test checks the shape of every line). The regeneration commands are in the Commands block. (CK-72.)
- ⚠️ **A fresh database catches the enum-label trap the deploy hides, and the suite's database is fresh: a migration that names a label added by `ALTER TYPE … ADD VALUE` fails the suite even when that label committed on the deploy weeks ago.** 0028's backfill first wrote `WHERE status = 'failed'` — a 0016 `ADD VALUE` label, committed on the deploy and the dev DB since 2026-09-07, where the migration ran clean — and the suite, which builds `covey_keep_test` from 0001 in ONE transaction (`alembic/env.py`'s single `begin_transaction`), failed it with *unsafe use of new value "failed" of enum type media_status*. Measured on PostgreSQL 16.15 (CK-71): a label added by `ADD VALUE` is unusable in the transaction that added it EVEN WHEN the type was created in that same transaction — 0025's docstring calls a fresh database "the one exemption", and it is the opposite: the fresh database is where the trap fires for every label a prior migration added, and what it cannot catch is a label whose `ADD VALUE` already committed locally; the labels of a type CREATED in the transaction are fine (made by `CREATE TYPE`, not `ADD VALUE`), and a text cast over the column reads existing rows without constructing any label. Two consequences: a migration that must read or write an existing enum label a prior migration added compares `column::text` (0028's `status::text = 'failed'` is the same rows as `status = 'failed'`), and "the suite passed, so the deploy will" and "the dev DB upgraded, so the suite will" are each wrong in one direction — run the suite AND an upgrade of the dev DB before calling a migration clean. (CK-71.)
- ⚠️ **Pillow names a JPEG that carries a second image `MPO`, not `JPEG`: a format allowlist must list the real names a content type can arrive as, never the names alone.** Some JPEGs carry more than one image — the Multi-Picture Format (MPF, CIPA DC-007), which phones write to embed an HDR gain map or a portrait depth map after the photograph — and Pillow's JPEG opener hands such a file back as `MpoImageFile` with `format == "MPO"`. `DECODABLE_FORMATS` listed `JPEG` alone from CK-36 to CK-70, so an ordinary iPhone JPEG (`IMG_1721.jpeg`, 2026-09-30) passed the intent's `image/jpeg` and dead-lettered at the decoder — the allowlist and the decoder disagreeing, which CK-36's pin exists to prevent and could not see, because it pinned the NAMES the two lists spelled rather than what a phone writes under an admitted type. Since CK-70 the set is `{JPEG, MPO, PNG, WEBP, HEIF}`, enumerated from the INSTALLED Pillow and pillow-heif (`tests/test_processing.py` decodes a sample per name, each first shown to carry it), and the decoder renders frame 0 only — nothing in `processing.py`'s code may name `.seek(` (pinned); the file's other images are dropped by the rule that drops every other embedded byte, and an HDR gain map is not applied. Three facts travel with it: Pillow 12.3.0 reports an Android Ultra HDR JPEG (MPF plus an `hdrgm` XMP) as plain `JPEG`, base image only, and a later Pillow that names it `MPO` lands in the same set with the same outcome; Pillow's native AVIF plugin also accepts a `mif1`/`msf1`-branded HEIF, but its factory raises `SyntaxError` on one, so `Image.open` moves on to pillow-heif whatever the registration order (in the worker's process `HEIF` is registered first regardless, because `processing.py` registers it at import); and a dead-lettered row is terminal — its original went at the dead-letter — so the person uploads again and nothing revives it. To widen the set again, enumerate from the installed libraries (CK-70's report carries the script), never from memory. (CK-70.)
- ⚠️ **botocore reports a HEAD's error as the bare numeric status and a GET's as the named S3 code — a classifier evaluated on a HEAD must handle both, and `_is_credential_rejected` is the one place that knows it.** An S3 error is named from the XML body and a HEAD response has no body, so botocore synthesises `Error.Code` from the status: against one rejected credential in one process, `head_object` → `'401'`, `get_object` → `'Unauthorized'`, `head_bucket` → `'401'`, `list_objects_v2` → `'Unauthorized'` (check (gv), 2026-09-25; `RestXMLParser._parse_error_from_http_status` is the line). The ingest ladder's first store call is a HEAD, so from CK-35 to CK-60 `CREDENTIAL_REJECTED_CODES` — named forms only — could not match a rejected credential on the read path, the release never fired, and a mistyped key id would have dead-lettered every queued row in about twenty-one minutes; `_ABSENT_CODES` seventeen lines away had carried both forms for exactly this reason. Since CK-61 all three sites (read, write, destroy) ask `services/ingest.py::_is_credential_rejected(exc)`: the named set OR an HTTP status of 401/403 read from `ResponseMetadata.HTTPStatusCode`. **The set stays named-only — never add `"401"`/`"403"` to it**; a third classifier calls the helper or reads the status the same way, and never copies the mixed `_ABSENT_CODES` (annotated as the superseded form and left exactly as it is). **`'400'` is excluded deliberately**: a key id of the wrong LENGTH draws `InvalidArgument` / 400 because R2 length-validates before it authenticates, and that is a malformed request, not a credential fact — admitting 400 would release every genuinely bad request forever. That case is caught at boot instead: **an R2 access key id is exactly 32 hexadecimal characters, and all three (`R2_UPLOAD_*`, `R2_SERVE_*`, `R2_WORKER_*`) are shape-validated in `config.py` since CK-61** — a wrong-length or non-hex id refuses to boot naming the field and the length, never the value; the secrets are deliberately NOT shape-checked (their format is unmeasured). Two consequences: a local placeholder for a key id must be 32 hex (thirty-two zeros boot; `'placeholder'` and `replace-me` no longer do), and **a test that stubs a `ClientError` with a named code proves nothing about a HEAD** — build it with `tests/test_worker.py::_botocore_error`, which runs botocore's own parser over a raw response. (CK-61.)
- ⚠️ **`last_error` means "why this row is not progressing RIGHT NOW" — narrower than the column's name — and a released row now says so.** Since CK-57 every outcome on both ladders overwrites or clears it: the retry text while a row waits on a backoff, the dead-letter text when it is dead, `ERROR_CREDENTIAL_REJECTED` when the worker's credential was refused, NULL when nothing is wrong. Read it as *the last thing that ever went wrong* and you will misdiagnose a row — and before CK-57 that reading was the only one available, because `_release_misconfigured` settled `status` and `claimed_at` alone, so a stale reason from an earlier transient failure survived a release with nothing to say it was stale. The one lag is a HELD row (`claimed_at` set): the claim writes nothing, so the column shows what the row was waiting on before the claim until the outcome replaces it — which is why both verifier lines on it exclude held rows. It is OPERATOR-ONLY: never in an API body (`_media_body` omits it on purpose), read by the worker's log lines and a person in psql; never put it in a response. And *untouched* in the release class names `attempts` and `available_at` — the penalty half — and not this column. (CK-57.)
- ⚠️ **`api/media.py` must never import `services/ingest.py`, and `services/destruction.py` must never import `ingest`, `processing`, `storage` or botocore.** `ingest.py` imports `processing.py`, and `processing.py` is Pillow and pillow-heif — a codec stack the web process never executes. CK-58 added `from app.services import ingest` to the router for one function and, unmeasured, put 21 PIL modules and pillow-heif into every API worker's import graph; CK-59 moved that function (`mark_for_destruction`) and the sweep beside it into `services/destruction.py`, which needs the models and sqlalchemy alone, and the API imports THAT. The boundary follows the caller set — what the API and the worker both call lives in `destruction.py`; what only the worker runs (`handle_destroying`, the claim, the store calls) stays in `ingest.py`, which re-exports `mark_for_destruction` so the ladder reads whole. Check it the way CK-59 did, not by grep: `import app.main` then assert `app.services.processing`, `app.services.ingest` and every `PIL.*` are absent from `sys.modules`. A constant wanted on both sides goes in `destruction.py` or `retention.py` (`REMOVED_BIN`'s home), never in `ingest.py`. (CK-59.)
- ⚠️ **The bin sweep ships OFF, and a switch turned on before 2026-10-14 sweeps nothing.** `WorkerSettings.sweep_enabled` defaults to `False` and `render.yaml` says `"false"`; the sweep runs only when the worker's dashboard holds `SWEEP_ENABLED=true`, and it marks only rows whose `removed_at` is at or past `now − REMOVED_BIN` (30 days). The two deployed decline rows were removed on 2026-09-14, so their window closes on **2026-10-14** — a sweep enabled earlier logs nothing until then, and that silence is not a failure. When they go, the `ZZ CK-43 gated subject` counters drop by exactly two rows' worth and `media` keeps its count (the rows survive at `destroyed`, words and all). (CK-59.) **Amended at CK-73.2 (2026-10-19): `(gt)` passed on 2026-10-19 — the capture first, the switch second, both rows destroyed as predicted — and `render.yaml` now says `"true"`, so a Blueprint sync can no longer put the dashboard back to off; the code default stays `False`, so a local worker and the suite are still dark, and the sentence above stands as the history of the dark shipment.**
- ⚠️ **The deployed artifact must be a function of the commit — and until CK-60 it was not.** `requirements.txt` left `fastapi`, `uvicorn`, `sqlalchemy`, `asyncpg`, `alembic`, `pydantic-settings` and `tzdata` unpinned; both services build with `pip install -r requirements.txt`, which re-resolves against PyPI on every build; there is no lockfile. So SQLAlchemy moved 2.0.54 → 2.1.0 between CK-56's deploy and CK-58's with no commit behind it — a release whose Linux wheel had been on PyPI for under two hours — and (gm), which compared the two deploys and called the extraction clean, was comparing two changes while able to see one. **Never infer "the diff did this" from two deploys until both build logs' `Successfully installed` lines agree with each other and with the file**; a green verifier proves the state, not the cause. Since CK-60 the seven are pinned exactly and **SQLAlchemy is held at 2.0.54 deliberately, one minor behind the last resolve** — the version every real destruction and the 187 → 190 verifier work ran under; bumping to 2.1 is its own reviewed change with its own checks, never a "while we're here". **Two things still float**: the transitive tree (`greenlet`, `starlette`, `mako`, `pydantic-core` and the rest re-resolve every build — a lockfile plus a changed `buildCommand` is owed and is Steven's decision), and the LOCAL venv, which no pull rebuilds — it had run 2.0.52 since 2026-08-18, a version neither deploy ever carried, so **after any change to `requirements.txt`, `pip install -r requirements.txt` in `backend/.venv` before trusting a green suite, and record which versions it ran against**. `alembic` is the sharpest of the seven: the pre-deploy runs it against the live database while the old instance still serves. (CK-60.) **⚠️ AMENDED at CK-72 (2026-10-11) — the two floating things named above are fixed, and the sentences stand as history.** `requirements.txt` is now the universal, hash-checked LOCK compiled from `requirements.in` against Render's verified installed set for `e2e48b0` (CK-71): `greenlet`, `starlette`, `mako`, `pydantic-core` and every other transitive package are a function of the commit, each with its hashes, and both services' `Successfully installed` lines must match the lock exactly (check (il) — a moved version there is a stop, never a reason to re-lock). The local venv is rebuilt from the two locks — `pip install -r requirements.txt -r requirements-dev.txt` into a fresh venv — so the suite runs on the deploy's tree: CK-72's rebuild moved seventeen packages the venv had carried since 2026-08-18 (`starlette` 1.6.0 → 1.7.0, `greenlet` 3.5.5 → 3.5.6, `pydantic-core` 2.46.4 → 2.50.0 among them) with every direct pin unchanged. `render.yaml`'s build command did not change, because the lock IS `requirements.txt`; `uv` is the compiler and a dev tool only. (CK-72.)
- ⚠️ **`claimed_at` means "a worker holds this row" on BOTH ladders, not just `processing`.** `_claim` (`app/services/ingest.py`) stamps it unconditionally, because a destroy job is claimed IN PLACE — `destroying` is both the queue and the claim, so the rung does not move when a worker takes one. A `destroying` row therefore carries a stamp while it is held and has none when it is freshly marked or has dead-lettered, which makes "set iff `processing`" false and NOT repairable as an iff on that rung. The verifier asserted the iff until CK-56 and read 189/1 on any held destruction — a ≈543 ms window per row, so five runs missed it, but a stalled claim needs a live worker to clear it and Phase B's sweep makes the window routine. Tell a claim from a dead-letter by `claimed_at`, never by the rung: "the rung is `failed`" is true on the ingest ladder alone. (CK-56.)
- ⚠️ **`PUBLISHED_PREFIX = "media/"` (`app/services/storage.py` l.159) — the constant's NAME says published and its VALUE does not.** `published` is the BUCKET (`R2_BUCKET_PUBLISHED`); `media/` is the key prefix inside it, so a published object's key is `media/<media_id>/<layer>` — never `published/…`. The quarantine side has the same shape (`QUARANTINE_PREFIX = "uploads/"`: an original's key is `uploads/<media_id>`), and the one home for both layouts is `storage.quarantine_key` / `storage.published_key`. This cost CK-54's dev-deploy verification a check written against the wrong path. Read a key layout from those two functions, never from a bucket's name. (CK-55.)

## Directory map

```
covey-keep/            # the code root (this repo)
├── frontend/          # Vite + React + TypeScript PWA (vite-plugin-pwa, react-router-dom); Netlify builds it
│   ├── .gitignore         # Vite's stock ignores (node_modules, dist, editor files)
│   ├── .nvmrc             # Netlify's Node version, exact (22.23.4); moving it is a reviewed one-line change
│   ├── .oxlintrc.json     # oxlint: rules-of-hooks and only-export-components
│   ├── README.md          # install, run and build
│   ├── index.html         # the app shell; its %PRODUCT_NAME% title is filled at build by vite.config.ts's brandTitle
│   ├── package.json       # scripts (dev, build = tsc -b && vite build, lint = oxlint, test = vitest run) and dependencies
│   ├── package-lock.json  # npm's lockfile; generated, never edited by hand
│   ├── tsconfig.json      # references the app and node configs
│   ├── tsconfig.app.json  # compiler options for src/
│   ├── tsconfig.node.json # compiler options for the Vite config files (nodenext)
│   ├── vite.config.ts     # React, brandTitle and VitePWA (autoUpdate); injectRegister MUST stay null — the provider owns registration
│   ├── vitest.config.ts   # jsdom; aliases virtual:pwa-register/react to the test-support stub (no PWA plugin under tests)
│   ├── public/            # static files served as they are
│   │   ├── favicon.svg # the favicon
│   │   └── icons.svg   # an SVG symbol sprite from the Vite scaffold
│   └── src/               # the application; each test sits beside its subject (*.test.ts, *.test.tsx)
│       ├── main.tsx       # the entry: StrictMode, BrowserRouter, AuthProvider, App
│       ├── App.tsx        # the route table inside AppUpdateProvider, with PwaUpdatePrompt; `*` renders PageNotAvailable, never a redirect
│       ├── App.css        # the app's plain styles; theming is a later phase
│       ├── index.css      # the base reset and body font
│       ├── vite-env.d.ts  # type references for Vite and vite-plugin-pwa
│       ├── brand.ts       # PRODUCT_NAME and TAGLINE — the only frontend home for user-visible brand strings
│       ├── brand.test.tsx # pins the heading, tagline and title to brand.ts
│       ├── auth/          # session state
│       │   ├── AuthContext.tsx # AuthProvider: the session, signIn/signOut, the /auth/me load, signedOutSinceLoad; signOut clears the sign-in return
│       │   ├── context.ts      # the AuthState and Person types and the context object
│       │   └── useAuth.ts      # the useAuth() hook
│       ├── components/    # shared components and the app-update provider
│       │   ├── AppUpdateProvider.tsx # THE one owner of the service worker: useRegisterSW exactly once; hourly and on-visible checks
│       │   ├── appUpdate.ts          # the update-state context and its type
│       │   ├── useAppUpdate.ts       # useAppUpdate(), every reader's hook
│       │   ├── PwaUpdatePrompt.tsx   # the update notice (Reload, Not now), a reader of the provider
│       │   ├── app-update.test.tsx   # one registration owner in the tree, the notice, the checks
│       │   ├── RequireAuth.tsx       # route guard: signed out goes to `/`; parks path + query (never the hash) as the return only if signedOutSinceLoad
│       │   ├── FieldError.tsx        # FieldError and FormLevelErrors: the 422 mapper's rendering half, role="alert"
│       │   ├── PasskeySection.tsx    # Settings' passkey list: add and remove; quiet, never promoted
│       │   └── GatheringMedia.tsx    # the Photos section: upload, list, words and search, the host's review, both bins, failed rows
│       ├── lib/           # API types, calls, copy and helpers, one module per subject
│       │   ├── api.ts                # API_URL, apiFetch, authFetch (a 401 clears the session); TOS_VERSION = 2, never renumbered
│       │   ├── session.ts            # the session token in localStorage
│       │   ├── timezone.ts           # IANA zone helpers: zone names, never offsets
│       │   ├── datetime.ts           # wall clock ↔ instant in an explicit IANA zone (the profile zone); formatDay
│       │   ├── datetime.test.ts      # conversions against a zone forced to differ from the runner's
│       │   ├── formErrors.ts         # the one path from a 422 body to inline field errors, with each field's error type
│       │   ├── formErrors.test.ts    # the mapper: loc to field, form-level fallbacks, error types
│       │   ├── url.ts                # safeHttpUrl: the render guard for user-controlled URLs, http and https only
│       │   ├── url.test.ts           # the guard against the backend validator's hostile set
│       │   ├── accountDeleted.ts     # ACCOUNT_DELETED_SIGNAL: the one-shot navigation state that lets /account-deleted end the session
│       │   ├── invitations.ts        # gathering-invitation types and the token parked across the sign-in round trip
│       │   ├── gatherings.ts         # gathering types and labels; roleFlags and viewOf, the one reads of the role and the view
│       │   ├── gatherings.test.ts    # roleFlags and viewOf gate closed on anything unknown
│       │   ├── places.ts             # a member's place on a group's gathering: the three labels, readPlaces, setPlace, placesBody
│       │   ├── places.test.ts        # the three words; everyone Invited sends neither list
│       │   ├── coHosts.ts            # co-host types, the add and remove calls, and their copy
│       │   ├── coHosts.test.ts       # each call answers the code, never the wording; the copy
│       │   ├── rsvps.ts              # RSVP types, labels, companions and totalGoing; arrival time is a bare clock time, never zone-converted
│       │   ├── rsvps.test.ts         # arrival time under a zone forced to differ from the runner's
│       │   ├── groups.ts             # group types, calls and copy; groupRoleFlags (isAdmin, organises), the one read of the role
│       │   ├── groups.test.ts        # the flags, every call's codes, the copy
│       │   ├── groupJoining.ts       # joining's calls, parked tokens and copy; the link's URL lives in share's closure and nowhere else
│       │   ├── groupJoining.test.ts  # no property holds the URL; the device is called inside the click
│       │   ├── returnPath.ts         # the sign-in return: a same-origin relative path, never a fragment, fresh for 30 minutes
│       │   ├── returnPath.test.ts    # every hostile path refused at park and at take
│       │   ├── media.ts              # media types, the upload and read helpers (a presigned URL never leaves its call), every photo state's copy
│       │   ├── media.test.ts         # the HEIC fallback, the state lines, the upload helpers
│       │   ├── media-words.test.ts   # size from the File, the trimmed filename, the caption and tags patches
│       │   ├── media-review.test.ts  # the waiting line from each seat, the review calls and refusal lines
│       │   ├── media-bin.test.ts     # the bin acts, their refusal lines, the days-left count
│       │   ├── media-failure.test.ts # each failure reason's line and retry
│       │   ├── billing.ts            # the plan screen's types, the Checkout and portal acts (the URL followed inside the call) and its copy
│       │   ├── billing.test.ts       # every number from the body; the URL never returned
│       │   └── passkeys.ts           # WebAuthn ceremonies and usernameless sign-in
│       ├── routes/        # one screen per route in App.tsx's table, tests beside them
│       │   ├── SignIn.tsx                   # `/`: the magic-link form with the private-test consent checkbox, and Use a passkey
│       │   ├── AuthCallback.tsx             # `/auth/callback`: the session from the fragment, then the sign-in return, a parked invitation or /home
│       │   ├── Home.tsx                     # `/home`: links to groups, gatherings and settings; sign out
│       │   ├── Gatherings.tsx               # `/gatherings`: the list, its empty state, Try again
│       │   ├── GatheringNew.tsx             # `/gatherings/new`: the gathering form; with inGroup, a group's form with Who it's for
│       │   ├── GatheringDetail.tsx          # `/gatherings/:id`: view and edit, dates, RSVP, Photos, places, invitations, co-hosts; the photos-only view
│       │   ├── Groups.tsx                   # `/groups`: your groups
│       │   ├── GroupNew.tsx                 # `/groups/new`: one Name field and no type control
│       │   ├── GroupDetail.tsx              # `/groups/:id`: rename, gatherings, members and their acts, requests to join, invite people, leave
│       │   ├── GroupGatheringNew.tsx        # `/groups/:id/gatherings/new`: reads the group and its members, then GatheringNew with inGroup
│       │   ├── GroupJoin.tsx                # `/groups/join`, signed in or out: the link's landing; asking to join is a press, never an opening
│       │   ├── GroupInvitationAccept.tsx    # `/groups/invitations/accept`: an emailed group invitation's landing; opening accepts
│       │   ├── InvitationAccept.tsx         # `/invitations/accept`, signed in or out: a gathering invitation's landing; accepts when signed in
│       │   ├── Settings.tsx                 # `/settings`: profile, Your plan, sign-in email, passkeys, deleting the account (whose 204 only navigates)
│       │   ├── Plan.tsx                     # `/plan`: the current plan, usage, the other plans, Checkout's return wait
│       │   ├── Tos.tsx                      # `/tos`: the private test notice, version 2 — a living description of what is stored (the Gotcha)
│       │   ├── EmailChangeResult.tsx        # `/email-change`: an email-change confirmation's outcome
│       │   ├── AccountDeleted.tsx           # `/account-deleted`: ends the session once rendered, on the deletion's one-shot signal alone
│       │   ├── PageNotAvailable.tsx         # `*`: keeps the address, reads nothing from it, offers Reload when a newer version waits
│       │   ├── account-deleted.test.tsx     # the deletion through the real route table lands on /account-deleted, then signs out
│       │   ├── co-hosts.test.tsx            # the role from caller_role; co-host management from both seats
│       │   ├── gathering-in-group.test.tsx  # a group's gathering: the photos-only view, Who it's for, the prompt to share
│       │   ├── gatherings.test.tsx          # the list, the form, the detail, editing, the host's switch
│       │   ├── group-detail.test.tsx        # a group's page by role: members, requests, invites, gatherings
│       │   ├── group-gathering-new.test.tsx # the group form and its exact create body
│       │   ├── group-invitation-accept.test.tsx # the emailed group invitation's landing
│       │   ├── group-join.test.tsx          # the link's landing: nothing sent before the press
│       │   ├── groups.test.tsx              # Home's link, the list, starting a group
│       │   ├── invitations.test.tsx         # a gathering invitation's landing and the host's invite form
│       │   ├── media-bin.test.tsx           # your own photographs: Send to bin, Put back, Delete permanently
│       │   ├── media-failure.test.tsx       # a failed row's line and controls by reason
│       │   ├── media-gathering-bin.test.tsx # Remove from gathering and the Removed view, host and co-host
│       │   ├── media-photos-only.test.tsx   # the Photos section with no upload and the dates withheld
│       │   ├── media-review.test.tsx        # the queue, publish, decline, the batch, the strand rule
│       │   ├── media-words.test.tsx         # the caption and tags editor, and search
│       │   ├── media.test.tsx               # the upload surface: the states, HEIC, a refused video, no presigned URL outside its fetch
│       │   ├── page-not-available.test.tsx  # the catch-all keeps the address
│       │   ├── plan.test.tsx                # the plan screen in every state
│       │   ├── rsvps.test.tsx               # the RSVP block, companions, arrival time
│       │   ├── settings.test.tsx            # Settings' Your plan section
│       │   ├── sign-in-return.test.tsx      # the sign-in return through the real route table
│       │   └── tos.test.tsx                 # the notice's load-bearing statements and TOS_VERSION
│       └── test-support/  # files only the test suite loads
│           └── pwaRegister.ts # the inert virtual:pwa-register/react the tests resolve to; never imported by app code
├── backend/           # Python 3.13 + FastAPI; Render builds both services from it, the API and the worker
│   ├── .env.example         # every environment variable, placeholders in the shapes the boot checks require
│   ├── README.md            # install and run
│   ├── alembic.ini          # Alembic's configuration
│   ├── pytest.ini           # asyncio auto mode on one session-wide event loop
│   ├── requirements.in      # THE file a person edits: the direct runtime requirements, every line `==`
│   ├── requirements.txt     # GENERATED: the universal, hash-checked lock both services install; never edited — compile it from requirements.in
│   ├── requirements-dev.in  # the dev tools a person edits (pytest, pytest-asyncio, httpx, uv), constrained to the runtime lock
│   ├── requirements-dev.txt # GENERATED: the dev lock; never edited — compile it from requirements-dev.in
│   ├── app/                 # the FastAPI application and the ingest worker
│   │   ├── __init__.py      # __version__, carried in the outbound email User-Agent
│   │   ├── main.py          # the FastAPI app: CORS, GET /health, the 13 routers, configure_logging() at import
│   │   ├── logging_setup.py # the API's logging: the covey-keep namespace at INFO to stdout; never the root, propagate kept True (the Gotcha)
│   │   ├── worker.py        # the worker (python -m app.worker [--once]): WorkerSettings only; claims, processes, destroys, sweeps when on
│   │   ├── brand.py         # PRODUCT_NAME and FROM_DISPLAY_NAME — the only backend home for user-visible brand strings
│   │   ├── config.py        # Settings (the API's) and WorkerSettings (six required + SWEEP_ENABLED); key shapes checked at boot
│   │   ├── db.py            # the async engine and session factory (expire_on_commit=False)
│   │   ├── security.py      # token hashing, the stdlib HS256 session JWT, the group link's derived token (never stored)
│   │   ├── api/             # the routers, registered in main.py
│   │   │   ├── __init__.py          # empty package marker
│   │   │   ├── deps.py              # get_db and get_auth_context: every endpoint's auth gate; slides the session
│   │   │   ├── auth.py              # /auth: request-link, verify (the one place a person is created), email-change verify, me, logout; mint_session
│   │   │   ├── profile.py           # /me: profile, email change, delete (anonymization, never cascade; Stripe first)
│   │   │   ├── passkeys.py          # /me/passkeys enrolment and usernameless /auth/passkey sign-in
│   │   │   ├── gatherings.py        # gatherings and occurrences, the two read tiers, caller_role and caller_view, places; is_host, may_administer
│   │   │   ├── invitations.py       # gathering invitations: create, list, revoke, preview, accept; members_only on a group's gathering
│   │   │   ├── rsvps.py             # an occurrence's RSVP: the upsert with named companions and the filtered list; no delete, by design
│   │   │   ├── media.py             # uploads, reads, words, review, bins, dismiss; _visible_media the one audience; never imports services/ingest.py
│   │   │   ├── co_hosts.py          # co-hosts: the host makes and removes them, a co-host steps down, the organisers read the list
│   │   │   ├── groups.py            # groups: create, read, rename, members, co-admins, leave, remove, hand over; all on the person spine
│   │   │   ├── group_links.py       # the group's link (derived, never stored), joining through it, approving and declining requests
│   │   │   ├── group_invitations.py # emailed group invitations; acceptance admits directly
│   │   │   └── billing.py           # GET /billing, checkout, portal, the Stripe webhook; never imports stripe itself
│   │   ├── services/        # logic the routers and the worker share
│   │   │   ├── __init__.py    # empty package marker
│   │   │   ├── billing.py     # THE one module that imports stripe: sessions, fetch-and-upsert, close_customer; stripe logger at WARNING
│   │   │   ├── destruction.py # mark_for_destruction and sweep_expired_bin; must never import ingest, processing, storage or botocore
│   │   │   ├── email.py       # the two-mode email adapter: console (to the log) or provider
│   │   │   ├── groups.py      # the person-spine group writes: the deletion leg's succession, a group gathering's invitation and place rows
│   │   │   ├── ingest.py      # worker-only: the claim service, the publish transaction, the destruction ladder
│   │   │   ├── keeping.py     # resolve_keeper, keep/unkeep, the quota in photographs, the paid entitlement; never imports stripe
│   │   │   ├── processing.py  # pure: decode, orient, strip all metadata, render three layers (archival 3200 JPEG, web 2560 and thumb 400 WebP)
│   │   │   ├── publication.py # pure: the publication gate's ladder, each answer with its rung
│   │   │   ├── retention.py   # purge_stale, the ephemeral-data reaper (never keyed on consumed_at; PURGE_GRACE > RATE_WINDOW); REMOVED_BIN, 30 days
│   │   │   └── storage.py     # the one home for R2: UploadClient, ServeClient, WorkerClient, presigning, key layouts; a URL is never logged
│   │   └── models/          # SQLAlchemy models, one module per cluster
│   │       ├── __init__.py     # imports every model, so Base.metadata is whole for alembic
│   │       ├── base.py         # Base, the naming convention, the uuid and created_at helpers, db_enum
│   │       ├── enums.py        # every enum and its PostgreSQL type
│   │       ├── account.py      # Account: the supertype every person and organization points at
│   │       ├── auth.py         # magic-link tokens, sessions, email-change requests, WebAuthn credentials and challenges, ToS acceptances
│   │       ├── household.py    # Household and Person
│   │       ├── organization.py # Organization
│   │       ├── group.py        # Group, SubGroup, GroupCoAdmin, GroupInvitationPending, GroupLink (no token column, ever), GroupJoinRequest
│   │       ├── membership.py   # Membership: a person in a group
│   │       ├── capability.py   # RoleLadder, Role and CapabilityProfile (a group type's template)
│   │       ├── gathering.py    # Gathering, Occurrence, the invitation tables, GatheringCoHost, GatheringMemberPlace
│   │       ├── rsvp.py         # RSVP and RSVPCompanion (names, not people)
│   │       ├── media.py        # Media (a photograph and its job), MediaDerivative (one row per layer, no state of its own), MediaTag
│   │       ├── billing.py      # BillingCustomer and Subscription; no allowance column and no is-paid boolean, ever
│   │       ├── consent.py      # ConsentRecord
│   │       ├── attendance.py   # AttendanceRecord: who was actually there
│   │       ├── items.py        # ItemSlot and ItemClaim: what to bring to a date
│   │       ├── post.py         # Post: discussion on a gathering
│   │       └── next_step.py    # the next-step suggestion tables
│   ├── alembic/             # migrations; head 0034, applied by the API's pre-deploy step alone
│   │   ├── README         # Alembic's stock note
│   │   ├── env.py         # the async env; fileConfig keeps app loggers enabled; no include_object hook
│   │   ├── script.py.mako # a new migration's template
│   │   └── versions/      # one file per migration, each with its phase
│   │       ├── 0001_phase_1_spine_with_build_once_columns.py # the Phase 1 spine: people, households, groups, memberships, the content tables (CK-3)
│   │       ├── 0002_auth_tables_and_household_role_ladder.py # magic-link tokens, sessions, ToS acceptances, the household ladder (CK-5)
│   │       ├── 0003_magic_link_tokens_carry_tos_version.py # the accepted ToS version on a magic-link token (CK-6)
│   │       ├── 0004_profile_columns_on_people.py # people.timezone (an IANA name) and people.updated_at (CK-7)
│   │       ├── 0005_anonymization_stamp_on_people.py # people.anonymized_at: deletion is anonymization (CK-8)
│   │       ├── 0006_email_change_requests.py # email_change_requests (CK-9)
│   │       ├── 0007_webauthn_credentials_and_challenges.py # WebAuthn credentials and challenges (CK-10)
│   │       ├── 0008_accounts_gatherings_occurrences_invitations.py # accounts, gatherings, occurrences, invitations; events dropped (CK-12)
│   │       ├── 0009_kept_relation_grace_memorial_admin.py # the keeper lifecycle: grace stamp, memorial CHECK, host claim state (CK-13)
│   │       ├── 0010_updated_at_on_gatherings.py # gatherings.updated_at (CK-16)
│   │       ├── 0011_gathering_invitations_pending.py # pending invitations: channel and destination, hashed tokens (CK-25)
│   │       ├── 0012_rsvp_visibility_and_stay_included.py # rsvps.stay_included and gatherings.rsvp_list_visibility (CK-27)
│   │       ├── 0013_host_account_id.py       # gatherings.admin_account_id renamed host_account_id (CK-28)
│   │       ├── 0014_rsvp_companions_replace_head_counts.py # rsvp_companions replace the head counts; rsvps.updated_at (CK-29)
│   │       ├── 0015_rsvps_cascade_with_their_occurrence.py # an RSVP cascades with its occurrence (CK-30)
│   │       ├── 0016_media_derivatives_job_columns_and_occurrence_label.py # the media ladder, job columns, media_derivatives (CK-32)
│   │       ├── 0017_uploaded_at_stamped_at_confirm.py # media.uploaded_at, stamped at confirm (CK-34)
│   │       ├── 0018_filename_caption_and_media_tags.py # media.filename, media.caption, media_tags (CK-39)
│   │       ├── 0019_requires_approval_inherits_and_ready_rows_go_live.py # requires_approval nullable: NULL inherits (CK-41)
│   │       ├── 0020_publication_stamp.py     # media.published_at and published_by_person_id (CK-43)
│   │       ├── 0021_updated_at_on_groups.py  # groups.updated_at (CK-45)
│   │       ├── 0022_keeper_shape_columns_check_and_backfill.py # owning_group_id, the keeper columns, the CHECK (CK-49a)
│   │       ├── 0023_guarded_rerun_then_drop_kept_gatherings.py # the guarded backfill re-run; kept_gatherings dropped (CK-49c)
│   │       ├── 0024_photo_count_and_keeper_column_indexes.py # gatherings.photo_count and the keeper-column indexes (CK-51a)
│   │       ├── 0025_destruction_rungs.py     # media_status gains destroying and destroyed (CK-54)
│   │       ├── 0026_removed_by_person_id.py  # media.removed_by_person_id: who removed it (CK-63)
│   │       ├── 0027_gathering_co_hosts.py    # gathering_co_hosts (CK-68)
│   │       ├── 0028_failure_reason.py        # media.failure_reason, backfilled once (CK-71)
│   │       ├── 0029_billing_customers_and_subscriptions.py # billing_customers and subscriptions (CK-73)
│   │       ├── 0030_subscriptions_cancel_at.py # subscriptions.cancel_at (CK-73.1)
│   │       ├── 0031_subscriptions_scheduled_plan.py # subscriptions.scheduled_plan and scheduled_plan_at (CK-73.2)
│   │       ├── 0032_group_membership_co_admins_link_and_keeper_backfill.py # co-admins, group invitations, links, join requests (CK-75)
│   │       ├── 0033_index_gatherings_owning_group_id.py # ix_gatherings_owning_group_id (CK-76)
│   │       └── 0034_member_places_invitees_chosen_and_the_backup_column_dropped.py # gathering_member_places, invitees_chosen (CK-77)
│   ├── scripts/             # operator scripts, run from backend/
│   │   ├── verify_schema.py         # the read-only shape and data verifier: head 0034, 361 assertions; run after every migration that reaches Render
│   │   └── verify_r2_credentials.py # proves the R2 credential split against live R2 (one generated object); run from the Render Web Shell
│   └── tests/               # the pytest + httpx ASGI suite; needs the dev DB container up
│       ├── conftest.py                   # sets the environment before app.config loads; drops, recreates and migrates covey_keep_test each run
│       ├── fixtures/                     # test fixtures
│       │   └── media/ # the GPS-bearing photographs the processing and worker tests feed in
│       │       ├── gps-oriented.jpg # a JPEG with a real GPS IFD (a public landmark) and orientation 6
│       │       ├── gps.png          # the same GPS IFD in a PNG
│       │       ├── gps.heic         # the same GPS IFD in a HEIC
│       │       ├── gps-mpo.jpg      # the JPEG's primary frame with a green second image: an MPO
│       │       └── make_fixtures.py # regenerates the four fixtures
│       ├── test_account_deletion.py      # POST /me/delete: anonymization, retained contributions, every deletion leg
│       ├── test_auth.py                  # magic-link sign-in, ToS versions, rate limits
│       ├── test_billing.py               # paid plans, offline: allowance, config shapes, checkout, portal, webhook, deletion's Stripe leg
│       ├── test_brand.py                 # brand strings built from app/brand.py
│       ├── test_co_hosts.py              # every delegable and reserved check by seat; the co-host endpoints
│       ├── test_destruction.py           # remove, destroy, the marking statement, the destruction ladder, the sweep
│       ├── test_double_requests.py       # two identical requests at once get one answer (staged races)
│       ├── test_email_change.py          # email change with proof of control
│       ├── test_failure_reason.py        # failure_reason at every dead-letter, the uploader-only failed row, dismiss
│       ├── test_gathering_bin.py         # the gathering's bin: the removed view, the host's restore and destroy
│       ├── test_gatherings.py            # gathering and occurrence CRUD, the creation transaction, the review switch
│       ├── test_group_gatherings.py      # a group's gathering: create, its invitations, newcomers, members_only, the template rung
│       ├── test_group_invitations.py     # emailed group invitations
│       ├── test_group_links.py           # the group's derived link token and joining through it
│       ├── test_group_membership.py      # members, co-admins, leave, remove, hand over, succession
│       ├── test_groups.py                # create, read and rename a group
│       ├── test_invitations.py           # gathering invitations and acceptance through the session
│       ├── test_keeper_shape.py          # the keeper columns, the CHECK, resolve_keeper
│       ├── test_keeping.py               # keep, unkeep, derived grace, the memorial exemption, usage
│       ├── test_media_intents.py         # upload intents, confirm, the quota and ceiling refusals, the intent reap
│       ├── test_media_reads.py           # who may see a photograph, and the presigned read
│       ├── test_media_schema.py          # the media schema's shape
│       ├── test_media_words.py           # filename, caption, tags, and search inside the audience
│       ├── test_member_places.py         # invited, shared with, left out; keeping lets no one in
│       ├── test_passkeys.py              # passkeys, against a software authenticator
│       ├── test_photo_count.py           # photo_count moving with total_bytes in one statement; the round-trip fixture
│       ├── test_processing.py            # decode, orient, strip, render, against the real fixtures
│       ├── test_profile.py               # GET and PATCH /me/profile
│       ├── test_publication.py           # the publication ladder, pure
│       ├── test_race_backstops.py        # race backstops that survive their own rollback (staged races)
│       ├── test_removal_attribution.py   # who removed it, the uploader's own bin, restore
│       ├── test_requirements_lock.py     # the locks stay universal, hashed and in step with the .in files
│       ├── test_retention.py             # the reaper: grace beyond the rate window, the ephemeral-tables guard
│       ├── test_review.py                # the host's queue, publish, decline and the batch
│       ├── test_rsvps.py                 # the RSVP upsert, companions, visibility, removing an answered date
│       ├── test_schema_keeper.py         # the accounts and gatherings spine's shape
│       ├── test_sessions.py              # sliding sessions and the 365-day cap
│       ├── test_storage.py               # the R2 client types and presigning, no network
│       ├── test_verify_r2_credentials.py # the R2 verifier's negative tests, stub-driven
│       └── test_worker.py                # the worker: claim, retry, dead-letter, publish, backoff, the sweep
├── .gitignore         # Node, Python, .env (not .env.example), editor and log files
├── docker-compose.yml # the dev database: covey-keep-db, postgres:16, host port 5434
├── netlify.toml       # the frontend build (base frontend/) and the SPA fallback
├── render.yaml        # the Render blueprint: covey-keep-api, covey-keep-worker (no pre-deploy step, ever), covey-keep-db-dev
├── README.md          # what CoveyKeep is, in one paragraph
├── CLAUDE.md          # this file: commands, deploys, gotchas, this map
└── CLAUDE-history.md  # this file's older changelog, its Source line, its old map and restated Deploys bullets; not auto-loaded
```

Branching: `develop` → `main` (work lands on develop; merge to main after verification).

## Canonical docs pointer

- **Code root:** `D:\projects\covey-keep\` (this repo — source, npm, build, test).
- **Docs root:** `D:\projects\Project-Hub\covey-keep\` (project facts, WORKING-ON-NOW, reference docs, decisions).

The two roots are **siblings under `D:\projects\`**, not nested — the docs are only reachable by absolute path, never by a relative path from this repo.

Reference-doc reads are **kickoff-triggered**: the phase kickoff names which docs under the docs root to read; do not sweep `reference/` speculatively.

**Inline fallback (coord-011):** if this session's filesystem access does not extend outside this repo, the kickoff inlines the relevant doc content — work from the inlined material rather than attempting the absolute paths.
