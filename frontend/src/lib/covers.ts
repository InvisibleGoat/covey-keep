// Covers on the surface (CK-84; the backend is CK-83a's and CK-83b's —
// reference/backend/api-reference.md, the Covers router;
// decisions/2026-10-31-the-design-and-how-it-is-merged.md §1.3, §3 item 4).
// A gathering and a group each carry a cover: one of the gathering's
// published photographs, or a picture an organiser uploaded. This module
// holds the type, the read, the cache that keeps the menu from re-reading
// every cover on every page, the signal that tells the menu a cover moved,
// the calls that set, clear and upload one, and every line the surface says.
//
// THE RULE THE PHOTOGRAPHS KEEP, KEPT HERE TOO (lib/media.ts, CK-38): a
// presigned URL — the GET the cover URL route mints, the PUT the upload
// intent issues — is a bearer credential. It is spent on exactly ONE fetch
// and exists nowhere else: never in React state, never in the DOM, never in
// a log, an error or another request. The read hands back a `blob:` object
// URL, which carries no credential; the upload hands back the cover image's
// id and never the instruction it spent.
//
// A GROUP'S COVER NEVER NAMES ITS PHOTOGRAPH (CK-83a's rule): a group body's
// `cover` carries the source and the version and nothing else, and nothing
// here asks a group for more. A gathering's photo cover names its
// photograph — one of the gathering's own published photographs, seen by
// everyone who can read the gathering — so the viewer can hide Use as cover
// on the photograph that already is it.
//
// THE SERVER'S WORDS ARE NEVER SHOWN: every refusal is a code, mapped below
// to an approved line or the house line. The intent's 422s name *a photo*,
// and a cover is a picture.
import { authFetch } from './api'
import {
  declaredContentType,
  putUpload,
  type ServableLayer,
  type UploadInstruction,
} from './media'
import { subscribe } from './session'

export type CoverSubject = 'gathering' | 'group'

// `cover` on every gathering and group body, list items included (CK-83a,
// CK-83b): `{"source": "photo", "media_id", "set_at"}` on a gathering whose
// cover is one of its photographs, `{"source": "upload", "set_at"}` for an
// uploaded picture, and `{"source", "set_at"}` alone on a group — never the
// photograph. Null until an organiser sets one. `set_at` is the cover's
// VERSION: it moves whenever the cover does, and the cache keys on it.
// Optional on the body types, so a body that carries no `cover` — every
// fixture written before CK-84 — reads as none and draws the empty cover.
export interface CoverBody {
  // Typed loosely, as a media row's rung is: a source this build does not
  // know still draws the picture the URL route serves.
  source: 'photo' | 'upload' | string
  media_id?: string
  set_at: string
}

function subjectPath(subject: CoverSubject, id: string): string {
  return subject === 'gathering' ? `/gatherings/${id}` : `/groups/${id}`
}

// ---------------------------------------------------------------------------
// The read: one layer of the subject's cover, as bytes in this browser.
// ---------------------------------------------------------------------------

export type CoverPictureOutcome =
  | { ok: true; objectUrl: string }
  // `no_cover`: the 409 — the cover was cleared after the body was read, so
  // the empty cover is the truth. `unavailable`: anything else, a CORS
  // refusal on the published bucket included (its configuration, not this
  // code's).
  | { ok: false; reason: 'no_cover' | 'unavailable' }

