# Covey Keep — Repo Operational Guide

**Version:** 1.4.0
**Last Updated:** 2026-08-20
**Source:** Phase CK-2 (code repo creation + scaffolds); Phase CK-3 (first migration); Phase CK-4 (deploy skeleton); Phase CK-5 (magic-link auth, console-mode email); Phase CK-6 (sign-in UI, token handoff, affirmative ToS consent).
**Audience:** Any Claude session working in this repo.

**Changelog:**
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
- Browser session (CK-6): `/auth/verify` 302s to
  `${APP_BASE_URL}/auth/callback#token=<jwt>` — the JWT rides the URL
  **fragment**, never the query string; the frontend stores it in
  `localStorage` (must survive a browser restart — the 30-day trusted-device
  promise; httpOnly cookie deferred to the prod cutover). Decision record:
  docs root `decisions/2026-08-20-browser-session-storage.md`.
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
│   │   ├── components/# RequireAuth route guard
│   │   ├── lib/       # api.ts (fetch wrappers, 401 → clear session), session.ts (localStorage)
│   │   └── routes/    # SignIn (ToS checkbox + /health probe), AuthCallback, Home, Tos
│   └── public/        # static assets
├── backend/           # Python + FastAPI
│   ├── app/           # main.py — FastAPI instance, CORS, GET /health, auth router
│   │   ├── config.py  # pydantic-settings; DATABASE_URL (asyncpg-normalized), ALLOWED_ORIGINS, auth surface
│   │   ├── db.py      # async engine + session factory
│   │   ├── security.py# token hashing + stdlib HS256 session JWT
│   │   ├── api/       # deps.py (get_db + get_auth_context — every endpoint's auth gate), auth.py
│   │   ├── services/  # email.py — two-mode adapter (console | provider), standard v1.0.0
│   │   └── models/    # Phase 1 spine + auth (one module per cluster; enums in enums.py)
│   ├── alembic/       # async-template env; 0001 = Phase 1 spine, 0002 = auth + household ladder, 0003 = token ToS version
│   ├── tests/         # pytest + httpx ASGI suite (test_auth.py; conftest owns the test DB)
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
