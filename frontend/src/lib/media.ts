// Media API types and the upload/read helpers (CK-38). Shapes mirror
// backend/app/api/media.py's response bodies exactly — see
// reference/backend/api-reference.md, Media router.
//
// THE ONE RULE THIS MODULE EXISTS TO KEEP (pipeline record §9): a presigned
// URL — the PUT the intent endpoint issues, the GET the url endpoint mints —
// is a bearer credential carrying an Access Key ID and a valid signature.
// It is spent on exactly one fetch and exists nowhere else: never in React
// state, never in a log, never in an error message, never in anything a
// retry could read back. The two helpers below take the response body as a
// local, make the one call, and return something that is not the URL — a
// verdict for the PUT, an object URL for the read (a `blob:` reference to
// bytes already in this browser, which carries no credential at all).
//
// THE WORDS ON A PHOTOGRAPH (CK-40, the surface for CK-39's backend;
// decisions/2026-09-10-captions-tags-and-finding-a-photograph.md): a row is
// called by its caption, then its filename, then "Photo" (mediaName); the
// caption follows the Patch-semantics convention (captionPatch — blank is
// never a clear, explicit null is); and the tag list REPLACES the set on the
// server, so tagsPatch always carries every tag the photograph should end up
// with — sending only the new one silently deletes the rest.
//
// THE HOST'S REVIEW (CK-43.1, the surface for CK-43's backend;
// decisions/2026-09-13-the-hosts-review.md): the queue is the same list
// asked for with `awaiting_review=true` (mediaListPath); publish and decline
// are the two acts (reviewMedia), each refused with a STABLE CODE the copy
// switches on and never the server's wording (reviewRefusalMessage); and the
// pending line's second sentence — what the photograph waits on — follows
// on every `ready` + `pending` row (mediaStateMessage; record §8 as
// restated at 1.2.0, CK-44: a row may say it is waiting exactly when
// someone can act on it, and under the strand rule someone always can —
// the host's queue renders while anything waits, whatever the switch says
// (anyWaiting, the list-level half of the same predicate). Where review is
// off and nothing waits, no line names a reviewer or what it waits on.
//
// YOUR OWN PHOTOGRAPHS (CK-64, the surface for CK-54's remove and destroy
// and CK-63's restore; decisions/2026-09-27-two-bins.md §1, §2, §4): the
// three acts on a row the caller uploaded are one function (binMedia), each
// refused with a STABLE CODE the copy switches on (binRefusalMessage); the
// bin's line says what the bin IS from the person's side — theirs alone,
// and open to put back for the rest of the window (binDaysLeft) — and never
// what happens at the window's end, because the automatic clear ships
// switched off and until it is on nothing clears a bin; and the permanent
// delete's confirmation is the bin record §7.1's sentence, verbatim, with
// "from <the product>" kept because a photograph already in a printed book
// is out of reach (DELETE_PERMANENTLY_CONFIRMATION).
//
// THE HOST'S SIDE (CK-67, the surface for CK-66's backend; two-bins §1–§4):
// the gathering's bin is the same list asked for with `removed=true`
// (mediaListPath — the rows someone other than the uploader removed, which
// the server shows to the organisers), never both view flags at once; the
// takedown — Remove from gathering — and the bin's Put back and Delete
// permanently go through binMedia like the uploader's own acts; and the bin
// row's line (mediaStateMessage's removed branch, read in the gathering's
// bin) says whose sight it left and how long the way back stays open —
// under the same ban as the personal line: nothing about the window's end.
//
// CO-HOSTS (CK-69, the surface for CK-68's backend; co-hosts §4 as amended
// by two-bins §4): a co-host takes a published photograph down, reads the
// gathering's bin and puts back from it — THROUGH THE GATE, so where the
// gathering requires approval a co-host's Put back lands the photograph in
// the host's queue and out of the co-host's own sight — and never deletes
// someone else's photograph permanently, never sees a waiting one, never
// reviews. So the copy that says who can see a removed photograph names the
// organisers — "you and any co-hosts" from the host's seat, "the host and
// co-hosts" from a co-host's (takedownSentence; mediaStateMessage's removed
// branch) — where until CK-69 it said "only you", true only while the host
// was the one organiser. The pending lines keep `isHost` meaning the host
// alone: `pending` is still the host's and the uploader's.
import { PRODUCT_NAME } from '../brand'
import { authFetch } from './api'
import { networkErrors } from './formErrors'

export type MediaStatus = 'pending_upload' | 'uploaded' | 'processing' | 'ready' | 'failed'
export type PublicationState = 'pending' | 'live' | 'removed'
export type ServableLayer = 'web' | 'thumbnail'