// Mints the presigned GET through the subject's cover URL route, spends it on
// ONE fetch with no credentials, and hands back a `blob:` object URL. The
// presigned URL is a local of this function and dies with it. Never
// `archival` — the type admits only the two layers the route serves.
export async function fetchCoverObjectUrl(
  subject: CoverSubject,
  id: string,
  layer: ServableLayer,
): Promise<CoverPictureOutcome> {
  try {
    const minted = await authFetch(`${subjectPath(subject, id)}/cover/url?layer=${layer}`)
    if (minted.status === 409) return { ok: false, reason: 'no_cover' }
    if (!minted.ok) return { ok: false, reason: 'unavailable' }
    const body = (await minted.json()) as { url: string; method: string }
    const object = await fetch(body.url, { method: body.method, credentials: 'omit' })
    if (!object.ok) return { ok: false, reason: 'unavailable' }
    return { ok: true, objectUrl: URL.createObjectURL(await object.blob()) }
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
}

// ---------------------------------------------------------------------------
// The cache. The menu re-reads its two lists on every page change (CK-82),
// and a list can hold many rows: without this, every navigation would mint
// and fetch every thumbnail again. One entry per subject, id and layer —
// the newest version (`set_at`) seen — holding the object URL, or the
// promise of it, so concurrent asks share one fetch.
// ---------------------------------------------------------------------------

interface Entry {
  setAt: string
  at: number
  promise: Promise<CoverPictureOutcome>
  objectUrl: string | null
  dropped: boolean
}

const entries = new Map<string, Entry>()

function keyOf(subject: CoverSubject, id: string, layer: ServableLayer): string {
  return `${subject}:${id}:${layer}`
}

function drop(key: string, entry: Entry): void {
  entry.dropped = true
  if (entry.objectUrl !== null) URL.revokeObjectURL(entry.objectUrl)
  entry.objectUrl = null
  if (entries.get(key) === entry) entries.delete(key)
}

// One layer of a subject's cover at one version. The same version asked
// again — by another row, or by the menu after a navigation — answers from
// the entry, fetching nothing. A NEWER version revokes the older object URL
// and drops its entry before fetching. An OLDER version (a body read before
// the cover moved, still on screen beside a fresher one) is answered by the
// entry held: the URL route serves the current cover whatever version the
// asker read, so the bytes would be the same. A refusal is not kept, so the
// next ask tries again.
export function loadCoverPicture(
  subject: CoverSubject,
  id: string,
  layer: ServableLayer,
  setAt: string,
): Promise<CoverPictureOutcome> {
  const key = keyOf(subject, id, layer)
  const held = entries.get(key)
  if (held !== undefined) {
    if (held.setAt === setAt) return held.promise
    // Provably older only: an unparsable version is treated as newer, so a
    // version this build cannot read never pins a stale picture.
    if (Date.parse(setAt) < held.at) return held.promise
    drop(key, held)
  }
  const entry: Entry = {
    setAt,
    at: Date.parse(setAt),
    objectUrl: null,
    dropped: false,
    promise: Promise.resolve({ ok: false, reason: 'unavailable' }),
  }
  entry.promise = fetchCoverObjectUrl(subject, id, layer).then((outcome) => {
    if (entry.dropped) {
      // Dropped while in flight — a newer version arrived, or the session
      // ended. These bytes are nobody's: revoke them at once, and answer
      // with whatever now stands for the subject, if anything does.
      if (outcome.ok) URL.revokeObjectURL(outcome.objectUrl)
      const current = entries.get(key)
      return current !== undefined
        ? current.promise
        : { ok: false as const, reason: 'unavailable' as const }
    }
    if (outcome.ok) entry.objectUrl = outcome.objectUrl
    else if (entries.get(key) === entry) entries.delete(key)
    return outcome
  })
  entries.set(key, entry)
  return entry.promise
}

// A subject's cover is gone (a clear landed): both layers' object URLs are
// revoked and their entries dropped, so nothing of it stays in memory.
export function forgetCoverPicture(subject: CoverSubject, id: string): void {
  for (const layer of ['web', 'thumbnail'] as const) {
    const key = keyOf(subject, id, layer)
    const held = entries.get(key)
    if (held !== undefined) drop(key, held)
  }
}

// Every object URL revoked and the cache emptied.
export function clearCoverPictures(): void {
  for (const [key, entry] of [...entries]) drop(key, entry)
}

// WHEN THE SESSION CHANGES, NOTHING OF THE LAST ONE'S COVERS SURVIVES:
// `clearToken()` (a sign-out, a 401, an account deleted) and `setToken()` (a
// sign-in) both notify lib/session.ts's listeners, and either way the cache
// is emptied — so on a shared device no picture one person could see
// outlives their session in this tab's memory.
subscribe(clearCoverPictures)

// ---------------------------------------------------------------------------
// The change signal: a page that lands a cover act — a set, a clear, an
// upload reaching `ready` — announces it, and the menu re-reads its two
// lists at once rather than at the next navigation. It carries nothing:
// the lists' own bodies say what changed.
// ---------------------------------------------------------------------------

const changeListeners = new Set<() => void>()

export function announceCoverChange(): void {
  for (const listener of changeListeners) listener()
}

export function onCoverChange(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}

// ---------------------------------------------------------------------------
// Setting from a photograph, and clearing.
// ---------------------------------------------------------------------------

export type CoverSetOutcome = { ok: true; cover: CoverBody | null } | { ok: false }

// Use as cover / Use as the group's cover: `PUT …/cover` with exactly
// `{"media_id"}`. The 200's `cover` is the subject's cover now — the page
// renders it at once. Every refusal (`not_published`, `not_in_gathering`,
// `not_in_group`, the media 404, the subject's 404, a network failure) is the
// house line: none can be fixed from the viewer, and nothing changed.
export async function setCoverFromPhoto(
  subject: CoverSubject,
  id: string,
  mediaId: string,
): Promise<CoverSetOutcome> {
  try {
    const response = await authFetch(`${subjectPath(subject, id)}/cover`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ media_id: mediaId }),
    })
    if (!response.ok) return { ok: false }
    const body = (await response.json()) as { cover?: CoverBody | null }
    return { ok: true, cover: body.cover ?? null }
  } catch {
    return { ok: false }
  }
}

