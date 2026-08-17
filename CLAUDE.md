# Covey Keep — Repo Operational Guide

**Version:** 1.0.0
**Last Updated:** 2026-08-17
**Source:** Phase CK-2 (code repo creation + scaffolds).
**Audience:** Any Claude session working in this repo.

**Changelog:**
- **1.0.0** (2026-08-17): Initial creation at repo scaffold (Phase CK-2).

---

## Commands

### Frontend (`frontend/`)

```
npm install        # once, or after dependency changes
npm run dev        # dev server
npm run build      # type-check (tsc -b) + production build to dist/
```

### Backend (`backend/`)

```
pip install -r requirements.txt
uvicorn app.main:app --reload    # run from backend/
```

## Directory map

```
covey-keep/
├── frontend/          # Vite + React + TypeScript PWA (vite-plugin-pwa)
│   ├── src/           # App entry (main.tsx, App.tsx)
│   └── public/        # static assets
├── backend/           # Python + FastAPI
│   └── app/           # main.py — FastAPI instance, GET /health
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
