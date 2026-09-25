"""Ingest — the worker's claim service (CK-35) and, since CK-36, the whole
of what it does with a claimed photograph: read the original, decode it,
strip it, render the three layers, write them, and make the row `ready`
in ONE transaction, and only then delete the original.

SINCE CK-54 THIS MODULE ALSO DESTROYS ONE. Two jobs ride the same row and
the same claim mechanism — ingest (`uploaded` → `processing` →
`ready`/`failed`) and destruction (`destroying` → `destroyed`) — because
the media row IS the job and a second jobs table would be the second
representation decision 20 bans. See DESTROY below; the order of its two
steps deliberately inverts PUBLISH's, and that is the one thing in this
module most likely to be "fixed" by a later reader.

The media row IS the job (media pipeline record §6.1) — there is no jobs
table, and everything a worker needs to know rides the row: `status` (the
rung), `attempts`, `available_at` (not claimable before), `claimed_at` (the
reclaim clock), `last_error`. The mechanics (record §6.2), as built:

CLAIM. `SELECT … FOR UPDATE SKIP LOCKED LIMIT 1` over rows that are either
  - `uploaded` with `available_at` NULL or in the past, or
  - `processing` with `claimed_at` older than RECLAIM_AFTER (a stall),
oldest `created_at` first; stamp `claimed_at`, move to `processing`. A
`pending_upload` row is NEVER claimable: nothing was confirmed, and the
intent reap owns it. SKIP LOCKED is what lets two workers drain one queue
without ever taking the same row — pinned by test with two sessions.

RECLAIM. A deploy kills the worker mid-job as a matter of course (record
§8). The stalled row is RE-CLAIMED — never deleted and recreated, which would
lose its provenance — and the abandoned attempt is COUNTED: `attempts`
increments at reclaim, because a row that kills the worker would otherwise
be reclaimed forever, which is a crash loop by another name. A row
abandoned MAX_ATTEMPTS times is dead-lettered at reclaim rather than given
a fourth run. (With processing measured in seconds and a reclaim at 15
minutes, three deploys landing on one photograph is the implausible case
and the safe direction.)

RETRY. A TRANSIENT failure — the store did not answer, or answered with
something other than present/absent, on the HEAD, the read, or a write —
increments `attempts` and returns the row to `uploaded` with `available_at`
pushed down the backoff ladder (RETRY_BACKOFF); the MAX_ATTEMPTS-th failure
dead-letters instead. With three attempts the third failure is terminal, so
the ladder's last rung is reached only if MAX_ATTEMPTS is ever raised.

PERMANENT — three shapes, and every one dead-letters on the FIRST attempt
(`attempts` = 1, never 3), because a certainty does not deserve the ladder
and quarantine time is the one resource this architecture spends on purpose:
  - a MISSING quarantine object (the upload never completed, or the 24-hour
    lifecycle rule removed it before a worker ran — the state CK-34's two
    deployed orphans were in); a GET that finds the object gone after the
    HEAD found it present is the same case, raced by the rule;
  - an UNDECODABLE upload — not an image, not a supported format (a renamed
    .mov, a GIF), truncated or corrupt (processing.Undecodable);
  - an OVERSIZED image — more than ~50 megapixels (record §6.6: worker memory
    tracks pixels, not bytes; the decode is refused from the header before
    a pixel exists). A row that kept killing the worker would otherwise be
    the crash loop RECLAIM counts its way out of; this refuses it at once.
Transient and permanent are different and must never be collapsed (§6.2).

DEAD-LETTER. `status = 'failed'`, `last_error` naming the cause in operator
terms — the OUTCOME, never the file's contents (record §6.5), never a URL,
never a key id. Marking a row `failed` RELEASES its quota reservation: that
is already how `keeping.account_usage` reads the ladder (in-flight is
`pending_upload | uploaded | processing`), and no second mechanism exists —
pinned by test. THEN the quarantine object is deleted (record §6.2, "at
that moment") — after the terminal state has committed, never before it,
by the worker through `delete_original` (see PUBLISH for the ordering rule
both paths share).

TERMINAL ROWS CARRY NO JOB STATE (CK-37). `ready` and `failed` are the two
rungs nothing ever claims again, so both clear `claimed_at` (CK-35) AND
`available_at`: the deferral CK-36's two dead-letters kept from the CK-35
release was harmless only because the claim predicate happens to read
`uploaded`/`processing`, and stale state nobody nulls is how a later
predicate change acquires a surprise. And `attempts` counts EVERY attempt,
the one that ended the row included — a `ready` row reads `attempts = 1`
after a clean run, `2` after one abandoned claim — which is exactly the
number the worker's log line prints. Until CK-37 the success path left the
count where it was while the log said one more: two surfaces disagreeing
silently, which is worse than either number.

A THIRD CLASS the record did not name: a REJECTED CREDENTIAL. A request that
fails with AccessDenied / InvalidAccessKeyId / SignatureDoesNotMatch is a
fact about the worker's configuration, not about the photograph. Treating
it as transient would dead-letter every photograph in the queue within
minutes of a mistyped dashboard value; treating it as permanent would be
worse. So the claim is RELEASED UNPENALIZED — `attempts` unchanged,
`available_at` unchanged, the rung the one it was claimed from — and the
loop backs off with a loud log line. UNTOUCHED COVERS THOSE TWO COLUMNS
AND NOT `last_error` (CK-57): the release WRITES ERROR_CREDENTIAL_REJECTED
there, replacing whatever the row carried. Until CK-57 it wrote nothing,
and that was never decided — the two columns it protects were enumerated
and the third was left — so a released row carried either nothing or a
STALE reason from an earlier transient failure that this release had
silently superseded, with no way for an operator to tell which. Writing
the reason is not a penalty; the penalty half is the two counters.

AMENDED AT CK-61 (2026-09-25): THE PARAGRAPH ABOVE IS WHAT THE CLASS
PROMISED, AND ON THE INGEST READ PATH IT NEVER HELD — from CK-35 to CK-60,
not sometimes, always. Proved on the deploy twice (check (gv)): with a
genuinely rejected credential — R2 answered 401, `Unauthorized`, a member
of the set — the release never fired; the row climbed the transient ladder
instead, attempts 1 then 2, the 1- and 5-minute rungs, `last_error`
reading "attempt 1 of 3: storage did not answer (read: ClientError
(401))". The mechanism: the first store call on an ingest claim is a HEAD,
a HEAD response carries no XML body, and botocore therefore SYNTHESISES
`Error.Code` from the bare HTTP status — `'401'`, never `Unauthorized`;
`'403'`, never `AccessDenied` — so a set of NAMED codes could not match on
that path, and the branch at the read site was unreachable. Measured in
one process against one rejected credential: head_object -> '401',
get_object -> 'Unauthorized', head_bucket -> '401', list_objects_v2 ->
'Unauthorized'. This module had already written the fact down seventeen
lines from the set and not applied it: `_ABSENT_CODES` carries both forms
("on a HEAD the bare status, on a GET the S3 code") for exactly this
reason. Two sets, one helper, two assumptions about one exception shape.
The operational sentence: the guarantee this class was built for — that a
mistyped dashboard value does not dead-letter the queue — did not hold; with
rungs at 1, 5 and 15 minutes a mistyped key id dead-letters every queued
row in about twenty-one minutes, and neither deploy run lost data only
because the credential was restored in time. WHAT MAKES IT TRUE NOW: every
site asks `_is_credential_rejected`, ONE helper that matches the named set
OR an HTTP status of 401/403 — the one place that knows botocore's two
shapes; the set stays named-only, and `'400'` stays out (a wrong-LENGTH key
id draws InvalidArgument / 400, a malformed request and not a credential
fact — the helper's docstring says why, and config.py's boot-time shape
check on the access key ids is the half that catches it). The write and
destroy branches below were never reached by any run — the HEAD precedes
them — and were untested rather than working until CK-61's tests; the
stubbed tests that were green from CK-35 built the exception with a named
code, the input the read path can never deliver.

WHAT `last_error` MEANS (CK-57), and it is NARROWER THAN THE COLUMN'S NAME:
`last_error` is WHY THIS ROW IS NOT PROGRESSING RIGHT NOW — not the last
thing that ever went wrong with it. A row waiting on a backoff says why
it failed (the retry text); a dead row says why it died (the dead-letter
text); a row released on a rejected credential says the worker was
refused (ERROR_CREDENTIAL_REJECTED); a row with nothing wrong carries NULL
(`ready`, `destroyed`, a fresh mark, a fresh confirm). Every outcome
overwrites or clears it, so the column never carries a reason that has
stopped being the reason. The one moment it lags is while a worker HOLDS
the row (`claimed_at` set): the claim itself writes nothing, so a held
row still shows the reason it was waiting on before the claim until the
outcome replaces it — which is why the verifier's assertions on it
exclude held rows. The column is OPERATOR-ONLY: never in an API body
(api/media.py leaves it out of `_media_body` on purpose), read by the
worker's log lines and a person in psql, and its content is a stage name,
an exception class and an S3 error code at most.

PUBLISH — THE CRUX (record §8: "publish is the last step and is atomic,
never a sequence a restart can leave half-done"; the record's word for the
worker's `ready` step — everywhere else in this corpus "publish" is the
host's `pending → live` gate, which this module never touches). The order,
and each step's failure mode, deliberately:

  1. READ the original from quarantine (a missing object here is permanent;
     the store not answering is transient; a rejected credential releases).
  2. DECODE, TRANSPOSE, STRIP, RENDER the three layers in memory
     (processing.render_layers — Undecodable is permanent; anything else it
     raises is a worker bug, left to the loop's catch-all so the row stalls
     in `processing` and the reclaim rule counts the attempt).
  3. WRITE all three objects to the published bucket, keyed by
     storage.published_key(media_id, layer) — a pure function, so the
     writes are IDEMPOTENT BY CONSTRUCTION: a retry overwrites the same
     keys and can never leave a second set behind. A write failing is
     transient (the retry rewrites all three); a rejected credential
     releases the row.
  4. ONE TRANSACTION: the guarded update that moves the row to `ready`
     (claimed_at NULL, available_at NULL, last_error NULL, attempts counting
     this one) — FIRST, so a claim lost to a
     reclaim writes nothing at all; then any derivative rows the media id
     already has are deleted and the three fresh rows inserted, so a
     retry never trips `uq_media_derivatives_media_id_layer` (a row that
     reaches step 4 with rows already present is not this transaction's
     failure mode — step 4 either commits whole or not at all — but a
     re-queued photograph would be, and an IntegrityError dead-letter would
     read as a decode bug); then `gatherings.total_bytes` is incremented
     by the sum of the three layers' ACTUAL stored sizes - and, since
     CK-51a (0024), `gatherings.photo_count` by ONE - in one UPDATE, the
     same statement for both columns, so they cannot diverge.
     The caller commits. The reservation releases in the same instant
     through the one quota path (`ready` is outside IN_FLIGHT_STATUSES —
     the baton keeping.py already holds; verified by test, not rebuilt):
     since CK-51b the reservation was ONE photo-equivalent for this row and
     `photo_count` takes over at exactly one, so the account's usage does
     not move at all at `ready` — the unit is the photograph, whatever the
     file weighed (currency record §3). The bytes ride beside it for THE
     MONITOR (currency record §5), one INFO line after the UPDATE: the
     charged unit, the three layers' actual stored sum, PHOTOGRAPH_BYTES
     (the measured cost of one photograph — a cost model with this one
     runtime use, never a quota unit) and their ratio. It is the first
     comparison of charged against stored the system has ever had; what
     it watches is whether the currency is still worth what we said, and
     what it moves is a PRICE, never the count. Byte counts and a row id
     only (media-pipeline §8's bans cover URLs and object keys, and
     nothing here approaches them).
  5. ONLY AFTER THAT COMMIT the worker deletes the quarantine original
     (`delete_original`), and a failure there is NOT a failure of the row:
     the photograph is `ready`, the original lingers, and the 24-hour
     lifecycle rule collects it. A crash between 4 and 5 costs a lingering
     original the rule takes; a crash in the other order would cost the
     photograph permanently — which is why the order is not negotiable.
     Deleting an already-absent object is a SUCCESS (storage.py says why:
     Render runs two workers for ~61 seconds on every deploy).

`publication_state` — THE GATE, resolved inside step 4 (CK-41). Processing
is not publishing (record §5): the worker does not infer the host's
approval from its own completion. What it does is APPLY A SETTING that says
no approval is required — the publication ladder in
services/publication.py, resolved at publish time from the gathering's own
setting, the home group's default, the type's template and the join shape
(consent-gate defaults 2.0.0 §1). Where the gathering resolves open the
guarded `ready` update also moves `pending → live`, in the SAME statement
of the SAME transaction as the derivative rows and `total_bytes` — never
beside it: a photograph that is `ready` but not published, or published but
not counted, is a state nothing else in this system can produce. Where it
resolves gated the row is `ready` and stays `pending` for the host (the
host's review — the queue, publish, decline — is CK-43, api/media.py).
RESOLVED AT PUBLISH TIME, NEVER SNAPSHOTTED AT INTENT: a host who turns review on between the upload and its processing
gets a photograph that waits, and a group whose default changes reaches
every gathering under it; a snapshot on the media row would be a second
representation of the gate (the decision-20 / media_tags.gathering_id
defect class). `live` is written only over `pending` — a takedown is never
undone by the worker. No dead-letter path touches `publication_state`: a
`failed` row stays `pending`.

THE PUBLICATION STAMP (CK-43, migration 0020; the-hosts-review record §7):
where the worker writes `live` it also writes `published_at`, in the SAME
guarded statement and under the SAME `CASE` (only over `pending` — a
takedown is never undone and never re-dated), and it leaves
`published_by_person_id` NULL. NULL IS THE FACT that the rule published
the photograph and no person did; the host's publish (api/media.py) is
the only writer of a non-NULL publisher. Nothing is backfilled: rows the
worker published before 0020 read NULL on both, forever.

DESTROY (CK-54; decisions/2026-09-20-the-bin-counts-and-empties.md §6,
§7.1). The second job, entered from `ready` and nowhere else, because only
a `ready` row has layers to destroy. The row is marked `destroying` and —
in ONE statement, the mirror of the publish transaction's increment — the
gathering's `photo_count` and `total_bytes` are decremented together; the
marking statement also resets the job columns, so a photograph that took
two attempts to ingest still gets three to be destroyed. THE MARKING
STATEMENT IS `services/destruction.py::mark_for_destruction` (extracted
from the API at CK-58 into this module, and moved out at CK-59: the API
importing this module for it pulled `processing` — Pillow — into the web
process, and destruction.py needs the models alone; it is re-exported
here so the ladder reads whole): one copy with two callers —
`api/media.py::destroy_media` today, a person's choice, and the 30-day
sweep from CK-59, the clock — because re-typing it in the worker is how
the two counts diverge, and CK-54's whole shape was chosen so the
decrement rides the mark and cannot drift from it. It runs in its
caller's transaction and never commits.
What arrives at handle_destroying is therefore an uncounted, invisible
row owed a bucket operation.

  1. DELETE THE THREE PUBLISHED OBJECTS, reading their keys from the
     derivative rows (the record of what was actually written).
  2. ONE TRANSACTION: the guarded rung to `destroyed`, then the derivative
     rows deleted. The caller commits.

THE ORDER IS THE INVERSE OF PUBLISH'S, AND THAT IS THE POINT. Publish
commits the database and only then deletes the quarantine original,
because the database is the record of what exists and a lost original is
cheaper than a lost photograph. Destruction cannot borrow that argument:
committing `destroyed` before the objects are gone would leave a row
claiming a photograph was destroyed while its bytes sit in the bucket —
after the product told someone it was gone. Delete-first fails safe
instead: a crash leaves `destroying`, the retry finds the objects absent,
and an absent object is a SUCCESS (storage.py), so the retry is idempotent
by construction rather than by bookkeeping.

A DESTROY JOB THAT EXHAUSTS THE LADDER STAYS AT `destroying`. It does not
become `failed`: `failed` is the ingest ladder's terminal and would claim
the wrong job failed, and — because `api/media.py::_visible_media` excludes
the two destruction rungs and nothing else — it would make the row VISIBLE
AGAIN to the person who destroyed it. So the row keeps the rung, carries
its `last_error`, and is kept out of the claim predicate by
`attempts < MAX_ATTEMPTS` rather than by a rung change. It is not charged
and it is seen by nobody; what it owes is a bucket operation an operator
can retry by hand. Named rather than hidden: this is the phase's residual
failure mode.

Nothing on this path touches a gathering, a quota or a publication state.
`publication_state` keeps whatever it had — it records what was decided
about the photograph, and destruction is not a publication decision. There
is no permanent failure class: an object that cannot be found is the
success case.

Every function that writes leaves the commit to the caller (the worker
commits after the claim and again after the outcome, so the row lock is
held for the claim alone and never across a network call). Outcomes are
written with a GUARDED update — `WHERE status = 'processing' AND claimed_at
= <this claim's stamp>` — so a worker that stalled past RECLAIM_AFTER and
was reclaimed by another cannot overwrite the other's result.

DATA-HANDLING: this module names no person. It reads the photograph's bytes
into memory for the length of one call and retains nothing; every rendition
is re-encoded from pixels with no metadata carried (processing.py — the
EXIF promise, made true here and pinned against real fixtures). Since
CK-54 it also DESTROYS a photograph's stored bytes, photographs of children
among them — and every destruction it performs is one a person already
chose (api/media.py's permanent delete, host or uploader). The marking
statement (`mark_for_destruction`) lived here from CK-58 to CK-59 and is
services/destruction.py's now; nothing in this module CALLS it, on a
clock or otherwise — this module runs the ladder a marked row is already
on. The scheduled 30-day sweep, its first caller on a clock, is CK-59
and lives beside it there. The three layers die as a unit, as
the removal
rule has always required, because the `media_derivatives` rows carry no
lifecycle of their own to diverge. The `media` row survives with its
provenance AND its words (bin record §7.2): a caption is not a likeness,
the row is invisible by construction once it leaves the counted rung, and
*a photograph captioned "Jenny at bat" was deleted* is an audit trail
where *something was deleted* is not. It logs
ONE line, since CK-51b — the monitor at the publish UPDATE: a row id, the
stored byte count, the cost model and their ratio, nothing else (the
worker logs media ids and outcomes — a row id is not personal data; a key
is a function of it; a byte count is a number). `last_error` carries a
stage name, an exception class and an S3 error code at most.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta
from enum import Enum
from typing import Optional
from uuid import UUID

from botocore.exceptions import BotoCoreError, ClientError
from sqlalchemy import and_, case, delete, func, literal, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Account, Gathering, Media, MediaDerivative, MediaStatus, PublicationState
from app.models.enums import PUBLICATION_STATE
from app.services import processing, publication
# The entry to the destruction ladder lives in services/destruction.py
# since CK-59 (CK-58 put it here, and the API importing this module for it
# pulled processing — Pillow — into the web process). Re-exported so the
# ladder reads whole from the module that runs it — claim_next, this entry,
# handle_destroying — and so CK-58's pins resolve it by this name unedited.
from app.services.destruction import mark_for_destruction  # noqa: F401
from app.services.keeping import PHOTOGRAPH_BYTES
from app.services.processing import Rendition, Undecodable
from app.services.storage import (
    WorkerClient,
    delete_published_object,
    delete_quarantine_object,
    head_quarantine_object,
    published_key,
    put_published_object,
    quarantine_key,
    read_quarantine_object,
)

# The monitor's logger (CK-51b) — the worker's namespace, so Render's log
# and the suite's caplog see it beside the `ready` line.
log = logging.getLogger("covey-keep.ingest")

# A `processing` row whose claim is older than this is a stall — the worker
# that held it was killed (record §6.2, §8) — and is claimable again.
RECLAIM_AFTER = timedelta(minutes=15)

# Three attempts, then dead-letter (record §6.2). Counted on transient
# failures AND on abandoned claims (see RECLAIM in the module docstring).
MAX_ATTEMPTS = 3

# Backoff through `available_at` after the Nth failed attempt (record §6.2:
# 1m, 5m, 15m). Indexed by the number of failures so far; with MAX_ATTEMPTS
# at three the third failure is terminal and the 15-minute rung waits for a
# raised limit.
RETRY_BACKOFF = (timedelta(minutes=1), timedelta(minutes=5), timedelta(minutes=15))

# The store rejected the CREDENTIAL, not the request — the worker is
# misconfigured, and no row is at fault (the verifier script's own
# classification, CK-33). NAMED FORMS ONLY, AND ON PURPOSE (CK-61): these are
# what a response WITH an XML body carries. A HEAD's error has no body, and
# botocore reports the bare status ('401', '403') in its place — that half
# lives in _is_credential_rejected, the ONE place that knows both shapes.
# Never add "401", "403" or any numeric token here: the sites call the
# helper, not this set, and a numeric member would put the same knowledge
# in two places for whoever writes a third classifier.
CREDENTIAL_REJECTED_CODES = frozenset(
    {
        "AccessDenied",
        "Forbidden",
        "AllAccessDisabled",
        "InvalidAccessKeyId",
        "SignatureDoesNotMatch",
        "Unauthorized",
        "InvalidSignature",
        "AuthorizationHeaderMalformed",
        "InvalidToken",
        "ExpiredToken",
    }
)

# What botocore reports when the object is not there — on a HEAD the bare
# status, on a GET the S3 code.
#
# THE MIXED SET IS THE SUPERSEDED FORM (CK-61) — left exactly as it is. It is
# right, it works (storage.py tests its own copy on the HEAD, where a bare
# '404' is exactly what arrives; this one is tested on the GET after it, where
# the named NoSuchKey arrives — both forms in both places because the shape
# is the CALL's, not the store's), and changing it would risk a regression
# for no functional gain. But it is the older, ad-hoc way of handling the one
# botocore behaviour that kept CREDENTIAL_REJECTED_CODES — named-only, against
# the same _error_code helper — from ever matching a rejected credential on a
# HEAD from CK-35 to CK-60: two sets, one helper, two assumptions, this one
# right and the other not. Since CK-61 that knowledge lives in
# _is_credential_rejected, which reads the HTTP status; a THIRD classifier
# reads the status the same way and never copies this mixed set. Mixed sets
# are not the house style; this one is history that still runs.
_ABSENT_CODES = frozenset({"404", "NoSuchKey", "NotFound"})

# last_error texts — operator terms, the outcome and never the file.
ERROR_OBJECT_MISSING = (
    "quarantine object missing: the upload never completed, or the 24-hour "
    "quarantine ceiling removed it before the worker ran (permanent)"
)
ERROR_ABANDONED = (
    f"claimed {MAX_ATTEMPTS} times and never finished: the worker was "
    "interrupted mid-job on every attempt"
)
ERROR_UNDECODABLE = "could not process the upload as a photograph: {reason} (permanent)"
# The destruction ladder's two (CK-54). Both leave the row at `destroying`:
# the photograph is uncounted and invisible, and what is owed is a bucket
# operation an operator can retry by hand.
ERROR_DESTROY_ABANDONED = (
    f"destruction claimed {MAX_ATTEMPTS} times and never finished: the worker was "
    "interrupted mid-job on every attempt; the stored layers may still exist"
)
ERROR_DESTROY_FAILED = (
    "destruction could not delete the stored layers after {attempts} attempts "
    "(last: {cause}); the photograph is uncounted and invisible, and the layers "
    "may still exist"
)
# The release's one (CK-57), written on BOTH ladders by _release_misconfigured:
# why a released row is waiting. No exception class and no S3 code — the
# outcome is the same whichever of CREDENTIAL_REJECTED_CODES the store
# answered with (or, on a HEAD, whichever bare 401/403 — CK-61), none of
# them names the photograph, and what an operator fixes is the dashboard,
# not the row.
ERROR_CREDENTIAL_REJECTED = (
    "the store rejected the worker's credential: a fact about the worker's "
    "configuration, not about the photograph; the row is queued and untouched, "
    "and runs as soon as the credential is fixed"
)


class Outcome(str, Enum):
    """What handle_claimed did with the row it was given."""

    # The three layers are written and the row is `ready` (the worker's
    # step — not the host's publication). The caller deletes the original
    # after committing.
    READY = "ready"
    # The three published objects are gone and the derivative rows with
    # them; the row is `destroyed` (CK-54). Nothing to delete afterwards —
    # the quarantine original went at `ready`, one job earlier.
    DESTROYED = "destroyed"
    # The destruction ladder is spent: the row stays at `destroying` with
    # its last_error. Uncounted, invisible, and owed a bucket operation.
    DESTROY_ABANDONED = "destroy_abandoned"
    DEAD_LETTERED = "dead_lettered"
    RETRY_SCHEDULED = "retry_scheduled"
    # The worker's credential was rejected: the row is released unpenalized
    # (`attempts` and `available_at` untouched) with ERROR_CREDENTIAL_REJECTED
    # as its reason (CK-57), and the loop must back off.
    MISCONFIGURED = "misconfigured"
    # Another worker reclaimed this row after a stall; this outcome is void.
    LOST_CLAIM = "lost_claim"


# The four blocking calls, each run off the event loop (botocore blocks on
# the network; Pillow on the CPU). Tests stub these names.


async def _head(client: WorkerClient, key: str) -> Optional[tuple[int, str]]:
    return await asyncio.to_thread(head_quarantine_object, client, key=key)


async def _read(client: WorkerClient, key: str) -> bytes:
    return await asyncio.to_thread(read_quarantine_object, client, key=key)


async def _render(data: bytes) -> tuple[Rendition, Rendition, Rendition]:
    return await asyncio.to_thread(processing.render_layers, data)


async def _put(client: WorkerClient, key: str, rendition: Rendition) -> None:
    await asyncio.to_thread(
        put_published_object,
        client,
        key=key,
        body=rendition.data,
        content_type=rendition.content_type,
        storage_class=rendition.storage_class,
    )


async def _delete(client: WorkerClient, key: str) -> None:
    await asyncio.to_thread(delete_quarantine_object, client, key=key)


async def _delete_published(client: WorkerClient, key: str) -> None:
    await asyncio.to_thread(delete_published_object, client, key=key)


def _claimable(now: datetime):
    stale_before = now - RECLAIM_AFTER
    return or_(
        and_(
            Media.status == MediaStatus.UPLOADED,
            or_(Media.available_at.is_(None), Media.available_at <= now),
        ),
        and_(
            Media.status == MediaStatus.PROCESSING,
            # A processing row with no claim stamp is malformed; treating it
            # as stale is the direction that rescues it rather than the one
            # that strands it.
            or_(Media.claimed_at.is_(None), Media.claimed_at < stale_before),
        ),
        # THE DESTRUCTION LADDER (CK-54). `destroying` is the queued rung
        # AND the claimed one — the API marks straight to it, so a NULL
        # `claimed_at` means "marked, never claimed" here rather than
        # "malformed" as it does above; the same predicate serves both.
        # The availability gate is the retry backoff's, exactly as
        # `uploaded` reads it. AND `attempts < MAX_ATTEMPTS`: a destroy job
        # that exhausts the ladder STAYS at `destroying` (see DESTROY in
        # the module docstring — `failed` would be a lie about which job
        # failed and would make the row visible again), so the predicate,
        # not the rung, is what stops it being claimed forever.
        and_(
            Media.status == MediaStatus.DESTROYING,
            Media.attempts < MAX_ATTEMPTS,
            or_(Media.available_at.is_(None), Media.available_at <= now),
            or_(Media.claimed_at.is_(None), Media.claimed_at < stale_before),
        ),
    )


async def claim_next(db: AsyncSession, now: datetime) -> Optional[Media]:
    """Claim the oldest claimable row, or None when there is nothing to do.

    On a fresh `uploaded` row: stamp `claimed_at`, move to `processing`,
    `attempts` unchanged. On a stalled `processing` row: the abandoned
    attempt is counted first — and if that reaches MAX_ATTEMPTS the row is
    dead-lettered here and returned at `failed` (the caller deletes the
    original after committing) rather than run a fourth time. The caller
    commits, promptly: the row lock lasts for the claim alone.

    A `destroying` row (CK-54) is claimed IN PLACE — the rung does not
    move, because it is both the queue and the claim. A fresh one
    (`claimed_at` NULL) is claimed with `attempts` unchanged; a stalled one
    counts its abandoned attempt exactly as `processing` does, and on
    reaching MAX_ATTEMPTS it stays at `destroying` with its `last_error`
    rather than becoming `failed`.

    THE CALLER TELLS A CLAIM FROM A DEAD-LETTER BY `claimed_at`, not by the
    rung: every real claim stamps it, and every dead-letter-at-reclaim
    clears it. That is true on both ladders, where "the rung is `failed`"
    is true on only one."""
    row = (
        await db.execute(
            select(Media)
            .where(_claimable(now))
            .order_by(Media.created_at, Media.id)
            .limit(1)
            .with_for_update(skip_locked=True)
        )
    ).scalar_one_or_none()
    if row is None:
        return None
    destroying = row.status == MediaStatus.DESTROYING
    # A destroying row with no claim stamp has never been claimed; only a
    # stamped one was abandoned. On the ingest ladder every `processing`
    # row counts (an unstamped one is malformed — see _claimable).
    abandoned = row.status == MediaStatus.PROCESSING or (destroying and row.claimed_at is not None)
    if abandoned:
        row.attempts += 1
        if row.attempts >= MAX_ATTEMPTS:
            if destroying:
                # The bytes are still owed a deletion and nobody is
                # charged for them. The rung stays so the row remains
                # invisible and the failure remains legible.
                row.last_error = ERROR_DESTROY_ABANDONED
            else:
                row.status = MediaStatus.FAILED
                row.last_error = ERROR_ABANDONED
            row.claimed_at = None
            row.available_at = None  # terminal: no deferral survives (CK-37)
            await db.flush()
            return row
    if not destroying:
        row.status = MediaStatus.PROCESSING
    row.claimed_at = now
    await db.flush()
    return row


async def _settle(db: AsyncSession, row: Media, **values) -> bool:
    """Write an outcome for THIS claim only: the update is guarded on the
    row still being in the rung it was claimed at, under this claim's
    `claimed_at`. Returns False when another worker has reclaimed the row
    meanwhile (the stall case) — the caller's outcome is then void and
    nothing is written.

    The guarded rung is the ROW'S OWN (`processing` on the ingest ladder,
    `destroying` on the destruction one, CK-54) rather than the literal
    `processing`: a destroy job is claimed in place, so a hard-coded rung
    would guard against a state it is never in and every outcome would
    read as a lost claim."""
    result = await db.execute(
        update(Media)
        .where(
            Media.id == row.id,
            Media.status == row.status,
            Media.claimed_at == row.claimed_at,
        )
        .values(**values)
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        return False
    await db.refresh(row)
    return True


def _error_code(exc: ClientError) -> Optional[str]:
    return exc.response.get("Error", {}).get("Code")


def _is_credential_rejected(exc: ClientError) -> bool:
    """The third class's one test (CK-61): is this the store refusing the
    worker's CREDENTIAL — as opposed to the request, or the object?

    True when the named code is in CREDENTIAL_REJECTED_CODES, OR when the
    response's HTTP status is 401 or 403. Both halves are needed, and the
    second one lives here and not in the set for a reason. botocore names
    an S3 error from the XML body of the response, and a HEAD response HAS
    NO BODY — so on a HEAD it synthesises `Error.Code` from the bare status
    instead. Measured against one and the same rejected credential in one
    process (check (gv), 2026-09-25): head_object -> '401', get_object ->
    'Unauthorized', head_bucket -> '401', list_objects_v2 -> 'Unauthorized'.
    The ingest ladder's FIRST store call is the HEAD, so from CK-35 to CK-60
    a set of named codes could not match a rejected credential on the read
    path — not sometimes, always — and the row climbed the transient ladder
    toward the dead-letter this class was written to prevent.

    ONE HELPER, NOT TWO MORE MEMBERS. The defect's shape was two sets
    (`_ABSENT_CODES` mixed, the credential set named-only) making two
    different assumptions about the one exception shape `_error_code`
    reads. Adding "401" / "403" to the set would leave that shape standing
    for whoever writes a third classifier — and a mixed set reads as the
    house style. The numeric knowledge belongs in exactly one place, and
    this is it: the set stays named-only, the status is read here, and a
    third classifier calls this or reads the status the same way. Do not
    "simplify" it back into the set.

    400 STAYS OUT, DELIBERATELY. A key id of the wrong LENGTH draws
    `InvalidArgument` / 400 — R2 length-validates before it authenticates
    ((gv)'s first run) — and that is a MALFORMED REQUEST, not a credential
    fact: admitting 400 here would classify every genuinely bad request as
    the worker's configuration and release it, unpenalized, forever. The
    wrong-length key id is caught where it belongs, at boot, by config.py's
    shape check on the access key ids (CK-61's other half). 401 and 403 are
    the two statuses whose meaning IS the credential, whatever the body said
    or did not say."""
    if _error_code(exc) in CREDENTIAL_REJECTED_CODES:
        return True
    status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
    return status in (401, 403)


async def handle_claimed(
    db: AsyncSession, client: WorkerClient, row: Media, now: datetime
) -> Outcome:
    """Everything between the claim and the outcome — see PUBLISH in the
    module docstring for the order and why. The caller commits, and after
    a READY or DEAD_LETTERED commit calls delete_original."""
    key = quarantine_key(row.id)

    # 1. Is the object there, and then: the bytes.
    try:
        found = await _head(client, key)
        if found is None:
            return await _permanent_failure(db, row, ERROR_OBJECT_MISSING)
        try:
            data = await _read(client, key)
        except ClientError as exc:
            if _error_code(exc) in _ABSENT_CODES:
                # Raced by the lifecycle rule between the HEAD and the GET:
                # the same permanent case.
                return await _permanent_failure(db, row, ERROR_OBJECT_MISSING)
            raise
    except ClientError as exc:
        code = _error_code(exc)
        if _is_credential_rejected(exc):
            return await _release_misconfigured(db, row)
        return await _transient_failure(db, row, now, f"read: {exc.__class__.__name__} ({code})")
    except BotoCoreError as exc:
        return await _transient_failure(db, row, now, f"read: {exc.__class__.__name__}")

    # 2. Decode, transpose, strip, render — permanent when it cannot be done.
    try:
        renditions = await _render(data)
    except Undecodable as exc:
        return await _permanent_failure(db, row, ERROR_UNDECODABLE.format(reason=exc.reason))
    del data

    # 3. The three objects, keyed deterministically — idempotent writes.
    try:
        for rendition in renditions:
            await _put(client, published_key(row.id, rendition.layer), rendition)
    except ClientError as exc:
        code = _error_code(exc)
        if _is_credential_rejected(exc):
            return await _release_misconfigured(db, row)
        return await _transient_failure(db, row, now, f"write: {exc.__class__.__name__} ({code})")
    except BotoCoreError as exc:
        return await _transient_failure(db, row, now, f"write: {exc.__class__.__name__}")

    # 4. One transaction: the row to `ready` (and, where the gathering
    # resolves open, to `live`), the derivative rows, the gathering's
    # bytes. The guarded update goes first so a lost claim writes nothing
    # at all. The attempt that succeeded is counted and the deferral
    # cleared — a terminal row carries no job state (CK-37).
    #
    # THE GATE, resolved here and now — at publish time, never snapshotted
    # at intent (CK-41; see the module docstring). The read is the first
    # statement of this transaction: the gathering's own setting and the
    # host account's kind in one join (a hostless gathering reads NULL for
    # the kind, and the ladder lets the join shape answer).
    host_setting, host_kind = (
        await db.execute(
            select(Gathering.requires_approval, Account.kind)
            .outerjoin(Account, Account.id == Gathering.host_account_id)
            .where(Gathering.id == row.gathering_id)
        )
    ).one()
    gate = publication.resolve_gathering(host_setting=host_setting, host_kind=host_kind)
    values: dict = dict(
        status=MediaStatus.READY,
        claimed_at=None,
        available_at=None,
        attempts=row.attempts + 1,
        last_error=None,
    )
    if not gate.requires_approval:
        # Open: `pending → live` in the SAME guarded statement as `ready` —
        # never a second statement, never beside the transaction. Only
        # over `pending`: a takedown (`removed`) is never undone by the
        # worker, whatever the gate says.
        was_pending = Media.publication_state == PublicationState.PENDING
        values["publication_state"] = case(
            (was_pending, literal(PublicationState.LIVE, type_=PUBLICATION_STATE)),
            else_=Media.publication_state,
        )
        # The publication stamp (CK-43, 0020): WHEN, under the same guard
        # (a removed row is never re-dated), and WHO stays NULL — the rule
        # published this, not a person. The transaction's clock, the one
        # `created_at` uses.
        values["published_at"] = case((was_pending, func.now()), else_=Media.published_at)
    applied = await _settle(db, row, **values)
    if not applied:
        return Outcome.LOST_CLAIM
    await db.execute(
        delete(MediaDerivative)
        .where(MediaDerivative.media_id == row.id)
        .execution_options(synchronize_session=False)
    )
    db.add_all(
        MediaDerivative(
            media_id=row.id,
            layer=rendition.layer,
            storage_key=published_key(row.id, rendition.layer),
            content_type=rendition.content_type,
            size_bytes=rendition.size_bytes,
            storage_class=rendition.storage_class,
        )
        for rendition in renditions
    )
    stored = sum(rendition.size_bytes for rendition in renditions)
    # ONE statement, both columns (CK-51a, 0024): the photograph the quota
    # reads (since CK-51b) and the bytes the monitor reads. In one UPDATE
    # the two cannot diverge - a lost claim, a crash or a rollback moves
    # both or neither - so the verifier's two assertions (total_bytes
    # equals the sum over the ready rows' layers; photo_count equals the
    # count of ready rows) are the same fact checked twice. Never a second
    # statement beside this one. Removal decrements NEITHER - a removed
    # photograph keeps its layers in the bin (removed and still stored,
    # whatever its age) - and since CK-54 DESTRUCTION decrements both, in
    # one statement, the mirror of this one: api/media.py's marking
    # statement, where the row leaves `ready` and the two columns drop
    # together. The 30-day SWEEP that does this on a clock is Phase B.
    await db.execute(
        update(Gathering)
        .where(Gathering.id == row.gathering_id)
        .values(
            total_bytes=Gathering.total_bytes + stored,
            photo_count=Gathering.photo_count + 1,
        )
        .execution_options(synchronize_session=False)
    )
    # THE MONITOR (CK-51b; currency record §5) — charged against stored, at
    # the one place the charge is written. One photograph was charged
    # (photo_count + 1 above) and `stored` bytes were kept; PHOTOGRAPH_BYTES
    # is the measured cost the price assumes. A ratio drifting above 1.0
    # across many photographs means the PRICE is wrong, never the count
    # (a photograph is still 1) - the tier is repriced, the quota is not
    # touched. Byte counts and a row id only. This is PHOTOGRAPH_BYTES's
    # one runtime use; it is not a statement, so the one-UPDATE pin above
    # holds.
    log.info(
        "media %s: charged 1 photograph; stored %d bytes against %d modeled (%.2fx)",
        row.id,
        stored,
        PHOTOGRAPH_BYTES,
        stored / PHOTOGRAPH_BYTES,
    )
    await db.flush()
    return Outcome.READY


async def handle_destroying(
    db: AsyncSession, client: WorkerClient, row: Media, now: datetime
) -> Outcome:
    """DESTROY A PHOTOGRAPH — the routine that deletes stored bytes, and the
    first one this product has ever had (CK-54; bin record §6, §7.1). The
    caller commits; nothing is deleted from quarantine afterwards (the
    original went at `ready`, one job earlier).

    THE ORDER INVERTS THE PUBLISH TRANSACTION'S, DELIBERATELY — do not
    "fix" it back to match. Publishing commits the database BEFORE deleting
    the quarantine original (PUBLISH step 5) because the database is the
    record of what exists: a crash between them costs a lingering original
    the lifecycle rule collects, where the other order would cost the
    photograph. DESTRUCTION IS THE MIRROR IMAGE OF THAT ARGUMENT: the
    objects go FIRST and `destroyed` is committed only after. Commit-first
    plus a failed delete would leave a row claiming the photograph is
    destroyed while its bytes sit in the bucket — after the product told
    someone it was gone, which is the one promise this routine exists to
    keep. Delete-first fails safe: a crash leaves the row at `destroying`,
    the retry finds the objects absent, and DELETING AN ABSENT OBJECT IS A
    SUCCESS (storage.py), so the retry is idempotent for free rather than
    by bookkeeping.

    THE DERIVATIVE ROWS ARE THE RECORD OF WHAT IS STORED, so they are read
    here and deleted in the same transaction as `destroyed` — never earlier.
    Their `storage_key` is what was actually written (the column exists for
    that reason), and a row stuck at `destroying` stays legible to an
    operator: these are the objects that may still exist. Deriving the keys
    from published_key() instead would work — it is the same string by
    construction — and would leave a stuck row saying nothing about what it
    owes.

    THE ROW IS ALREADY UNCOUNTED when this runs: the marking statement
    decremented `photo_count` and `total_bytes` together and moved the row
    off `ready`. Nothing here touches a gathering, a quota or a publication
    state — `publication_state` keeps whatever it had, because it records
    what was decided about the photograph and destruction is not a
    publication decision.

    Failures: the store not answering is TRANSIENT and climbs the same
    ladder an upload does; a rejected credential RELEASES the claim
    unpenalized — `attempts` and `available_at` untouched, the reason
    written (CK-57) — exactly as it does on the ingest side (the worker
    is at fault, not the row). There is no permanent class — an object
    that cannot be found is the success case, not a failure."""
    layers = (
        await db.execute(
            select(MediaDerivative.storage_key)
            .where(MediaDerivative.media_id == row.id)
            .order_by(MediaDerivative.layer)
        )
    ).scalars().all()

    # 1. The bytes, first. Absent is success; one key at a time, so a
    # partial run leaves the rest for the retry.
    try:
        for key in layers:
            await _delete_published(client, key)
    except ClientError as exc:
        code = _error_code(exc)
        if _is_credential_rejected(exc):
            return await _release_misconfigured(db, row)
        return await _destroy_failure(db, row, now, f"delete: {exc.__class__.__name__} ({code})")
    except BotoCoreError as exc:
        return await _destroy_failure(db, row, now, f"delete: {exc.__class__.__name__}")

    # 2. ONE transaction: the guarded rung first, so a claim lost to a
    # reclaim writes nothing at all, then the derivative rows that now
    # describe nothing. The row itself survives, words and all (bin record
    # §7.2) — it is invisible because of the rung, not because it is empty.
    applied = await _settle(
        db,
        row,
        status=MediaStatus.DESTROYED,
        claimed_at=None,
        available_at=None,
        attempts=row.attempts + 1,
        last_error=None,
    )
    if not applied:
        return Outcome.LOST_CLAIM
    await db.execute(
        delete(MediaDerivative)
        .where(MediaDerivative.media_id == row.id)
        .execution_options(synchronize_session=False)
    )
    await db.flush()
    return Outcome.DESTROYED


async def _destroy_failure(db: AsyncSession, row: Media, now: datetime, cause: str) -> Outcome:
    """The destruction ladder's transient rung — the upload ladder's shape,
    with two differences: the rung does not move (there is no queued state
    to return to; `destroying` is both), and the spent ladder does not
    become `failed`. A row that gives up stays `destroying` with its
    last_error: uncounted, invisible, and honest about owing a deletion."""
    attempts = row.attempts + 1
    if attempts >= MAX_ATTEMPTS:
        applied = await _settle(
            db,
            row,
            claimed_at=None,
            available_at=None,
            attempts=attempts,
            last_error=ERROR_DESTROY_FAILED.format(attempts=attempts, cause=cause),
        )
        return Outcome.DESTROY_ABANDONED if applied else Outcome.LOST_CLAIM
    backoff = RETRY_BACKOFF[min(attempts, len(RETRY_BACKOFF)) - 1]
    applied = await _settle(
        db,
        row,
        claimed_at=None,
        attempts=attempts,
        available_at=now + backoff,
        last_error=f"attempt {attempts} of {MAX_ATTEMPTS}: could not delete the stored layers ({cause})",
    )
    return Outcome.RETRY_SCHEDULED if applied else Outcome.LOST_CLAIM


async def delete_original(client: WorkerClient, media_id: UUID) -> bool:
    """Step 5, and the dead-letter's counterpart: delete the quarantine
    original AFTER the terminal state has committed. Returns False — and
    raises nothing — when the store would not do it: the row is already
    `ready` or `failed`, the original lingers, and the 24-hour lifecycle
    rule takes it. An absent object is a success (storage.py)."""
    try:
        await _delete(client, quarantine_key(media_id))
    except (ClientError, BotoCoreError):
        return False
    return True


async def _permanent_failure(db: AsyncSession, row: Media, last_error: str) -> Outcome:
    # On the first attempt, whatever the count was: the ladder is for
    # failures that a retry can change.
    applied = await _settle(
        db,
        row,
        status=MediaStatus.FAILED,
        claimed_at=None,
        available_at=None,
        attempts=row.attempts + 1,
        last_error=last_error,
    )
    return Outcome.DEAD_LETTERED if applied else Outcome.LOST_CLAIM


async def _release_misconfigured(db: AsyncSession, row: Media) -> Outcome:
    """The worker, not the row, is at fault: release unpenalized, and say so.

    UNTOUCHED IS `attempts` AND `available_at` — AND NOT `last_error` (CK-57).
    The two counters are the penalty half, protected because the row did
    nothing wrong; the reason column is the operator's, and it is WRITTEN
    here — ERROR_CREDENTIAL_REJECTED, on both ladders in this one call,
    replacing whatever the row carried. Before CK-57 this call settled
    `status` and `claimed_at` alone, so an ingest row released after a
    transient failure kept its stale "attempt 1 of 3: storage did not
    answer" while waiting on something else entirely, a fresh row said
    nothing, and the verifier could not tell a released destruction from
    a dead-lettered one (the assertion CK-56 declined for exactly that
    reason, written at CK-57). Clearing instead of writing would not have
    helped: a cleared row is `destroying` / attempts 1 / no stamp / no
    reason — the same shape as a healthy fresh row, and the same silence
    for the operator. See THIRD CLASS in the module docstring.

    THE RUNG IT RETURNS TO IS THE ONE IT CAME FROM. An ingest claim goes
    back to `uploaded`, the queue it was taken from. A destruction claim
    (CK-54) stays at `destroying`, which IS its queue — releasing it to
    `uploaded` would hand an already-uncounted photograph back to the
    INGEST ladder, whose first act is to HEAD a quarantine original that
    was deleted at `ready`; the row would dead-letter to `failed` and
    become visible again to the person who destroyed it, with its counts
    already gone. Caught by test."""
    released = (
        MediaStatus.DESTROYING if row.status == MediaStatus.DESTROYING else MediaStatus.UPLOADED
    )
    applied = await _settle(
        db, row, status=released, claimed_at=None, last_error=ERROR_CREDENTIAL_REJECTED
    )
    return Outcome.MISCONFIGURED if applied else Outcome.LOST_CLAIM


async def _transient_failure(db: AsyncSession, row: Media, now: datetime, cause: str) -> Outcome:
    attempts = row.attempts + 1
    if attempts >= MAX_ATTEMPTS:
        applied = await _settle(
            db,
            row,
            status=MediaStatus.FAILED,
            claimed_at=None,
            available_at=None,
            attempts=attempts,
            last_error=f"storage did not answer after {attempts} attempts (last: {cause})",
        )
        return Outcome.DEAD_LETTERED if applied else Outcome.LOST_CLAIM
    backoff = RETRY_BACKOFF[min(attempts, len(RETRY_BACKOFF)) - 1]
    applied = await _settle(
        db,
        row,
        status=MediaStatus.UPLOADED,
        claimed_at=None,
        attempts=attempts,
        available_at=now + backoff,
        # The cause of the LAST failure, kept while the row retries so an
        # operator can see why a row is climbing the ladder; overwritten by
        # the dead-letter text if it gets there, by ERROR_CREDENTIAL_REJECTED
        # if a release intervenes (CK-57 — the reason is always the current
        # one), cleared at `ready`.
        last_error=f"attempt {attempts} of {MAX_ATTEMPTS}: storage did not answer ({cause})",
    )
    return Outcome.RETRY_SCHEDULED if applied else Outcome.LOST_CLAIM