// Remove cover: `DELETE …/cover`, a 204 whether or not a cover was set — the
// state asked for is the state that holds.
export async function clearCover(subject: CoverSubject, id: string): Promise<{ ok: boolean }> {
  try {
    const response = await authFetch(`${subjectPath(subject, id)}/cover`, { method: 'DELETE' })
    return { ok: response.status === 204 }
  } catch {
    return { ok: false }
  }
}

// ---------------------------------------------------------------------------
// Uploading a picture: the intent, the PUT, the confirm — then the page
// follows the cover image to `ready` through readCoverImage.
// ---------------------------------------------------------------------------

// Why an upload will not be the cover, as the line it reads:
//   superseded — a later act on the subject won (the latest act wins);
//   unreadable — the picture cannot be opened (the worker's `unreadable`, or
//                the intent's 422 on `content_type`);
//   too_large  — the worker's `too_large`, or the intent's 422 on
//                `size_bytes` (the 25 MB cap);
//   failed     — anything else.
export type CoverFailure = 'superseded' | 'unreadable' | 'too_large' | 'failed'

export type CoverUploadOutcome = { ok: true; coverImageId: string } | { ok: false; code: CoverFailure }

interface CoverIntent {
  cover_image: { id: string; status: string }
  upload: UploadInstruction
}

async function intentRefusal(response: Response): Promise<CoverFailure> {
  if (response.status !== 422) return 'failed'
  const body = (await response.json().catch(() => null)) as { detail?: unknown } | null
  if (!Array.isArray(body?.detail)) return 'failed'
  const fields = body.detail.map((entry) => {
    const loc = (entry as { loc?: unknown }).loc
    return Array.isArray(loc) ? String(loc[loc.length - 1]) : ''
  })
  // A type the allowlist refuses is the answer even beside an oversize: no
  // smaller copy of a file that is not a picture would work.
  if (fields.includes('content_type')) return 'unreadable'
  if (fields.includes('size_bytes')) return 'too_large'
  return 'failed'
}

