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
import { authFetch } from './api'

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
  media: { id: string; status: string }
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
  const dot = file.name.lastIndexOf('.')
  const extension = dot === -1 ? '' : file.name.slice(dot + 1).toLowerCase()
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
    )
  }
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
// Two things this copy may never say (consent-gate-defaults §9; the CK-37
// record's DATA-HANDLING): that anyone will review or has approved the
// photograph — for a family gathering nobody ever will, so that copy is wrong
// today and wrong after the fix — and that a `pending` photograph is shared
// or visible to the gathering. It is not; the audience rule is what makes
// that true. The `failed` line names the outcome, never the file's contents
// (pipeline record §6.5: "we couldn't process this photo", not "corrupt").
export function mediaStateMessage(
  item: Pick<MediaItem, 'status' | 'publication_state' | 'is_own' | 'uploader_display_name'>,
  viewer: { isHost: boolean },
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
      if (item.is_own) {
        return viewer.isHost ? 'Only you can see this.' : 'Only you and the host can see this.'
      }
      return viewer.isHost
        ? `Only ${uploader} and you can see this.`
        : `Only ${uploader} and the host can see this.`
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