// A GET /gatherings/{id}/media row: the CK-34 media body plus who uploaded
// it (a display name — never an email, never a person id), whether it is
// the caller's own, and the bin clock. There is NO url field, by design.
export interface MediaItem {
  id: string
  gathering_id: string
  occurrence_id: string | null
  // Typed loosely on purpose: a rung or state this build does not know is
  // rendered honestly by name (see mediaStateMessage), never as a blank.
  status: MediaStatus | string
  publication_state: PublicationState | string
  upload_content_type: string
  upload_size_bytes: number
  uploaded_at: string | null
  created_at: string
  uploader_display_name: string | null
  is_own: boolean
  removed_at: string | null
  // The words (CK-39): the file's name as taken at intent — a display string
  // and nothing else, NULL on every row written before migration 0018 and
  // never backfilled; the uploader's caption, NULL when there is none (never
  // ""); and the tags, case-insensitively alphabetical — a set, not the
  // order typed.
  filename: string | null
  caption: string | null
  tags: string[]
  // The publication stamp's date (CK-43; migration 0020): null until
  // published, set by the worker where the gathering resolves open and by
  // the host's publish where it is gated. Carried because the body carries
  // it and RENDERED NOWHERE — the stamp is consent evidence, never row
  // furniture (record §7), and the publisher's person id rides no body.
  published_at: string | null
}

export interface MediaList {
  media: MediaItem[]
}

// One entry of the intent response: the new row and the credential for ONE
// PUT of exactly the declared bytes. `headers` carries the values R2 signed
// in — the PUT must send Content-Type exactly as given; Content-Length is
// the browser's to set from the body (a forbidden header in fetch).
export interface UploadInstruction {
  url: string
  method: string
  headers: Record<string, string>
  expires_in: number
}

export interface UploadIntent {
  // The intent body carries the filename it stored (trimmed) and never the
  // tags — a body that did not load them must not claim [].
  media: { id: string; status: string; filename: string | null }
  upload: UploadInstruction
}

export interface IntentResponse {
  intents: UploadIntent[]
}

// The server's allowlist, mirrored for the picker's `accept` — and NEVER
// the authority: a `.mov` renamed `.jpg` passes any client check, the
// server's 422 is what refuses it, and CK-36's worker is what catches a
// lie the 422 cannot see. Extensions are listed as well as types because a
// HEIC's `file.type` is empty in the browser (observed at CK-36's (da)) and
// the picker filters by whichever the platform knows.
export const ACCEPTED_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]
export const PICKER_ACCEPT = [
  ...ACCEPTED_CONTENT_TYPES,
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.heic',
  '.heif',
].join(',')

// How often the list re-reads while a photograph is still moving (CK-36
// measured claim-to-ready at ~4.7 s, so a few seconds is the right grain);
// a page with nothing in flight polls nothing at all.
export const POLL_INTERVAL_MS = 3000

// The bin's read window (services/retention.py REMOVED_BIN) — stated in copy
// only. Since CK-63 a removed photograph is in the bin of WHOEVER REMOVED IT
// (two-bins record §3): an uploader only ever sees rows they removed
// themselves; a photograph an organiser removed or the host declined is in
// the gathering's bin, which the ORGANISERS — the host and any co-hosts —
// read (CK-66's `removed=true` view, its surface since CK-67, co-hosts in
// it since CK-68/CK-69) and the uploader never sees again.
export const REMOVED_BIN_DAYS = 30

// The takedown's second step (CK-67; the seat and the gate since CK-69),
// and — in its host form — the decline confirmation's non-own branch
// (CK-67.1's rule: the decline names the host's way back in the Remove
// step's words). It says WHO will still see the photograph and what the
// way back is, and stops naming the uploader: "nobody will see it, {who}
// included" was true only while the host was the one organiser, and false
// once the uploader could be an organiser themselves. From the host's seat
// the readers are "you and any co-hosts" — true whether or not co-hosts
// exist; from a co-host's, "the host and co-hosts". A co-host's Put back
// passes through the gate (two-bins §4), so where the gathering requires
// approval their sentence says what putting it back does: the host looks
// at it again before anyone else sees it. Nothing here promises anything
// at the window's end.
export function takedownSentence(viewer: { isHost: boolean; requiresApproval: boolean }): string {
  if (viewer.isHost) {
    return `Only you and any co-hosts will be able to see this photo. You can put it back for ${REMOVED_BIN_DAYS} days.`
  }
  if (viewer.requiresApproval) {
    return `Only the host and co-hosts will be able to see this photo. If you put it back within ${REMOVED_BIN_DAYS} days, the host will look at it again before anyone else sees it.`
  }
  return `Only the host and co-hosts will be able to see this photo. You can put it back for ${REMOVED_BIN_DAYS} days.`
}

// The three hints beside Put back — ONE constant each, never a second copy
// (CK-64 wrote the first two on the personal bin; CK-67 the third on the
// gathering's; CK-69 reuses them). Where the photograph goes is the
// SERVER's decision (the gate at restore time — never a parameter), and the
// hint only says what that decision will be from the reader's seat: the
// host's own restore, and any restore in an open gathering, goes live; an
// uploader's or a co-host's restore in a gated gathering waits for the
// host — told to the host as waiting for THEM, never as a person waiting
// on "the host", which would be themselves (the CK-43.1 seat rule).
export const RESTORE_HINT_EVERYONE = 'Everyone in this gathering will see it again.'
export const RESTORE_HINT_HOST_LOOKS = 'The host will look at it again before anyone else sees it.'
export const RESTORE_HINT_WAITS_FOR_YOU =
  "It'll wait for you to publish or decline it before anyone else sees it."

