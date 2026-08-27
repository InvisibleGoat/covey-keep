# CoveyKeep — Repo Operational Guide

**Version:** 1.16.0
**Last Updated:** 2026-08-26
**Source:** Phase CK-2 (code repo creation + scaffolds); Phase CK-3 (first migration); Phase CK-4 (deploy skeleton); Phase CK-5 (magic-link auth, console-mode email); Phase CK-6 (sign-in UI, token handoff, affirmative ToS consent); Phase CK-7 (profile core: display name + IANA timezone); Phase CK-8 (account deletion by anonymization); Phase CK-8.1 (PWA update lifecycle owned in application code); Phase CK-9 (email change with proof of control; sliding trusted-device sessions); Phase CK-10 (passkey enrolment and usernameless passkey sign-in); Phase CK-12 (keeper schema, structural half: accounts, gatherings + occurrences, invitations); Phase CK-13 (keeper schema, lifecycle half: kept relation, derived grace, memorial exemption, admin claim state); Phase CK-13.1 (deployed schema verification); Phase CK-14 (brand modules; one-word flip to CoveyKeep); Phase CK-16 (gathering and occurrence CRUD — the keeper schema's first surface); Phase CK-17 (gathering creation, list, and read-only detail — the frontend half); Phase CK-18 (inline gathering and occurrence editing on the detail page).
**Audience:** Any Claude session working in this repo.

**Changelog:**
- **1.16.0** (2026-08-26): Phase CK-18 — inline editing on `/gatherings/:id` (the "change" half CK-17 deliberately left out; **no new route** — the read-only detail became the view-and-edit view). The gathering edit form patches **title + decedent name only** (the decedent field rendered only on a memorial, with its constraint labeled — the type is not editable: offering a control the API rejects is worse than none); per-date controls edit dates/location/map link, add a date, remove a date. **Admin-gating and its reported gap**: edit affordances render only for the admin (a non-admin gets CK-17's read-only page byte-for-byte — no edit control exists to probe, so the 404-not-403 posture survives editing), but **the API exposes no way to compare** — `/auth/me` carries the person id, never `account_id` — so the gate is `admin_account_id !== null`, which is provably exact under the shipped surface (creation is the only path to a kept row or admin; the NULL-admin claimable state has no readers) and **must be replaced before any phase widens the read audience** (reported as a backend gap, not fixed — no backend source changed; homed on WORKING-ON-NOW's small-backend-phase item). **The load-edit-save round trip is pinned first** (`lib/datetime.test.ts`): instant → `instantToWallClock` → `wallClockToInstant` three times over, byte-identical, in a zone forced to differ from the runner's and in a DST zone — a zone bug here doesn't fail, it walks the time by the offset per save. **Dirty-tracking**: save is disabled until something changes (a no-op edit sends no PATCH at all), and the backend's "nothing to update" 422 still renders if forced — a **no-op guard** may be pre-empted client-side; a **domain rule** (the memorial gate) never is. **`null` means "not provided"** on every PATCH (the `/me/profile` convention): nothing is clearable, so a blanked optional field is left out of the patch and the constraint is labeled plainly ("can be corrected, not removed") — never a control that fake-clears; blanked *validated* text (title, decedent) goes out as `""` so the server's own refusal renders. **Season cap** pinned on all three `loc` variants (create → `occurrences`; add and date-move → `starts_at`, each landing on the right control); **the last-occurrence refusal** renders beside the remove control that provoked it (`loc ["path","occurrence_id"]` — the control is never pre-emptively disabled). **CK-17's error-affordance finding closed**: new shared `components/FieldError.tsx` (+ `FormLevelErrors`) renders every mapper message with `role="alert"`, an `aria-hidden` mark, and a fixed `.form-error` — the CK-17 finding was a CSS specificity bug (`.auth-screen p` outranked `.form-error`, so errors rendered grey at body size); `errorId`/`describedBy` moved into `lib/formErrors.ts` with an optional scope prefix for pages rendering one field key in several forms. **Optimistic-free**: every successful mutation re-fetches the detail (the server re-sorts by `starts_at` and stamps `updated_at`); every request follows the cancel-on-unmount convention (a `let cancelled` effect + an alive ref for handlers). Second minor backend finding reported: occurrence `location`/`map_url` are neither trimmed nor blank-rejected server-side, so `""` is storable. 30 frontend tests (10 new). Backend untouched, 114 green.
- **1.15.0** (2026-08-25): Phase CK-17 — gathering creation, list, and read-only detail (the frontend half of CK-16; **editing is CK-18**, deliberately — including the last-occurrence-refusal surface, which belongs with the delete control that provokes it). Three routes behind `RequireAuth`, linked from `/home`: **`/gatherings`** (kept gatherings newest first, each with the next-or-most-recent occurrence date; **the empty state is a real screen** with the create CTA — it is what every new account sees), **`/gatherings/new`** (type picker over the API's `GatheringType` values, title, decedent name rendered **when and only when** the type is `memorial` — a UX mirror of the backend gate, never a replacement: a blank decedent submits and the backend's 422 lands inline; multiple occurrence rows so a season is creatable whole), **`/gatherings/:id`** (read-only; **404 and non-permitted render one identical not-found screen** — the backend's 404-not-403 posture is only as good as the UI that renders it). **The timezone rule** (`decisions/2026-08-25-occurrence-time-entry.md`): a wall clock typed into the form is interpreted in the person's **profile** IANA zone (browser zone only when the profile has none), converted in ONE place — **`lib/datetime.ts`** — and the same zone renders every time back; the zone is stated visibly next to the time fields ("Times in America/Chicago"). Never `new Date(wallClock)` — that is the browser's zone: right on the dev machine, right in CI, silently wrong for anyone whose device and profile zones differ. **`lib/formErrors.ts` is the one 422→inline-error code path** for this and every future form: field errors land on the field their `loc` names (source segment dropped, dot-joined — `occurrences.0.starts_at`), errors with no visible field surface as form-level messages (**never swallowed**), the season-cap message renders verbatim (the backend owns the span arithmetic), and non-422 failures get a distinct non-validation message. `GET /gatherings` carries no occurrence data, so the list makes per-gathering detail fetches — **reported as a backend gap, not fixed here** (no backend source changed). 20 frontend tests (18 new: `lib/datetime.test.ts` pins conversion both directions against a zone forced to differ from the runner's; `lib/formErrors.test.ts`; `routes/gatherings.test.tsx` — decedent toggle, 422 landing on its field, unmappable 422 still rendering, empty state, detail 404). Backend untouched, 114 green.
- **1.14.0** (2026-08-25): Phase CK-16 — gathering and occurrence CRUD, the keeper schema's first surface (**backend only** — the frontend is CK-17, the CK-5/CK-6 split again). Migration 0010 is **one column**: `gatherings.updated_at` (the CK-7 `people.updated_at` precedent — the stamp arrives with the phase that makes the row mutable). New router **`app/api/gatherings.py`** (seven endpoints, standard auth gate): `POST`/`GET /gatherings`, `GET`/`PATCH /gatherings/{id}`, `POST /gatherings/{id}/occurrences`, `PATCH`/`DELETE /occurrences/{id}`. **Creation is ONE transaction and the ordering is the point**: gathering + occurrences + `keeping.keep()` commit together — the creator is first keeper and admin at once (keeper record §9.2), and a gathering never exists with zero keepers, even transiently within the request. **`requires_approval` is set `True` explicitly in application code on every create** (fail closed — no inviting context exists until the invitation phase): the column's `server_default=false` from 0008 is deliberately unchanged and never relied on; pinned by test, which works *because* the default is false — a `True` can only come from app code (database-schema decision 22). The gathering itself is created `live` — `requires_approval` moderates contributions *within* it, never its own visibility. Authorization is uniform and keeper-shaped: mutations require `admin_account_id`, reads require kept-or-admin — written against the keeper/admin facts, never "is creator" (the audience widens later); non-permitted access is **404, never 403**, byte-identical to a missing id. The memorial gate is validated in the Pydantic layer (field-level 422s, both directions — the CHECK stays the backstop, never the UX); the **season cap** (occurrences within one year of the earliest `starts_at`) is enforced app-layer at create, occurrence-add, **and date-move** (the kickoff named the first two; a patch that moves a date is the third way the span grows, so the cap holds there too); deleting the last occurrence is refused (a gathering with no dates is not a state this product has). The CK-13 deletion lapse now has a real API-created subject in test. `verify_schema.py` → head `0010`, 44 assertions (negative-tested via a temporary downgrade). 114 tests (16 new, `test_gatherings.py`); **conftest's per-test truncate extended to `accounts CASCADE`** — the first content-creating endpoints leave keeper-spine rows (gatherings, occurrences, kept_gatherings) that the people-only truncate never touched.
- **1.13.0** (2026-08-25): Phase CK-14 — brand modules and the one-word flip to **`CoveyKeep`** (`decisions/2026-08-20-name-gate.md` §6 settles the name, pending counsel; §4's centralization hedge is now closed — a rename is one file per side plus image assets). **`frontend/src/brand.ts`** (`PRODUCT_NAME`, `TAGLINE` — named exports, so lint catches an unused one) and **`backend/app/brand.py`** (`PRODUCT_NAME`, `FROM_DISPLAY_NAME`) are **the only homes for user-visible brand strings; two modules is deliberate** — the sides share no build, and a generated cross-language artefact would cost more than it saves at two constants; do not "fix" the duplication. Every user-visible instance now references a constant: sign-in heading + tagline, ToS placeholder copy, `index.html` title (a `%PRODUCT_NAME%` placeholder filled at build time by the `brandTitle` plugin in `vite.config.ts` — `order: 'pre'`, ahead of Vite's own env replacement), PWA manifest `name`/`short_name` (imported from brand.ts), FastAPI title, WebAuthn RP display name (display-only; the credential binds to the RP **ID**), magic-link + email-change subjects and bodies, and the provider From header (display name from brand — `EMAIL_FROM` stays the bare address; delivery is still console mode, so nothing was live). **The slug stays `covey-keep` everywhere** — repo, sites, services, database, paths, storage keys: filesystem convention, not branding. Pinned by test on both sides: `tests/test_brand.py` (3 new; a monkeypatched sentinel proves the subject is *built from* the constant, not a literal that happens to match) and `src/brand.test.tsx` under new frontend test tooling (vitest + jsdom + testing-library, `npm run test`). 98 backend tests; `theme_color` deliberately untouched (still the plugin default — theming phase).
- **1.12.0** (2026-08-25): Phase CK-13.1 — **`backend/scripts/verify_schema.py`**, a committed read-only verifier for a deployed migration's *resulting shape* (a green deploy proves only that `alembic upgrade head` ran). Read-only by construction **and enforced**: every statement a SELECT, plus `default_transaction_read_only=on` on the connection; exits non-zero on any failure; prints counts and shapes only — **never a personal-data column, never the connection string**. 42 assertions covering the 0008/0009 shape plus the **accounts-backfill integrity that only has real rows to check on Render** (the local DB is empty — that path is the one local tests never exercise). Targets `VERIFY_DATABASE_URL` if set, else the app's `DATABASE_URL`, reusing `config.py`'s asyncpg normalisation. **The external-URL TLS trap** is handled in the script and worth knowing: Render's *internal* URL is unencrypted inside their network, the *external* one requires TLS in libpq form, and **asyncpg has no `sslmode` parameter** — SQLAlchemy forwards leftover URL query parameters to the driver as kwargs, so an unstripped external URL dies with an unexpected-keyword `TypeError` that never mentions SSL. **Extending the assertions is part of shipping a migration** (`EXPECTED_REVISION` is a constant in the file); a failed assertion is a **finding, not a fix** — never relaxed to make it pass. No application code.
- **1.11.0** (2026-08-24): Phase CK-13 — migration 0009, the **keeper lifecycle half** (keeper record §2.3–2.7/§8/§9; completes CK-12's structural half). **`kept_gatherings`** (UNIQUE(account_id, gathering_id)) is **the single source of truth for both the reference count and the quota arithmetic** — no is-kept boolean, no counter column, anywhere. Grace is ONE timestamp: `gatherings.last_keeper_left_at`, stamped when the last keeper leaves, cleared when anyone keeps again; archive-at-30d/delete-at-90d are **derived** by `services/keeping.py::grace_state` from policy constants, never stored. **Memorials are exempt by type, not flag**: never stamped, excluded from `account_usage`, gated by the `memorial_decedent_name` CHECK (present iff type is `memorial` — the abuse gate). `gatherings.account_id` → **`created_by_account_id`** (immutable, historical — "owner" is not a concept) plus **`admin_account_id` NULL** (nullable IS the claimable state; unkeep relinquishes it); `groups.steward_person_id`/`backup_steward_person_id` → `admin_person_id`/`backup_admin_person_id`. `gatherings.total_bytes` (a maintained per-gathering fact — quota stays computed at request time by summing it over kept rows; the never-stored rule governs entitlement/quota, not this input). **Deletion lapses kept statuses** — the fourth deletion-path integration (CK-9 email-change requests, CK-10 WebAuthn, now kept rows): hard-delete, relinquish admin, stamp grace exactly as unkeep would. Service layer only — no endpoints, no frontend. 95 tests (13 new: `test_keeping.py` + a deletion-lapse test).
- **1.10.0** (2026-08-24): Phase CK-12 — migration 0008, the **keeper spine, structural half** (`decisions/2026-08-24-keeper-storage-model.md` §9; the lifecycle half — kept relation, refcounts, grace, memorial exemption, admin claim — is CK-13). **`accounts`** supertype (`PERSON|ORGANIZATION`): `people.account_id`/`organizations.account_id` UNIQUE NOT NULL point **at** it — accounts.id is the one FK target quota/subscription/keeping will reference; `/auth/verify` creates the account with the person, same transaction (still the one person-creation path). **`gatherings`** (typed — the event types + `season`/`memorial`/`church_gathering`; account-owned; `requires_approval` lives on the gathering, not the group profile) + **`occurrences`** (dates — RSVP/attendance/items hang per-occurrence; posts/media hang on the gathering with a nullable occurrence label) + **`gathering_invitations`** (the ONLY gathering↔group link; exactly-one-of group/sub-group/person). `events`/`event_series`/`event_type` **dropped**; written as a restructure, not a data migration — the tables were verified empty, and the NOT-NULL adds fail loudly otherwise. 82 tests (14 new in `test_schema_keeper.py`).
- **1.9.0** (2026-08-21): Phase CK-10 — migration 0007 (`webauthn_credentials`, `webauthn_challenges` — single-use 5-minute challenges, same discipline as every token), passkey enrolment (`/me/passkeys/*`, attestation `none`) and **usernameless** sign-in (`/auth/passkey/begin|complete` — empty `allowCredentials`, **no email field accepted in any form**: narrowing by address is the CK-5/CK-9 enumeration oracle again). Sign-in mints its session through `mint_session` in `auth.py` — **the one session-birth path**, shared with `/auth/verify`. py_webauthn + @simplewebauthn/browser are the deliberate library exception (crypto protocol surface, never hand-rolled). Deletion purges both new tables. **Passkeys are the security path, never presented as the easy one; a passkey is bound to its RP ID (`WEBAUTHN_RP_ID`) and dies with a domain change — UI stays unpromoted until the custom domain is final.**
- **1.8.0** (2026-08-20): Phase CK-9 — migration 0006 (`email_change_requests`, hashed-token conventions mirrored from `magic_link_tokens`), `POST`/`DELETE /me/email-change` + unauthenticated `GET /auth/email-change/verify` (**email is a credential, changed only by proof of control over the new inbox** — byte-identical 202 whether or not the address is taken, same enumeration rule as `/auth/request-link`); verification revokes every session but the requesting one; deletion purges `email_change_requests`. Sessions now **90-day sliding** (refresh at most daily, 365-day absolute cap from `issued_at`; JWT `exp` minted at the cap — the sessions row is the live authority); `/settings` email section + `/email-change` result screen.
- **1.7.0** (2026-08-20): Phase CK-8.1 — service-worker registration owned by `PwaUpdatePrompt` (`virtual:pwa-register/react`; update notice instead of any forced reload; hourly + tab-visible `registration.update()`); `injectRegister: null` in `vite.config.ts` **must stay `null`** — removing it registers the worker twice, and `false` silently strips `skipWaiting`/`clientsClaim` from the generated worker (loose `== null` check in vite-plugin-pwa 1.3.0).
- **1.6.0** (2026-08-20): Phase CK-8 — migration 0005 (`people.anonymized_at` — the stamp alone marks anonymization, no boolean), `POST /me/delete` (typed `DELETE` confirmation; anonymize + hard-delete auth material in one transaction; **deletion is anonymization, never cascade** — contributions and `tos_acceptances` retained), `get_auth_context` 401s anonymized people even on a valid JWT, `/settings` destructive section + `/account-deleted` screen.
- **1.5.0** (2026-08-20): Phase CK-7 — migration 0004 (`people.timezone` **IANA zone name, never a UTC offset**; `people.updated_at`; display-name CHECK), `/me/profile` GET+PATCH, `/settings` screen, silent one-time browser-timezone capture on first sign-in; `tzdata` in requirements (Windows has no system tzdb).
- **1.4.0** (2026-08-20): Phase CK-6 — frontend auth (sign-in screen, `/auth/callback` fragment handoff, localStorage session, react-router-dom); `/auth/verify` now 302s into the frontend; request-link body carries affirmative ToS consent; migration 0003.
- **1.3.0** (2026-08-19): Phase CK-5 — auth endpoints + migration 0002, pytest suite (requirements-dev.txt, test DB on the docker container), auth env surface (SESSION_SECRET et al.), PWA autoUpdate.
- **1.2.0** (2026-08-19): Phase CK-4 — Netlify + Render dev deploys (netlify.toml, render.yaml), CORS via ALLOWED_ORIGINS, frontend /health probe.
- **1.1.0** (2026-08-18): Phase CK-3 — dev DB via docker compose (host port 5434), SQLAlchemy models, Alembic migration 0001.
- **1.0.0** (2026-08-17): Initial creation at repo scaffold (Phase CK-2).

---

## Commands

### Frontend (`frontend/`)

```
npm install        # once, or after dependency changes
npm run dev        # dev server
npm run build      # type-check (tsc -b) + production build to dist/
npm run test       # vitest (jsdom) — brand pins (CK-14) + gathering surface (CK-17/CK-18)
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
pip install -r requirements-dev.txt   # runtime deps + pytest/httpx (dev machines)
uvicorn app.main:app --reload    # run from backend/
alembic upgrade head             # apply migrations (dev DB must be up)
alembic downgrade base           # tear schema back down
alembic revision --autogenerate -m "..."   # new migration; always hand-review
pytest                           # dev DB container must be up: the suite drops +
                                 # recreates covey_keep_test on it and migrates to head
python scripts/verify_schema.py  # read-only schema + data-integrity check against
                                 # the dev DB (or a deploy — see below)
```

Render installs `requirements.txt` only — test deps stay in `requirements-dev.txt`.

### Deploys (push-driven; no local commands)

| What | URL | Trigger |
|---|---|---|
| Frontend prod | https://covey-keep.netlify.app | push/merge to `main` |
| Frontend dev | https://develop--covey-keep.netlify.app | push to `develop` |
| Backend dev API | https://covey-keep-api.onrender.com | push to `develop` |

- Netlify builds from `netlify.toml` (base `frontend/`, SPA fallback). `VITE_API_URL`
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

## Directory map

```
covey-keep/
├── frontend/          # Vite + React + TypeScript PWA (vite-plugin-pwa, react-router-dom)
│   ├── src/           # main.tsx (router + AuthProvider), App.tsx (route table), brand.ts (PRODUCT_NAME/TAGLINE — the only frontend home for user-visible brand strings; CK-14), brand.test.tsx (vitest brand pins)
│   │   ├── auth/      # AuthContext.tsx — session state, signIn/signOut, /auth/me load
│   │   ├── components/# RequireAuth route guard, PwaUpdatePrompt (SW registration + update notice), PasskeySection (settings-only, quiet by default), FieldError + FormLevelErrors (the mapper's rendering half: role="alert" + the error affordance — CK-18)
│   │   ├── lib/       # api.ts (fetch wrappers, 401 → clear session), session.ts (localStorage), timezone.ts (IANA helpers), datetime.ts (wall-clock ↔ instant in an explicit IANA zone — the CK-17 profile-zone rule), formErrors.ts (the one 422→inline-error mapping path, every form's convention since CK-17), gatherings.ts (gathering API types + labels), passkeys.ts (WebAuthn ceremonies, usernameless sign-in)
│   │   └── routes/    # SignIn (ToS checkbox + /health probe + secondary "Use a passkey"), AuthCallback, Home, Gatherings (kept list + real empty state), GatheringNew (creation form, conditional decedent field), GatheringDetail (view-and-edit since CK-18: inline title/decedent editing, per-date edit/add/remove, admin-gated affordances; one not-found screen for 404), Settings (passkeys + email-change + delete-account sections), Tos, EmailChangeResult, AccountDeleted
│   └── public/        # static assets
├── backend/           # Python + FastAPI
│   ├── app/           # main.py — FastAPI instance, CORS, GET /health, auth router
│   │   ├── brand.py   # PRODUCT_NAME/FROM_DISPLAY_NAME — the only backend home for user-visible brand strings (CK-14)
│   │   ├── config.py  # pydantic-settings; DATABASE_URL (asyncpg-normalized), ALLOWED_ORIGINS, auth surface
│   │   ├── db.py      # async engine + session factory
│   │   ├── security.py# token hashing + stdlib HS256 session JWT
│   │   ├── api/       # deps.py (get_db + get_auth_context — every endpoint's auth gate; owns the session slide), auth.py (owns mint_session — the one session-birth path; verify creates person + account in one transaction), profile.py, passkeys.py (enrolment + usernameless sign-in), gatherings.py (gathering + occurrence CRUD; the creation-keeps transaction; admin-only mutations, 404-not-403 — CK-16)
│   │   ├── services/  # email.py — two-mode adapter (console | provider), standard v1.0.0; keeping.py — keeper lifecycle (keep/unkeep, derived grace_state, account_usage, deletion lapse; kept_gatherings is the ONLY refcount/quota truth)
│   │   └── models/    # keeper spine + auth (one module per cluster; enums in enums.py; account.py + gathering.py since CK-12 — gathering.py carries KeptGathering since CK-13, event.py gone)
│   ├── alembic/       # async-template env; 0001 = Phase 1 spine, 0002 = auth + household ladder, 0003 = token ToS version, 0004 = profile columns (IANA timezone, updated_at), 0005 = anonymized_at (deletion = anonymization, never cascade), 0006 = email_change_requests, 0007 = webauthn credentials + challenges, 0008 = keeper spine structural half (accounts, gatherings + occurrences, invitations; events/event_series dropped), 0009 = keeper lifecycle half (kept_gatherings, grace stamp, memorial decedent CHECK, admin claim state, steward→admin rename), 0010 = updated_at on gatherings (the row becomes user-mutable at CK-16)
│   ├── scripts/       # verify_schema.py — read-only shape + data-integrity verifier
│   │                  #   (run after every migration that reaches Render; CK-13.1)
│   ├── tests/         # pytest + httpx ASGI suite (test_auth.py, test_profile.py, test_account_deletion.py, test_email_change.py, test_sessions.py, test_passkeys.py — SoftPasskey software authenticator; test_schema_keeper.py — CK-12 spine shape; test_keeping.py — CK-13 lifecycle; test_brand.py — CK-14 brand pins; test_gatherings.py — CK-16 CRUD, creation transaction, moderation default; conftest owns the test DB)
│   └── .env.example   # full env template (copy to .env)
├── docker-compose.yml # dev DB: covey-keep-db, postgres:16, host port 5434
├── netlify.toml       # frontend build + SPA redirect
├── render.yaml        # Render blueprint: covey-keep-api + covey-keep-db-dev
├── README.md
└── CLAUDE.md          # this file
```

Branching: `develop` → `main` (work lands on develop; merge to main after verification).

## Canonical docs pointer

- **Code root:** `D:\projects\covey-keep\` (this repo — source, npm, build, test).
- **Docs root:** `D:\projects\Project-Hub\covey-keep\` (project facts, WORKING-ON-NOW, reference docs, decisions).

The two roots are **siblings under `D:\projects\`**, not nested — the docs are only reachable by absolute path, never by a relative path from this repo.

Reference-doc reads are **kickoff-triggered**: the phase kickoff names which docs under the docs root to read; do not sweep `reference/` speculatively.

**Inline fallback (coord-011):** if this session's filesystem access does not extend outside this repo, the kickoff inlines the relevant doc content — work from the inlined material rather than attempting the absolute paths.
