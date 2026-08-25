"""User-visible brand strings — the single backend source (CK-14).

Two brand modules exist, this one and ``frontend/src/brand.ts``, deliberately:
the frontend and backend do not share a build, and a generated cross-language
artefact would cost more than it saves at two constants. Do not "fix" the
duplication — keep the two files in step by hand.

Brand is not slug: ``covey-keep`` / ``covey_keep`` in repo names, hostnames,
paths, packages, and the database are filesystem convention and never change
with the brand (decisions/2026-08-20-name-gate.md §6).
"""

# One word, deliberately — a unitary coined mark, never spaced into two
# (decisions/2026-08-20-name-gate.md §6).
PRODUCT_NAME = "CoveyKeep"

# The display-name half of an email From header ("CoveyKeep <address>"). The
# address half is environment (EMAIL_FROM in config), not brand.
FROM_DISPLAY_NAME = PRODUCT_NAME