const DAY_MS = 24 * 60 * 60 * 1000

// How many more days the person can put a binned photograph back (CK-64):
// the window's close (`removed_at` + REMOVED_BIN_DAYS) against `now`,
// rounded UP to whole days, so a person is never told a smaller number than
// the truth while a day is still partly theirs — and CAPPED at
// REMOVED_BIN_DAYS (CK-64.1). 0 means LESS THAN A DAY is left — the last
// day, or a row the server would already have stopped listing — and it is
// never negative; null means the stamp could not be read. `now` is a
// parameter so nothing here depends on the clock.
//
// Two clocks meet here: `removed_at` is stamped by the SERVER's clock and
// `now` is read from the DEVICE's. (Not a timezone question — the stamp
// carries its offset.) When the device trails the server by even a second,
// a photograph binned a moment ago has the whole window plus that second
// left, and rounding up told the person "31 more days" (CK-64's check (he),
// on the deploy). The cap is the whole fix: the copy never promises more
// days than the server will honour. Below the cap a trailing clock only
// delays each day's tick by the skew, as a page left open delays it anyway.
// A device clock AHEAD of the server's errs the other way — near a day's
// turn, and at the end, the count can read one day short — and that is the
// acceptable direction, because it under-promises. Nothing here corrects
// for skew and no server time is sent to do it: the server's audience rule
// decides when the way back closes, whatever this number says.
//
// What the number is NOT: a countdown to deletion. At the window's close
// the person stops seeing the photograph and can no longer put it back —
// that is what the server's audience rule enforces today, and all of it.
// The automatic clear (CK-59's sweep) ships switched off, and until it is
// on nothing clears a bin; copy built on this number may claim only what
// is enforced.
export function binDaysLeft(removedAt: string, now: Date): number | null {
  const closes = Date.parse(removedAt) + REMOVED_BIN_DAYS * DAY_MS
  if (Number.isNaN(closes)) return null
  const remaining = closes - now.getTime()
  if (remaining < DAY_MS) return 0
  return Math.min(REMOVED_BIN_DAYS, Math.ceil(remaining / DAY_MS))
}

// The phrase the bin's line ends with, from the number above: nothing when
// there is no stamp to count from, the singular for one day, and "less
// than a day" for the last one.
function binWindowPhrase(days: number | null): string {
  if (days === null) return ''
  if (days === 0) return ' for less than a day'
  if (days === 1) return ' for 1 more day'
  return ` for ${days} more days`
}

const TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
}

// The content type the intent declares. `file.type` when the browser knows
// it; otherwise the extension — a HEIC arrives with an EMPTY type, and the
// declared value is signed into the presigned PUT, so a wrong or missing
// one produces an R2 refusal that reads like a permissions problem. A type
// nobody can name goes out as the generic binary type so the SERVER refuses
// it with its own message — the client never pre-empts the allowlist.
export function declaredContentType(file: { name: string; type: string }): string {
  if (file.type !== '') return file.type
  // The name trimmed (CK-40): a trailing space after the extension would
  // otherwise declare the generic type for a perfectly good HEIC.
  const name = file.name.trim()
  const dot = name.lastIndexOf('.')
  const extension = dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
  return TYPE_BY_EXTENSION[extension] ?? 'application/octet-stream'
}

// The 422 keys the intent form renders inline, per chosen file (the batch is
// refused whole, so every index the caller sent may carry an error) plus the
// batch-level key the quota, ceiling, and count refusals land on.
export function intentErrorFields(count: number): string[] {
  const fields = ['items']
  for (let index = 0; index < count; index++) {
    fields.push(
      `items.${index}.content_type`,
      `items.${index}.size_bytes`,
      `items.${index}.occurrence_id`,
      `items.${index}.filename`,
    )
  }
  return fields
}

// One intent item from one File — and from nothing else. `size_bytes` is
// `file.size` because the presigned PUT SIGNS Content-Length, which fetch
// forbids the client from setting: the browser derives it from the body, and
// the upload validates only while the declared size and the blob agree
// EXACTLY. A size captured anywhere else — a form field, a value recomputed
// after a resize or a strip — makes R2 reject on the signature, which reads
// as a credentials failure nowhere near the real cause (CK-39's (dp)). The
// filename is trimmed before it goes (the server trims too); a name that is
// blank after trimming is left out rather than sent for the server to
// refuse the whole batch over.
export function intentItem(file: File): {
  content_type: string
  size_bytes: number
  filename?: string
} {
  const filename = file.name.trim()
  return {
    content_type: declaredContentType(file),
    size_bytes: file.size,
    ...(filename === '' ? {} : { filename }),
  }
}

// What a row is called: the person's own words win, the file's name is the
// fallback, and "Photo" is what remains when there is neither — which is
// every row uploaded before CK-39, permanently, since nothing is backfilled.
export function mediaName(item: Pick<MediaItem, 'caption' | 'filename'>): string {
  if (item.caption !== null && item.caption !== '') return item.caption
  if (item.filename !== null && item.filename !== '') return item.filename
  return 'Photo'
}