// The three steps that put a picture in quarantine and ask the worker for
// it, run to the end whatever the page does meanwhile — a person who
// navigates away mid-upload still gets the cover, because nothing here waits
// on a component. The intent's body is EXACTLY `{content_type, size_bytes}`
// (the route forbids anything else, a filename included): the type through
// declaredContentType (a HEIC's `file.type` is empty), the size from the
// File — the PUT signs both. THE INTENT'S UPLOAD INSTRUCTION IS A LOCAL OF
// THIS FUNCTION, spent on the one PUT and never returned.
export async function uploadCoverPicture(
  subject: CoverSubject,
  id: string,
  file: File,
): Promise<CoverUploadOutcome> {
  let intent: CoverIntent
  try {
    const response = await authFetch(`${subjectPath(subject, id)}/cover/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content_type: declaredContentType(file), size_bytes: file.size }),
    })
    if (response.status !== 201) return { ok: false, code: await intentRefusal(response) }
    intent = (await response.json()) as CoverIntent
  } catch {
    return { ok: false, code: 'failed' }
  }
  const put = await putUpload(file, intent.upload)
  if (put !== 'stored') return { ok: false, code: 'failed' }
  const coverImageId = intent.cover_image.id
  try {
    const response = await authFetch(`/cover-images/${coverImageId}/confirm`, { method: 'POST' })
    if (response.ok) return { ok: true, coverImageId }
    if (response.status === 409) {
      const body = (await response.json().catch(() => null)) as { detail?: { code?: string } } | null
      if (body?.detail?.code === 'superseded') return { ok: false, code: 'superseded' }
    }
    return { ok: false, code: 'failed' }
  } catch {
    return { ok: false, code: 'failed' }
  }
}

export type CoverImageRead = { ok: true; status: string; failure_reason: string | null } | { ok: false }

// The uploader following their own upload: `GET /cover-images/{id}`.
export async function readCoverImage(coverImageId: string): Promise<CoverImageRead> {
  try {
    const response = await authFetch(`/cover-images/${coverImageId}`)
    if (!response.ok) return { ok: false }
    const body = (await response.json()) as { status?: string; failure_reason?: string | null }
    return { ok: true, status: body.status ?? '', failure_reason: body.failure_reason ?? null }
  } catch {
    return { ok: false }
  }
}

export type CoverProgress =
  | { state: 'preparing' }
  | { state: 'ready' }
  | { state: 'failed'; code: CoverFailure }

// What a read of the cover image means for the page: still being prepared
// (`uploaded`, `processing`), the cover now (`ready`), or not to be — the
// worker's reason (`failed`), a later act that superseded it (`destroying`,
// `destroyed`), or anything else, a read that failed included.
export function coverImageProgress(read: CoverImageRead): CoverProgress {
  if (!read.ok) return { state: 'failed', code: 'failed' }
  switch (read.status) {
    case 'uploaded':
    case 'processing':
      return { state: 'preparing' }
    case 'ready':
      return { state: 'ready' }
    case 'failed':
      if (read.failure_reason === 'unreadable') return { state: 'failed', code: 'unreadable' }
      if (read.failure_reason === 'too_large') return { state: 'failed', code: 'too_large' }
      return { state: 'failed', code: 'failed' }
    case 'destroying':
    case 'destroyed':
      return { state: 'failed', code: 'superseded' }
    default:
      return { state: 'failed', code: 'failed' }
  }
}

// ---------------------------------------------------------------------------
// The words — approved by Steven, 2026-11-01, each used exactly as written.
// The three marked SETTLED were settled by the planning session where the
// approved set does not reach (the CK-84 kickoff), and are reversible.
// ---------------------------------------------------------------------------

export const CHANGE_COVER = 'Change cover'
export const UPLOAD_A_PICTURE = 'Upload a picture'
export const REMOVE_COVER = 'Remove cover'
export const KEEP_IT = 'Keep it'
export const USE_AS_COVER = 'Use as cover'
export const USE_AS_GROUP_COVER = "Use as the group's cover"
export const NOT_NOW = 'Not now'
export const EMPTY_COVER_LINE = 'No cover photo yet'

export const COVER_HINT_GATHERING = 'Or open one of the photos and choose Use as cover.'
// SETTLED: on a group's page the button the admin finds is the group's.
export const COVER_HINT_GROUP =
  "Or open a photo in one of the group's gatherings and choose Use as the group's cover."

export function groupCoverConfirmSentence(group: string, gathering: string): string {
  return `Everyone in ${group} will see this photo as the group's cover, including people who can't see ${gathering}.`
}

// SETTLED: the group's cover changes on a page the person is not looking
// at, so a line says the act took.
export function groupCoverSetLine(group: string): string {
  return `${group}'s cover is set.`
}

// Remove cover's step, by source: an uploaded picture is deleted for good;
// a photograph stays where it is.
export const REMOVE_UPLOADED_SENTENCE =
  'The picture will be deleted. The empty cover shows until someone chooses another.'

export function removePhotoSentence(gathering: string): string {
  return `The photo stays in ${gathering}. It just won't be the cover.`
}

// SETTLED: no group body names the photograph or its gathering (CK-83a), so
// on a group's page the sentence cannot name it.
export const REMOVE_PHOTO_SENTENCE_GROUP = "The photo stays in its gathering. It just won't be the cover."

export const COVER_UPLOADING = 'Uploading your picture…'
export const COVER_GETTING_READY = 'Getting it ready…'

export function coverFailureLine(code: CoverFailure): string {
  switch (code) {
    case 'superseded':
      return "A newer cover was chosen while this one was uploading, so it won't be used."
    case 'unreadable':
      return "That picture couldn't be opened. Try a different one."
    case 'too_large':
      return 'That picture is too large. Try a smaller one.'
    default:
      return "The upload didn't finish. Try again."
  }
}

// The house line, for a refused set or clear — the app's own, never the
// server's wording.
export const COVER_REFUSED = 'Something went wrong. Nothing changed — try again.'
