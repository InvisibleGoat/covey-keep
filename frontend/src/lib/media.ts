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
// pending line becomes conditional on the gathering resolving gated
// (mediaStateMessage's `gated` — record §8: where nobody reviews, the line
// says who can see the photograph and nothing about what it waits on).
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

// The bin's read window (api/media.py REMOVED_BIN) — stated in copy only.
export const REMOVED_BIN_DAYS = 30

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
export function mediaListPath(
  gatheringId: string,
  term: string,
  options: { awaitingReview?: boolean } = {},
): string {
  const params: string[] = []
  if (options.awaitingReview) params.push('awaiting_review=true')
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
// Where the gathering resolves GATED (`viewer.gated` — the detail body's
// effective `requires_approval`, CK-41) someone genuinely does decide, and
// the pending line saying nothing about it would be the opposite lie
// (the-hosts-review §8). So, and only then, the line gains a second
// sentence saying what the photograph waits on. It is read by the uploader,
// who may not be the host, and by the host, who in a family gathering
// usually IS the uploader — so the host's copy addresses them as the one
// who decides ("waiting for you"), never as a person waiting on "the host",
// which would be themselves. Both readings are true at once. Nothing here
// names the product as the reviewer: a host publishes or declines.
export function mediaStateMessage(
  item: Pick<MediaItem, 'status' | 'publication_state' | 'is_own' | 'uploader_display_name'>,
  viewer: { isHost: boolean; gated?: boolean },
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
      if (!viewer.gated) return audience
      // Gated: what it waits on, from the same seat. The host decides, so
      // the host is told it waits for them — the common case in a family
      // gathering is a host reading their own photograph.
      return viewer.isHost
        ? `${audience} Waiting for you to publish or decline it.`
        : `${audience} Waiting for the host to publish or decline it.`
    }
    case 'removed':
      return item.is_own
        ? `Removed. Only you can still see it, for ${REMOVED_BIN_DAYS} days after removal.`
        : 'Removed.'
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

// The batch endpoint takes up to fifty ids (api-reference, the batch form).
export const MAX_PUBLISH_BATCH = 50

export type ReviewAct = 'publish' | 'decline'

export type ReviewOutcome =
  | { ok: true }
  // The 409's stable code (already_live | not_pending | not_ready) with the
  // state the server reports beside it, `not_found` for the 404 (the row
  // moved out of the host's sight — the bin is the uploader's), or this
  // module's own words for the rest. The server's `message` is NOT carried:
  // the codes are the contract, the strings are ours (record §3).
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
// a declined photograph is in its uploader's bin for thirty days.
export function reviewRefusalMessage(
  act: ReviewAct,
  refusal: { code: string; publication_state?: string; status?: string },
): string {
  switch (refusal.code) {
    case 'already_live':
      return 'This photo is already published — everyone in this gathering can see it.'
    case 'not_pending':
      if (refusal.publication_state === 'live') {
        // Decline on a published photograph: the takedown is unbuilt
        // (record §11), and the copy says so rather than pretending.
        return act === 'publish'
          ? 'This photo is already published — everyone in this gathering can see it.'
          : "This photo is already published, and taking a published photo down isn't possible here yet."
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