// How long the search box waits after the last keystroke before asking the
// server: a request per keystroke against a substring scan is the wrong
// shape even at this size.
export const SEARCH_DEBOUNCE_MS = 300

// The list path, with `q` only when there is a term. An empty box sends no
// `q` at all — never an empty one — and a whitespace-only entry is the same
// as an empty box (the server treats blank as "not a search" too). Search
// is per gathering: the endpoint is, and so is this.
//
// The host's queue (CK-43.1) is the SAME list asked for with
// `awaiting_review=true` — a filter on the list, never a sibling route
// (record §10), so the surface has one list shape; it composes with `q`
// on the server, inside the audience rule. The flag goes only when the
// queue is what is wanted — never `awaiting_review=false`.
//
// The gathering's bin (CK-67, on CK-66's backend) is the same shape again:
// `removed=true` asks for the rows someone other than the uploader removed,
// which the server lists to the organisers — the host and, since CK-68, a
// co-host (anyone else reads an empty list, never a refusal that confirms
// the bin exists). The two flags together are
// the server's 422 — a photograph cannot be awaiting review and in the bin
// at once — so this function NEVER emits both: the views are exclusive by
// construction in the component, and a caller that passes both gets the
// queue alone. Never `removed=false`.
export function mediaListPath(
  gatheringId: string,
  term: string,
  options: { awaitingReview?: boolean; removed?: boolean } = {},
): string {
  const params: string[] = []
  if (options.awaitingReview) params.push('awaiting_review=true')
  else if (options.removed) params.push('removed=true')
  const trimmed = term.trim()
  if (trimmed !== '') params.push(`q=${encodeURIComponent(trimmed)}`)
  const base = `/gatherings/${gatheringId}/media`
  return params.length === 0 ? base : `${base}?${params.join('&')}`
}

// The caption under the Patch-semantics convention (CK-22 — the same four
// lines GatheringDetail's occurrence editor applies to location and map link;
// decisions/2026-08-27-optional-field-clearing.md). `undefined` means leave
// the field out of the patch; `null` means clear; a string is the value to
// store. Three rules: "had a saved caption, now blank" goes out as explicit
// null (never ""); "was empty, still empty" is omitted, never a null no-op
// write; a whitespace-only entry goes out AS TYPED so the server's
// blank-rejection 422 renders inline — the client never collapses whitespace
// into a clear, because blank is never a clear.
export function captionPatch(raw: string, saved: string | null): string | null | undefined {
  const savedText = saved ?? ''
  const trimmed = raw.trim()
  if (raw === '') return savedText === '' ? undefined : null
  if (trimmed === '') return raw
  return trimmed === savedText ? undefined : trimmed
}

// The tag list to send: EVERY tag the photograph should end up with, or
// nothing when the set is unchanged. The server REPLACES the set with what
// it receives — a patch carrying only the new tag would delete the others
// with no error and no warning, data loss that reads as a UI bug. So the
// editor's whole list goes, on an add and on a removal alike; `[]` is how
// the last tag is removed. Compared as sets of the exact strings (the
// server preserves case as typed, so a case change is a real edit; a tag
// removed and re-added is not).
export function tagsPatch(tags: string[], saved: string[]): string[] | undefined {
  const next = [...tags].sort()
  const current = [...saved].sort()
  const same = next.length === current.length && next.every((tag, index) => tag === current[index])
  return same ? undefined : tags
}

export interface MediaWords {
  caption: string
  tags: string[]
}

// The PATCH /media/{id} body for the editor's state against the saved row —
// merge-patch semantics: a field absent leaves the stored value alone. An
// empty object means nothing changed and no request should go.
export function mediaWordsPatch(
  form: MediaWords,
  saved: Pick<MediaItem, 'caption' | 'tags'>,
): { caption?: string | null; tags?: string[] } {
  const patch: { caption?: string | null; tags?: string[] } = {}
  const caption = captionPatch(form.caption, saved.caption)
  if (caption !== undefined) patch.caption = caption
  const tags = tagsPatch(form.tags, saved.tags)
  if (tags !== undefined) patch.tags = tags
  return patch
}

// The 422 keys the words editor renders inline: the caption, the tag list as
// a whole (the count refusal), and each sent tag by its index — a duplicate
// is refused on the entry that repeats it, and lands on that entry.
export function wordsErrorFields(tagCount: number): string[] {
  const fields = ['caption', 'tags']
  for (let index = 0; index < tagCount; index++) fields.push(`tags.${index}`)
  return fields
}

// `ready` and `failed` are the ladder's two ends; every other rung is a
// photograph still moving, and the list keeps re-reading while one exists.
export function isTerminal(item: Pick<MediaItem, 'status'>): boolean {
  return item.status === 'ready' || item.status === 'failed'
}

export function anyInFlight(items: Pick<MediaItem, 'status'>[]): boolean {
  return items.some((item) => !isTerminal(item))
}

