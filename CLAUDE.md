# Covey Keep — Repo Operational Guide

**Version:** 1.2.0
**Last Updated:** 2026-08-19
**Source:** Phase CK-2 (code repo creation + scaffolds); Phase CK-3 (first migration); Phase CK-4 (deploy skeleton).
**Audience:** Any Claude session working in this repo.

**Changelog:**
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
`DATABASE_URL` lives in `backend/.env` (gitignored; template in `backend/.env.example`).

### Backend (`backend/`)

```
pip install -r requirements.txt
uvicorn app.main:app --reload    # run from backend/
alembic upgrade head             # apply migrations (dev DB must be up)
alembic downgrade base           # tear schema back down
alembic revision --autogenerate -m "..."   # new migration; always hand-review
```

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
- No backend prod service yet — dev-first; prod cutover is its own later phase.

## Directory map

```
covey-keep/
├── frontend/          # Vite + React + TypeScript PWA (vite-plugin-pwa)
│   ├── src/           # App entry (main.tsx, App.tsx — /health probe placeholder)
│   └── public/        # static assets
├── backend/           # Python + FastAPI
│   ├── app/           # main.py — FastAPI instance, CORS, GET /health
│   │   ├── config.py  # pydantic-settings; DATABASE_URL (asyncpg-normalized), ALLOWED_ORIGINS
│   │   ├── db.py      # async engine + session factory
│   │   └── models/    # Phase 1 spine (one module per cluster; enums in enums.py)
│   ├── alembic/       # async-template env; versions/0001 = Phase 1 spine
│   └── .env.example   # DATABASE_URL template (copy to .env)
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
