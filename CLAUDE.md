# Covey Keep — Repo Operational Guide

**Version:** 1.11.0
**Last Updated:** 2026-08-24
**Source:** Phase CK-2 (code repo creation + scaffolds); Phase CK-3 (first migration); Phase CK-4 (deploy skeleton); Phase CK-5 (magic-link auth, console-mode email); Phase CK-6 (sign-in UI, token handoff, affirmative ToS consent); Phase CK-7 (profile core: display name + IANA timezone); Phase CK-8 (account deletion by anonymization); Phase CK-8.1 (PWA update lifecycle owned in application code); Phase CK-9 (email change with proof of control; sliding trusted-device sessions); Phase CK-10 (passkey enrolment and usernameless passkey sign-in); Phase CK-12 (keeper schema, structural half: accounts, gatherings + occurrences, invitations); Phase CK-13 (keeper schema, lifecycle half: kept relation, derived grace, memorial exemption, admin claim state).
**Audience:** Any Claude session working in this repo.

**Changelog:**
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
- No backend prod service yet — dev-first; prod cutover is its own later phase.

## Directory map

```
covey-keep/
├── frontend/          # Vite + React + TypeScript PWA (vite-plugin-pwa, react-router-dom)
│   ├── src/           # main.tsx (router + AuthProvider), App.tsx (route table)
│   │   ├── auth/      # AuthContext.tsx — session state, signIn/signOut, /auth/me load
│   │   ├── components/# RequireAuth route guard, PwaUpdatePrompt (SW registration + update notice), PasskeySection (settings-only, quiet by default)
│   │   ├── lib/       # api.ts (fetch wrappers, 401 → clear session), session.ts (localStorage), timezone.ts (IANA helpers), passkeys.ts (WebAuthn ceremonies, usernameless sign-in)
│   │   └── routes/    # SignIn (ToS checkbox + /health probe + secondary "Use a passkey"), AuthCallback, Home, Settings (passkeys + email-change + delete-account sections), Tos, EmailChangeResult, AccountDeleted
│   └── public/        # static assets
├── backend/           # Python + FastAPI
│   ├── app/           # main.py — FastAPI instance, CORS, GET /health, auth router
│   │   ├── config.py  # pydantic-settings; DATABASE_URL (asyncpg-normalized), ALLOWED_ORIGINS, auth surface
│   │   ├── db.py      # async engine + session factory
│   │   ├── security.py# token hashing + stdlib HS256 session JWT
│   │   ├── api/       # deps.py (get_db + get_auth_context — every endpoint's auth gate; owns the session slide), auth.py (owns mint_session — the one session-birth path; verify creates person + account in one transaction), profile.py, passkeys.py (enrolment + usernameless sign-in)
│   │   ├── services/  # email.py — two-mode adapter (console | provider), standard v1.0.0; keeping.py — keeper lifecycle (keep/unkeep, derived grace_state, account_usage, deletion lapse; kept_gatherings is the ONLY refcount/quota truth)
│   │   └── models/    # keeper spine + auth (one module per cluster; enums in enums.py; account.py + gathering.py since CK-12 — gathering.py carries KeptGathering since CK-13, event.py gone)
│   ├── alembic/       # async-template env; 0001 = Phase 1 spine, 0002 = auth + household ladder, 0003 = token ToS version, 0004 = profile columns (IANA timezone, updated_at), 0005 = anonymized_at (deletion = anonymization, never cascade), 0006 = email_change_requests, 0007 = webauthn credentials + challenges, 0008 = keeper spine structural half (accounts, gatherings + occurrences, invitations; events/event_series dropped), 0009 = keeper lifecycle half (kept_gatherings, grace stamp, memorial decedent CHECK, admin claim state, steward→admin rename)
│   ├── tests/         # pytest + httpx ASGI suite (test_auth.py, test_profile.py, test_account_deletion.py, test_email_change.py, test_sessions.py, test_passkeys.py — SoftPasskey software authenticator; test_schema_keeper.py — CK-12 spine shape; test_keeping.py — CK-13 lifecycle; conftest owns the test DB)
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