// What the person is told about a row — A FUNCTION OF THE ROW'S STATE, NEVER
// A CONSTANT. `status` is the machine's answer (is it processed?);
// `publication_state` is the human's (who may see it?). Both are read from
// the row, so when the publication phase starts moving rows to `live`
// (decisions/2026-09-09-consent-gate-defaults.md §1: a private, person-owned
// gathering does not wait for anyone) this function changes nothing — the
// `live` branch is written now for a case nothing reaches yet, exactly as
// CK-37 wrote its `live` audience branch.
//
// Two things this copy may never say for a gathering that resolves OPEN
// (consent-gate-defaults §9; the CK-37 record's DATA-HANDLING): that anyone
// will review or has approved the photograph — for a family gathering nobody
// ever will, so that copy is wrong today and wrong after the fix — and that
// a `pending` photograph is shared or visible to the gathering. It is not;
// the audience rule is what makes that true. The `failed` line names the
// outcome, never the file's contents (pipeline record §6.5: "we couldn't
// process this photo", not "corrupt").
//
// A `ready` row that is `pending` is WAITING — for the host, who can act on
// it (the-hosts-review §8, restated at 1.2.0 by CK-44): the host's queue
// renders while anything waits, whatever the gathering's own switch says
// (§13 — the strand rule), so on every such row someone genuinely can
// decide, and the line saying nothing about it would be a lie in the other
// direction. So the pending line carries a second sentence saying what the
// photograph waits on — a function of the ROW alone, with no gathering-level
// flag: CK-43.1's `gated` parameter is gone, because "gated" was never the
// accurate condition (an open gathering can hold a waiting row; a gated one
// with nothing waiting has no line to write). It is read by the uploader,
// who may not be the host, and by the host, who in a family gathering
// usually IS the uploader — so the host's copy addresses them as the one
// who decides ("waiting for you"), never as a person waiting on "the host",
// which would be themselves. Both readings are true at once. Nothing here
// names the product as the reviewer: a host publishes or declines. Where
// nothing waits there is no such row, and no line names a reviewer.
export function mediaStateMessage(
  item: Pick<MediaItem, 'status' | 'publication_state' | 'is_own' | 'uploader_display_name'> & {
    // The bin clock (CK-64), read on a removed row for the days-left phrase;
    // optional so a caller that does not carry it still gets an honest line.
    removed_at?: string | null
  },
  // The reader's seat. `isHost` means THE HOST ALONE on every line: the
  // pending lines stay true with it (`pending` is the host's and the
  // uploader's — a co-host's own waiting photograph rightly reads "Only you
  // and the host can see this"), and the removed branch reads it beside
  // `organises` (the host or a co-host, CK-69) to say who can see a row in
  // the gathering's bin. `gatheringBin` says the row is being read IN the
  // Removed view, which lists gathering-bin rows only (CK-66) — so an
  // organiser's OWN photograph that another organiser removed is read as
  // the gathering's, never as "in your bin". `now` is injectable so the
  // days-left phrase never depends on the clock in a test; the product
  // passes nothing and reads the real one.
  viewer: { isHost: boolean; organises?: boolean; gatheringBin?: boolean; now?: Date },
): string {
  switch (item.status) {
    case 'pending_upload':
      return 'On its way — still being uploaded.'
    case 'uploaded':
      return 'Uploaded — waiting to be prepared.'
    case 'processing':
      return 'Being prepared — usually within a minute, longer for a big batch.'
    case 'failed':
      return "We couldn't process this photo."
    case 'ready':
      break
    default:
      // A rung this build does not know: name it rather than show nothing.
      return `Status: ${item.status}.`
  }

  // Ready: who may see it is decided by publication_state
  // (decisions/2026-09-09-who-may-see-an-unapproved-photograph.md §1).
  switch (item.publication_state) {
    case 'live':
      return 'Everyone in this gathering can see it.'
    case 'pending': {
      // The uploader and the host, and nobody else. Spelled from the
      // viewer's seat: the two admitted people collapse to one when the
      // uploader is the host.
      const uploader = item.uploader_display_name ?? 'the person who added it'
      const audience = item.is_own
        ? viewer.isHost
          ? 'Only you can see this.'
          : 'Only you and the host can see this.'
        : viewer.isHost
          ? `Only ${uploader} and you can see this.`
          : `Only ${uploader} and the host can see this.`
      // What it waits on, from the same seat. The host decides, so the
      // host is told it waits for them — the common case in a family
      // gathering is a host reading their own photograph.
      return viewer.isHost
        ? `${audience} Waiting for you to publish or decline it.`
        : `${audience} Waiting for the host to publish or decline it.`
    }
    case 'removed': {
      // Since CK-63 the server lists a removed row to its uploader ONLY when
      // the uploader removed it (your bin, not the gathering's), and since
      // CK-66 to the ORGANISERS — the host, and since CK-68 a co-host —
      // when someone other than the uploader removed it (the gathering's
      // bin, whose view is CK-67's `removed=true`). So a removed row a
      // person can see is either their own — the personal line — or, for
      // an organiser, one in the gathering's bin: someone else's, or (in
      // the Removed view, which lists gathering-bin rows only) their OWN
      // that another organiser removed. A non-organiser reading someone
      // else's removed row is unreachable by the audience rule; that branch
      // stays "Removed.", defensive.
      //
      // Since CK-64 the person can put a row of theirs back or delete it
      // for good, so each line says what the bin IS from the reader's side:
      // theirs alone, or — in the gathering's bin — the organisers': "you
      // and any co-hosts" from the host's seat (true whether or not co-hosts
      // exist), "the host and co-hosts" from a co-host's. Neither says
      // ANYTHING about what happens at the window's end — not "deleted
      // after", not "emptied", not "cleared" — because nothing is enforced
      // there today: the automatic clear (CK-59's sweep) ships switched
      // off, and until it is on nothing clears a bin. What IS enforced is
      // that at the window's close the reader stops seeing the photograph
      // and can no longer put it back, and "you can put it back for N more
      // days" claims exactly that and no more. (Until CK-64: "Removed.
      // Only you can still see it, for 30 days after removal."; until CK-67
      // the non-own branch was "Removed." for every viewer, the bin having
      // had no reader; until CK-69 the host's line said "Only you can see
      // it", true while the host was the one organiser.)
      const days =
        item.removed_at === undefined || item.removed_at === null
          ? null
          : binDaysLeft(item.removed_at, viewer.now ?? new Date())
      if (viewer.gatheringBin === true || !item.is_own) {
        if (viewer.isHost) {
          return `Removed from this gathering. Only you and any co-hosts can see it, and you can put it back${binWindowPhrase(days)}.`
        }
        if (viewer.organises === true) {
          return `Removed from this gathering. Only the host and co-hosts can see it, and you can put it back${binWindowPhrase(days)}.`
        }
        return 'Removed.'
      }
      return `In your bin. Only you can see it, and you can put it back${binWindowPhrase(days)}.`
    }
    default:
      return `Ready — ${item.publication_state}.`
  }
}

