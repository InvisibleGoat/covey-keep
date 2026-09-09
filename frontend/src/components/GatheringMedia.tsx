import { useEffect, useRef, useState, type FormEvent } from 'react'
import { authFetch } from '../lib/api'
import { formatInstant } from '../lib/datetime'
import {
  describedBy,
  errorsFromResponse,
  networkErrors,
  noErrors,
  type FormErrors,
} from '../lib/formErrors'
import { type Occurrence } from '../lib/gatherings'
import {
  anyInFlight,
  confirmUpload,
  declaredContentType,
  fetchLayerObjectUrl,
  intentErrorFields,
  mediaStateMessage,
  PICKER_ACCEPT,
  POLL_INTERVAL_MS,
  putUpload,
  type IntentResponse,
  type MediaItem,
  type MediaList,
  type ServableLayer,
} from '../lib/media'
import { FieldError, FormLevelErrors } from './FieldError'

// The photographs section of /gatherings/:id (CK-38) — the first surface on
// which a person hands the product a photograph, and the first that shows
// them what happened to it.
//
// Three things it is built around:
//
// 1. THE PIPELINE IS ASYNCHRONOUS BY CONSTRUCTION (pipeline record §2). A
//    photograph is uploading, then uploaded, then being prepared, then ready
//    — or it fails. Each is a state a photograph genuinely occupies, and the
//    list shows every row at its rung (the list endpoint returns all of them,
//    a URL for none). Pending is a real state, not a spinner; the list polls
//    while anything is non-terminal and makes no request at all otherwise.
//
// 2. THE COPY IS DERIVED FROM publication_state, NEVER FIXED. Every row today
//    is `pending` — visible to its uploader and the host, and nobody else
//    (decisions/2026-09-09-who-may-see-an-unapproved-photograph.md) — but
//    for a private, person-owned gathering that is temporary: the publication
//    phase moves ready rows to `live` on completion, with no review step
//    ever (decisions/2026-09-09-consent-gate-defaults.md §1). So the `live`
//    line is written now, and no copy here implies a reviewer, an approval
//    queue, or a "waiting for approval" — that would be wrong today and
//    wrong after the fix. lib/media.ts::mediaStateMessage is the one home.
//
// 3. A PRESIGNED URL NEVER LEAVES THE NETWORK CALL (record §9). The intent
//    response is a local of the upload handler, spent on the PUTs and gone;
//    what reaches state is media ids and file names. A thumbnail is fetched
//    into a `blob:` object URL (lib/media.ts::fetchLayerObjectUrl) so what an
//    <img> and this component hold carries no credential.
//
// Collapsed by default (the CK-25/CK-27 pattern): the detail page stays one
// request until the person opens this section.

interface Props {
  gatheringId: string
  isHost: boolean
  occurrences: Occurrence[]
  zone: string
  // Overridable for tests only; the product uses the one constant.
  pollIntervalMs?: number
}

// What this device knows about a row that the server cannot: the file name
// the person chose, and whether the PUT or the confirm failed FROM HERE. A
// PUT that never landed leaves a `pending_upload` row the server can only
// call "on its way" — from this device we know it is not, and say so.
interface LocalNote {
  name: string
  problem: 'upload_failed' | 'confirm_failed' | null
}

type LayerState =
  | { status: 'loading' }
  | { status: 'shown'; objectUrl: string }
  | { status: 'failed'; reason: 'not_ready' | 'unavailable' }

// One layer of one ready photograph, as an <img> over a blob: URL. Owns the
// object URL for its lifetime and revokes it on unmount or re-fetch — the
// bytes stay in this browser, the credential that fetched them is gone.
function LayerImage({
  mediaId,
  layer,
  alt,
  className,
}: {
  mediaId: string
  layer: ServableLayer
  alt: string
  className: string
}) {
  const [state, setState] = useState<LayerState>({ status: 'loading' })
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    let held: string | null = null
    setState({ status: 'loading' })
    void fetchLayerObjectUrl(mediaId, layer).then((outcome) => {
      if (cancelled) {
        if (outcome.ok) URL.revokeObjectURL(outcome.objectUrl)
        return
      }
      if (outcome.ok) {
        held = outcome.objectUrl
        setState({ status: 'shown', objectUrl: outcome.objectUrl })
      } else {
        setState({ status: 'failed', reason: outcome.reason })
      }
    })
    return () => {
      cancelled = true
      if (held !== null) URL.revokeObjectURL(held)
    }
  }, [mediaId, layer, retryKey])

  if (state.status === 'loading') {
    return <span className={`${className} media-placeholder`}>Loading…</span>
  }
  if (state.status === 'failed') {
    return (
      <span className={`${className} media-placeholder`}>
        {state.reason === 'not_ready' ? "Not ready to show yet." : "Couldn't show this photo just now."}{' '}
        <button type="button" className="link-button" onClick={() => setRetryKey((key) => key + 1)}>
          Retry
        </button>
      </span>
    )
  }
  return <img className={className} src={state.objectUrl} alt={alt} />
}

