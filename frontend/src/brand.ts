// User-visible brand strings — the single frontend source (CK-14).
//
// Two brand modules exist, this one and backend/app/brand.py, deliberately:
// the frontend and backend do not share a build, and a generated
// cross-language artefact would cost more than it saves at two constants.
// Do not "fix" the duplication — keep the two files in step by hand.
//
// Named exports rather than a default object, so an unused constant is caught
// by lint. Brand is not slug: `covey-keep` in paths, hostnames, and storage
// keys is filesystem convention and never changes with the brand
// (decisions/2026-08-20-name-gate.md §6).

// One word, deliberately — a unitary coined mark, never spaced into two
// (decisions/2026-08-20-name-gate.md §6).
export const PRODUCT_NAME = 'CoveyKeep'

export const TAGLINE = 'Plan the gathering. Keep the day.'

// The maker's line, at the foot of the menu and of You (CK-82; the design
// handoff §3). It names who makes CoveyKeep, not a standard CoveyKeep
// follows (Steven, 2026-10-31). Frontend only: no email or backend string
// carries it.
export const MAKER_LINE = 'a Paper Goose product'