// ---------------------------------------------------------------------------
// The host's review (CK-43.1). The queue is the list with the flag; the two
// acts are below; the batch lives in the component beside the upload batch.
// ---------------------------------------------------------------------------

// What the host may act on: a `ready` row that is `pending` (record §3) —
// the server's own criterion for the queue, mirrored here ONLY to decide
// whether a row carries the publish and decline controls. It is a predicate
// over the row's own state, never state of its own: an affordance on a row
// the server would refuse (a `live` one, a `failed` one) is its own defect.
export function awaitingReview(item: Pick<MediaItem, 'status' | 'publication_state'>): boolean {
  return item.status === 'ready' && item.publication_state === 'pending'
}

// The list-level half of the same predicate (CK-44; the-hosts-review §13):
// whether anything the caller can see is waiting. The host's review renders
// while review is ON or while this is true — `isHost && (requiresApproval
// || anyWaiting(items))` — so a photograph that was waiting when the host
// turned review off is never stranded: the queue and both acts stay
// reachable until the host decides it. Derived from the list as loaded,
// never remembered (a waiting row a search term hides is not on the screen,
// and the switch follows the screen); nothing is published on the way off.
export function anyWaiting(items: Pick<MediaItem, 'status' | 'publication_state'>[]): boolean {
  return items.some(awaitingReview)
}

// The batch endpoint takes up to fifty ids (api-reference, the batch form).
export const MAX_PUBLISH_BATCH = 50

export type ReviewAct = 'publish' | 'decline'

export type ReviewOutcome =
  | { ok: true }
  // The 409's stable code (already_live | not_pending | not_ready) with the
  // state the server reports beside it, `not_found` for the 404 (the row
  // moved out of the host's sight — a removed row is in its REMOVER's bin,
  // two-bins record §3; one someone else removed is in the gathering's bin,
  // the organisers' Removed view — the host's since CK-67, a co-host's too
  // since CK-69), or this module's own words for the rest. The server's
  // `message` is NOT carried: the codes are the contract, the strings are
  // ours (record §3).
  | { ok: false; code: string; publication_state?: string; status?: string }

// One act on one photograph. A guarded update on the server: a row that
// moved since the list was read is refused with its current state, never
// changed, and the code says which state that is.
export async function reviewMedia(mediaId: string, act: ReviewAct): Promise<ReviewOutcome> {
  try {
    const response = await authFetch(`/media/${mediaId}/${act}`, { method: 'POST' })
    if (response.ok) return { ok: true }
    if (response.status === 404) return { ok: false, code: 'not_found' }
    if (response.status === 409) {
      const body = (await response.json().catch(() => null)) as {
        detail?: { code?: string; publication_state?: string; status?: string }
      } | null
      return {
        ok: false,
        code: body?.detail?.code ?? 'failed',
        publication_state: body?.detail?.publication_state,
        status: body?.detail?.status,
      }
    }
    return { ok: false, code: 'failed' }
  } catch {
    return { ok: false, code: 'unreachable' }
  }
}