export function GatheringMedia({
  gatheringId,
  isHost,
  occurrences,
  zone,
  pollIntervalMs = POLL_INTERVAL_MS,
}: Props) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<MediaItem[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  const [files, setFiles] = useState<File[]>([])
  const [errors, setErrors] = useState<FormErrors>(noErrors())
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [notes, setNotes] = useState<Record<string, LocalNote>>({})
  const [openedId, setOpenedId] = useState<string | null>(null)

  const fileInput = useRef<HTMLInputElement>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // The list loads only once the section is opened, and re-reads after every
  // upload step and on each poll tick.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    async function load() {
      try {
        const response = await authFetch(`/gatherings/${gatheringId}/media`)
        if (cancelled) return
        if (response.ok) {
          const body = (await response.json()) as Partial<MediaList>
          setItems(body.media ?? [])
          setLoadFailed(false)
        } else {
          setLoadFailed(true)
        }
      } catch {
        if (!cancelled) setLoadFailed(true)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [gatheringId, open, reloadKey])

  // Poll while anything is still moving; stop the moment everything is
  // `ready` or `failed`. `items` is a fresh array per load, so each read
  // re-arms exactly one timer; a load that failed does not — the person gets
  // a retry control instead of a page hammering a failing endpoint.
  useEffect(() => {
    if (!open || loadFailed || items === null || !anyInFlight(items)) return
    const timer = setTimeout(() => setReloadKey((key) => key + 1), pollIntervalMs)
    return () => clearTimeout(timer)
  }, [open, loadFailed, items, pollIntervalMs])

  function note(mediaId: string, problem: LocalNote['problem']) {
    setNotes((prev) => {
      const current = prev[mediaId]
      if (!current) return prev
      return { ...prev, [mediaId]: { ...current, problem } }
    })
  }

  // Intent → PUT → confirm, per file, with the batch endpoint used as a
  // batch. The server refuses the batch WHOLE on any bad item (no row is
  // created), and its 422 lands on the file it names.
  async function upload(event: FormEvent) {
    event.preventDefault()
    const chosen = files
    if (chosen.length === 0) return
    setErrors(noErrors())
    setProgress({ done: 0, total: chosen.length })

    let intents: IntentResponse['intents']
    try {
      const response = await authFetch(`/gatherings/${gatheringId}/media/intents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: chosen.map((file) => ({
            content_type: declaredContentType(file),
            size_bytes: file.size,
          })),
        }),
      })
      if (!alive.current) return
      if (response.status !== 201) {
        setErrors(await errorsFromResponse(response, intentErrorFields(chosen.length)))
        setProgress(null)
        return
      }
      intents = ((await response.json()) as IntentResponse).intents
    } catch {
      if (alive.current) {
        setErrors(networkErrors())
        setProgress(null)
      }
      return
    }

    // Rows exist now. Remember which file each is (ids and names only — the
    // presigned URLs stay in `intents`, a local of this handler) and show
    // the rows in their honest state while the bytes go up.
    const ids = intents.map((intent) => intent.media.id)
    setNotes((prev) => {
      const next = { ...prev }
      ids.forEach((id, index) => {
        next[id] = { name: chosen[index].name, problem: null }
      })
      return next
    })
    setFiles([])
    if (fileInput.current) fileInput.current.value = ''
    setReloadKey((key) => key + 1)

    for (let index = 0; index < intents.length; index++) {
      const intent = intents[index]
      const put = await putUpload(chosen[index], intent.upload)
      if (!alive.current) return
      if (put !== 'stored') {
        note(intent.media.id, 'upload_failed')
      } else {
        const confirmed = await confirmUpload(intent.media.id)
        if (!alive.current) return
        // `not_pending` means it was already confirmed — nothing to note.
        if (!confirmed.ok && confirmed.code !== 'not_pending') {
          note(intent.media.id, 'confirm_failed')
        }
      }
      setProgress({ done: index + 1, total: intents.length })
    }
    setProgress(null)
    setReloadKey((key) => key + 1)
  }

  // §6.5's one affordance: "try again" re-uploads FROM THE DEVICE. Never a
  // re-queue — the quarantine original is deleted at dead-letter, so there
  // is nothing on the server to retry.
  function chooseAgain() {
    fileInput.current?.click()
  }

  function labelFor(item: MediaItem): string | null {
    if (item.occurrence_id === null) return null
    const occurrence = occurrences.find((candidate) => candidate.id === item.occurrence_id)
    return occurrence ? formatInstant(occurrence.starts_at, zone) : null
  }

  function whoFor(item: MediaItem): string {
    if (item.is_own) return 'You'
    return item.uploader_display_name ?? 'Someone'
  }

  if (!open) {
    return (
      <button type="button" className="link-button" onClick={() => setOpen(true)}>
        Show photos and add yours
      </button>
    )
  }

  const opened = openedId === null ? null : items?.find((item) => item.id === openedId) ?? null

  return (
    <div className="media-block">
      <form onSubmit={(event) => void upload(event)}>
        <label htmlFor="media-files">Add photos</label>
        <input
          id="media-files"
          ref={fileInput}
          type="file"
          multiple
          accept={PICKER_ACCEPT}
          aria-describedby={describedBy(errors, 'items')}
          onChange={(event) => {
            setFiles(Array.from(event.target.files ?? []))
            setErrors(noErrors())
          }}
        />
        {/* The product's first promise about a photograph, in the real
            order (pipeline record §3): uploaded, then prepared, and the
            location data removed as part of preparing it. Nothing here
            says anyone reviews it, screens it, or that the gathering can
            see it. */}
        <p className="field-hint">
          Once uploaded, each photo is prepared for viewing; any location data saved
          inside the photo is removed as part of that. JPEG, PNG, WebP or HEIC, up to
          25 MB each. Videos can't be added.
        </p>
        {files.length > 0 && (
          <ul className="media-chosen" aria-label="Chosen files">
            {files.map((file, index) => (
              <li key={index}>
                {file.name}
                {/* The server's 422 lands on the file it names — batch
                    refused whole, in its own words. */}
                <FieldError errors={errors} field={`items.${index}.content_type`} />
                <FieldError errors={errors} field={`items.${index}.size_bytes`} />
                <FieldError errors={errors} field={`items.${index}.occurrence_id`} />
              </li>
            ))}
          </ul>
        )}
        <FieldError errors={errors} field="items" />
        <button type="submit" disabled={files.length === 0 || progress !== null}>
          {progress !== null
            ? `Uploading ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
            : files.length > 1
              ? `Upload ${files.length} photos`
              : 'Upload'}
        </button>
        {Object.keys(errors.fields).length > 0 && (
          <p className="field-hint">Nothing was uploaded — fix the photo named above and try again.</p>
        )}
        <FormLevelErrors errors={errors} />
      </form>

      {loadFailed && (
        <p className="form-error" role="alert">
          <span aria-hidden="true">⚠ </span>
          Photos couldn't be loaded just now.{' '}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setLoadFailed(false)
              setReloadKey((key) => key + 1)
            }}
          >
            Try again
          </button>
        </p>
      )}

      {items !== null && items.length === 0 && !loadFailed && (
        // The empty state is a real screen (CK-17): the control that fills
        // it is right above.
        <p className="field-hint">No photos yet.</p>
      )}

      {items !== null && items.length > 0 && (
        <ul className="media-list" aria-label="Photos">
          {items.map((item) => {
            const local = notes[item.id]
            const who = whoFor(item)
            const label = labelFor(item)
            const name = local?.name ?? 'Photo'
            // This device's knowledge overrides the server's rung for a row
            // whose upload never landed FROM HERE; otherwise the row's own
            // state decides, through the one message function.
            const message =
              local?.problem === 'upload_failed'
                ? "This upload didn't finish."
                : local?.problem === 'confirm_failed'
                  ? "This upload couldn't be confirmed."
                  : mediaStateMessage(item, { isHost })
            const offerRetry =
              item.status === 'failed' || (local !== undefined && local.problem !== null)
            return (
              <li key={item.id} className="media-item">
                {item.status === 'ready' && (
                  <button
                    type="button"
                    className="media-thumb-button"
                    onClick={() => setOpenedId(item.id)}
                    aria-label={`Open photo added by ${who}`}
                  >
                    <LayerImage mediaId={item.id} layer="thumbnail" alt="" className="media-thumb" />
                  </button>
                )}
                <p>
                  <strong>{name}</strong> — added by {who}
                  {label ? ` for ${label}` : ''}, {formatInstant(item.created_at, zone)}
                </p>
                <p className={item.status === 'failed' || local?.problem ? 'form-error' : 'field-hint'}>
                  {message}
                </p>
                {offerRetry && (
                  <button type="button" className="link-button" onClick={chooseAgain}>
                    Try again
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {opened !== null && (
        <div className="media-viewer" role="dialog" aria-label={`Photo added by ${whoFor(opened)}`}>
          {/* The web layer when opened — never archival, which CK-37 refuses
              and which costs money per retrieval. */}
          <LayerImage
            mediaId={opened.id}
            layer="web"
            alt={`Photo added by ${whoFor(opened)}`}
            className="media-web"
          />
          <p className="field-hint">{mediaStateMessage(opened, { isHost })}</p>
          <button type="button" onClick={() => setOpenedId(null)}>
            Close
          </button>
        </div>
      )}
    </div>
  )
}
