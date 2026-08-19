# Covey Keep — Repo Operational Guide

**Version:** 1.1.0
**Last Updated:** 2026-08-18
**Source:** Phase CK-2 (code repo creation + scaffolds); Phase CK-3 (first migration).
**Audience:** Any Claude session working in this repo.

**Changelog:**
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

## Directory map

```
covey-keep/
├── frontend/          # Vite + React + TypeScript PWA (vite-plugin-pwa)
│   ├── src/           # App entry (main.tsx, App.tsx)
│   └── public/        # static assets
├── backend/           # Python + FastAPI
│   ├── app/           # main.py — FastAPI instance, GET /health
│   │   ├── config.py  # pydantic-settings; reads DATABASE_URL from backend/.env
│   │   ├── db.py      # async engine + session factory
│   │   └── models/    # Phase 1 spine (one module per cluster; enums in enums.py)
│   ├── alembic/       # async-template env; versions/0001 = Phase 1 spine
│   └── .env.example   # DATABASE_URL template (copy to .env)
├── docker-compose.yml # dev DB: covey-keep-db, postgres:16, host port 5434
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