// What a refused act tells the host — switched on the CODE and never the
// wording (record §3: the codes are the contract, the strings are ours), so
// a reworded server message changes nothing here. Each line says what state
// the photograph is actually in, and none claims anything was destroyed:
// a declined photograph is in the GATHERING's bin (two-bins record §3,
// CK-63) — out of its uploader's sight for good, and readable by the
// organisers in the Removed view (the host since CK-67, a co-host since
// CK-69) — and none of these lines promises the UPLOADER a way back.
export function reviewRefusalMessage(
  act: ReviewAct,
  refusal: { code: string; publication_state?: string; status?: string },
): string {
  switch (refusal.code) {
    case 'already_live':
      return 'This photo is already published — everyone in this gathering can see it.'
    case 'not_pending':
      if (refusal.publication_state === 'live') {
        // Decline on a published photograph: decline is the review's act
        // and stops at publication, but since CK-67 the host CAN take a
        // published photograph down — Remove from gathering, on the row —
        // so the line names the control instead of a dead end. (Until
        // CK-67: "…taking a published photo down isn't possible here
        // yet.", true while the takedown had no surface.)
        return act === 'publish'
          ? 'This photo is already published — everyone in this gathering can see it.'
          : 'This photo is already published — to take it down, use Remove from gathering.'
      }
      return act === 'publish'
        ? "This photo was declined or removed, so it can't be published."
        : 'This photo was already declined or removed.'
    case 'not_ready':
      return refusal.status === 'failed'
        ? "This photo couldn't be processed, so there's nothing to publish."
        : "This photo isn't ready yet — it can't be published or declined until it is."
    case 'not_found':
      return "This photo isn't here any more — refresh the list to see what's waiting."
    case 'unreachable':
      return networkErrors().form[0]
    default:
      return 'Something went wrong. Nothing changed — try again.'
  }
}

// The 422 keys the batch form renders inline: the list as a whole (the
// count bounds) and each sent id by its index — the server refuses the
// batch WHOLE on the first bad entry and lands the refusal on that entry
// (`["body","media_ids",N]`), carrying the single act's code beside the
// message, so the one mapper renders it on the row that caused it.
export function publishBatchErrorFields(count: number): string[] {
  const fields = ['media_ids']
  for (let index = 0; index < count; index++) fields.push(`media_ids.${index}`)
  return fields
}

// ---------------------------------------------------------------------------
// Your own photographs (CK-64; two-bins record §1, §2, §4). Three acts on a
// row the caller uploaded — to the bin, back from it, and gone for good —
// each an endpoint that already existed (CK-54's remove and destroy, CK-63's
// restore) and none of which had a control until now. YOUR BIN IS YOURS:
// only the uploader sees a self-removed photograph, puts it back, or deletes
// it for good; the host, a co-host and the keeper cannot see or touch it,
// and the component offers these on the caller's own rows and nowhere else.
// ---------------------------------------------------------------------------

export type BinAct = 'remove' | 'restore' | 'destroy'

export type BinOutcome =
  | { ok: true }
  // The 409's stable code — `already_removed` (remove), `not_removed`
  // (restore), `not_ready` (any act, carrying the rung), and `not_pending`,
  // which is THE LOST RACE on all three acts (api-reference: the row moved
  // between the read and the guarded write — the sweep marked it, or a
  // second act landed first — and nothing changed), not a removal-specific
  // code; `not_found` for the 404 (a row that is not the caller's to act on
  // draws the 404 byte-identical to a missing id, so it is also what a row
  // answers once the sweep has taken it); or this module's own words for
  // the rest. The server's `message` is NOT carried: the codes are the
  // contract, the strings are ours.
  | { ok: false; code: string; publication_state?: string; status?: string }

// One act on one of the caller's own photographs — `reviewMedia`'s shape,
// deliberately: one POST with no body, a guarded update on the server that
// refuses a moved row with its current state and changes nothing.
export async function binMedia(mediaId: string, act: BinAct): Promise<BinOutcome> {
  try {
    const response = await authFetch(`/media/${mediaId}/${act}`, { method: 'POST' })
    if (response.ok) return { ok: true }
    if (response.status === 404) return { ok: false, code: 'not_found' }
    if (response.status === 409) {
      const body = (await response.json().catch(() => null)) as {
        detail?: { code?: string; publication_state?: string; status?: string }
      } | null
      return {
        ok: false,
        code: body?.detail?.code ?? 'failed',
        publication_state: body?.detail?.publication_state,
        status: body?.detail?.status,
      }
    }
    return { ok: false, code: 'failed' }
  } catch {
    return { ok: false, code: 'unreachable' }
  }
}

// What a refused act tells the person — switched on the CODE and never the
// wording, so a reworded server message changes nothing here. Each line says
// what state the photograph is actually in, and none claims anything was
// deleted or put back when it was not: a refusal changed nothing, and the
// list re-read is the way to see what is true now.
//
// The act's CONTEXT decides whose bin the two bin-specific lines name
// (CK-69): a personal act — on the caller's own row — says "your bin"
// (CK-64's lines, unchanged); the takedown and the acts in the Removed view
// are on the GATHERING's bin, where "your bin" is false and where, with
// several organisers, the races behind these codes are real — another
// organiser removed it first, or put it back first.
export function binRefusalMessage(
  refusal: { code: string; status?: string },
  context: { bin?: 'personal' | 'gathering' } = {},
): string {
  const gathering = context.bin === 'gathering'
  switch (refusal.code) {
    case 'not_found':
      return "This photo isn't here any more — refresh the list to see what is."
    case 'not_ready':
      return refusal.status === 'failed'
        ? "This photo couldn't be processed, so there's nothing stored to act on."
        : "This photo isn't ready yet — it can't be sent to the bin, put back or deleted until it is."
    case 'already_removed':
      return gathering
        ? 'This photo has already been removed — refresh the list to see where it is.'
        : 'This photo is already in your bin.'
    case 'not_removed':
      return gathering
        ? "This photo isn't in the gathering's bin any more — refresh the list to see where it is."
        : "This photo isn't in your bin any more — refresh the list to see where it is."
    case 'not_pending':
      // The lost race, on any of the three: the row moved between the read
      // and the write, and the server changed nothing.
      return 'This photo changed while you were looking at it — refresh the list and try again.'
    case 'unreachable':
      return networkErrors().form[0]
    default:
      return 'Something went wrong. Nothing changed — try again.'
  }
}

// The permanent delete's second step, verbatim from the bin record §7.1 and
// binding through the two-bins record §4 — character for character, never
// reworded. "From <the product>" is load-bearing: a photograph already in a
// printed book is out of reach, so the sentence promises removal from the
// product and not from the world. The name flows from brand.ts like every
// user-visible brand string (CK-14), and the rendered sentence is pinned as
// a literal.
export const DELETE_PERMANENTLY_CONFIRMATION = `Are you sure? This will permanently remove the photo from ${PRODUCT_NAME} and cannot be recovered.`

// ---------------------------------------------------------------------------
// The two calls that spend a presigned URL. Nothing below returns one.
// ---------------------------------------------------------------------------

export type PutOutcome = 'stored' | 'refused' | 'unreachable'

// The one PUT. Sends the Content-Type R2 signed (the declared type, exactly
// as the server normalised it) and lets the browser set Content-Length from
// the body — setting it by hand is forbidden in fetch, and the body IS the
// declared size, which is what makes the signature match. No Authorization
// header: this is not our API, and a bearer JWT must never travel to R2.
export async function putUpload(file: Blob, upload: UploadInstruction): Promise<PutOutcome> {
  try {
    const response = await fetch(upload.url, {
      method: upload.method,
      headers: { 'Content-Type': upload.headers['Content-Type'] },
      body: file,
      credentials: 'omit',
    })
    return response.ok ? 'stored' : 'refused'
  } catch {
    // A network failure or a CORS refusal at preflight — the kickoff names
    // the latter as bucket configuration, an out-of-band fix, not a code bug.
    return 'unreachable'
  }
}

export type ConfirmOutcome =
  | { ok: true }
  // The 409's stable code (object_missing | size_mismatch | not_pending), the
  // 503's storage_unavailable, or this module's own words for the rest.
  | { ok: false; code: string }

// Confirm is the server VERIFYING rather than trusting: it HEADs the key and
// moves the row only if the object is there at the declared size.
export async function confirmUpload(mediaId: string): Promise<ConfirmOutcome> {
  try {
    const response = await authFetch(`/media/${mediaId}/confirm`, { method: 'POST' })
    if (response.ok) return { ok: true }
    if (response.status === 409 || response.status === 503) {
      const body = (await response.json().catch(() => null)) as {
        detail?: { code?: string }
      } | null
      return { ok: false, code: body?.detail?.code ?? 'failed' }
    }
    return { ok: false, code: 'failed' }
  } catch {
    return { ok: false, code: 'unreachable' }
  }
}

export type LayerOutcome =
  | { ok: true; objectUrl: string }
  // not_ready: the row is visible but has no object yet (409). unavailable:
  // anything else — including a CORS refusal on the published bucket, which
  // is the bucket's configuration, not this code's.
  | { ok: false; reason: 'not_ready' | 'unavailable' }

// One layer of one ready photograph, as bytes in this browser. Mints the
// presigned GET through our API, spends it on ONE fetch, and hands back a
// `blob:` object URL — which is what goes into an <img> and into state. The
// presigned URL itself is a local of this function and dies with it. The
// caller owns the object URL and revokes it when done (URL.revokeObjectURL).
// Never `archival`: the print master is never served (CK-37 refuses it).
export async function fetchLayerObjectUrl(
  mediaId: string,
  layer: ServableLayer,
): Promise<LayerOutcome> {
  try {
    const minted = await authFetch(`/media/${mediaId}/url?layer=${layer}`)
    if (minted.status === 409) return { ok: false, reason: 'not_ready' }
    if (!minted.ok) return { ok: false, reason: 'unavailable' }
    const body = (await minted.json()) as { url: string; method: string }
    const object = await fetch(body.url, { method: body.method, credentials: 'omit' })
    if (!object.ok) return { ok: false, reason: 'unavailable' }
    return { ok: true, objectUrl: URL.createObjectURL(await object.blob()) }
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
}
