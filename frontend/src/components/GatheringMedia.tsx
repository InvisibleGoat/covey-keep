import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
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
  awaitingReview,
  confirmUpload,
  fetchLayerObjectUrl,
  intentErrorFields,
  intentItem,
  MAX_PUBLISH_BATCH,
  mediaListPath,
  mediaName,
  mediaStateMessage,
  mediaWordsPatch,
  PICKER_ACCEPT,
  POLL_INTERVAL_MS,
  publishBatchErrorFields,
  putUpload,
  REMOVED_BIN_DAYS,
  reviewMedia,
  reviewRefusalMessage,
  SEARCH_DEBOUNCE_MS,
  wordsErrorFields,
  type IntentResponse,
  type MediaItem,
  type MediaList,
  type ReviewAct,
  type ServableLayer,
} from '../lib/media'
import { FieldError, FormLevelErrors } from './FieldError'

// The photographs section of /gatherings/:id (CK-38; the words on a
// photograph since CK-40) — the first surface on which a person hands the
// product a photograph, the first that shows them what happened to it, and
// now the one where they name it and find it again.
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
// 2. THE COPY IS DERIVED FROM publication_state, NEVER FIXED. A `pending`
//    row is visible to its uploader and the host, and nobody else
//    (decisions/2026-09-09-who-may-see-an-unapproved-photograph.md); for a
//    private, person-owned gathering — every gathering today — the worker
//    moves a ready row to `live` on completion with no review step ever
//    (decisions/2026-09-09-consent-gate-defaults.md §1, built at CK-41). So
//    for a gathering that resolves OPEN no copy here implies a reviewer, an
//    approval queue, or a "waiting for approval" — nobody reviews, and the
//    copy would be a lie. lib/media.ts::mediaStateMessage is the one home.
//
// 3. A PRESIGNED URL NEVER LEAVES THE NETWORK CALL (record §9). The intent
//    response is a local of the upload handler, spent on the PUTs and gone;
//    what reaches state is media ids. A thumbnail is fetched into a `blob:`
//    object URL (lib/media.ts::fetchLayerObjectUrl) so what an <img> and
//    this component hold carries no credential.
//
// And, since CK-40, the words (decisions/2026-09-10-captions-tags-and-
// finding-a-photograph.md):
//
// 4. THE WORDS ARE THE UPLOADER'S. A row is called by its caption, then its
//    filename, then "Photo" (lib/media.ts::mediaName — the filename rides
//    every media body since CK-39, so a reload no longer forgets the name).
//    The editor renders ONLY on the caller's own rows: the server reserves
//    the edit to the uploader — a host may remove a photograph, not re-word
//    it — and offering an action that cannot succeed is its own defect. The
//    caption follows the CK-22 clearing rule (blank the input to clear; an
//    explicit null goes, never ""), and THE TAG LIST REPLACES THE SET on the
//    server, so every save carries every tag the photograph should keep.
//    A tag is text and never a link.
//
// 5. SEARCH IS PER GATHERING AND INSIDE THE AUDIENCE RULE. The box sets `q`
//    on the list request — debounced, absent when empty — and the server
//    ANDs it with who may see what; nothing is cached across viewers. A
//    filtered view says so and offers the way back; an empty result is a
//    state, not a blank area.
//
// And, since CK-43.1, the host's review (decisions/2026-09-13-the-hosts-
// review.md — decided before its backend was built at CK-43):
//
// 6. THE REVIEW EXISTS ONLY WHERE THE GATHERING RESOLVES GATED, AND ONLY FOR
//    THE HOST. The detail body carries `requires_approval` as the EFFECTIVE
//    value (CK-41's ladder), and that one fact decides everything here: the
//    queue, the publish and decline controls, and the pending line's second
//    sentence all exist when it is true and the caller is the host, and
//    none of them exists otherwise — not disabled, not hidden-but-present.
//    A control that cannot succeed teaches a host the product does
//    something it does not, and where nobody reviews, no copy may name a
//    reviewer, an approval or a queue. The queue is THE SAME LIST asked for
//    with `awaiting_review=true` (record §10 — a filter, never a sibling
//    route), rendered through the same rows; its empty state is its own
//    ("nothing is waiting"), never "no photos yet". Publish and decline
//    switch on the server's stable codes, never its wording; decline is
//    removal — the contributor's 30-day bin, nothing destroyed — and takes
//    a deliberate second click. Bulk approve is the batch endpoint, refused
//    whole on any bad item, the refusal landing on the row that caused it.
//    A `ready` + `pending` row is terminal for `status`, so nothing here
//    polls the queue: only the host's own act moves it. The publication
//    stamp rides every body and is rendered nowhere (record §7).
//
// Collapsed by default (the CK-25/CK-27 pattern): the detail page stays one
// request until the person opens this section.

interface Props {
  gatheringId: string
  isHost: boolean
  // The gathering's effective `requires_approval` (CK-41): true means a
  // ready photograph waits for the host. Read, never written here — the
  // host's own switch is CK-44's.
  requiresApproval: boolean
  occurrences: Occurrence[]
  zone: string
  // Overridable for tests only; the product uses the one constant each.
  pollIntervalMs?: number
  searchDebounceMs?: number
}

// What this device knows about a row that the server cannot: whether the
// PUT or the confirm failed FROM HERE. A PUT that never landed leaves a
// `pending_upload` row the server can only call "on its way" — from this
// device we know it is not, and say so. (The file's name is no longer this
// device's to remember: the intent sends it and every media body carries it.)
type LocalProblem = 'upload_failed' | 'confirm_failed'

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

// The tags as they are on the row: text, one chip each, never a link (the
// CK-21 discipline — nothing here reaches an href or an HTML sink; React's
// escaping covers the text case).
function TagList({ tags, label }: { tags: string[]; label: string }) {
  if (tags.length === 0) return null
  return (
    <ul className="media-tags" aria-label={label}>
      {tags.map((tag) => (
        <li key={tag}>{tag}</li>
      ))}
    </ul>
  )
}

// The caption and tags editor for ONE of the caller's own photographs
// (CK-40). Dirty-tracked like every edit surface (components.md, Editing
// forms): Save is disabled until the patch would carry something, so a
// no-op edit sends no PATCH at all; every server refusal renders through
// lib/formErrors.ts at the control it names — the caption's 422 under the
// caption, a duplicate tag's 422 on the entry that repeats it, the count
// refusal under the tag entry. The patch itself comes from
// lib/media.ts::mediaWordsPatch, which is where the two rules that matter
// live: blank is never a clear (explicit null is), and the tag list sent is
// the WHOLE list — the server replaces the set, and a partial list would
// silently delete the rest.
function MediaWordsEditor({
  item,
  onSaved,
  onClose,
}: {
  item: MediaItem
  onSaved: () => void
  onClose: () => void
}) {
  // Initialised once from the row; a poll re-read while the person types
  // must not overwrite what they typed.
  const [caption, setCaption] = useState(item.caption ?? '')
  const [tags, setTags] = useState<string[]>(item.tags)
  const [entry, setEntry] = useState('')
  const [errors, setErrors] = useState<FormErrors>(noErrors())
  const [saving, setSaving] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const scope = `media-${item.id}`
  const patch = mediaWordsPatch({ caption, tags }, item)
  const dirty = Object.keys(patch).length > 0
  const fallbackName = item.filename ?? 'Photo'

  // Adding appends to the list the save will carry whole; the entry is
  // trimmed (the server trims too) and an empty one adds nothing — presence
  // gating, as far as the client goes. A duplicate is NOT caught here: it
  // goes to the server and its 422 lands on the repeated entry.
  function addTag() {
    const tag = entry.trim()
    if (tag === '') return
    setTags((current) => [...current, tag])
    setEntry('')
    setErrors(noErrors())
  }

  function removeTag(index: number) {
    setTags((current) => current.filter((_, position) => position !== index))
    setErrors(noErrors())
  }

  function onEntryKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      addTag()
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!dirty || saving) return
    setSaving(true)
    setErrors(noErrors())
    try {
      const response = await authFetch(`/media/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!alive.current) return
      if (response.ok) {
        onSaved()
        return
      }
      setErrors(await errorsFromResponse(response, wordsErrorFields(tags.length)))
    } catch {
      if (alive.current) setErrors(networkErrors())
    } finally {
      if (alive.current) setSaving(false)
    }
  }

  return (
    <form className="media-editor" onSubmit={(event) => void save(event)} aria-label={`Edit ${mediaName(item)}`}>
      <label htmlFor={`${scope}-caption`}>Caption</label>
      <input
        id={`${scope}-caption`}
        type="text"
        maxLength={500}
        value={caption}
        aria-describedby={describedBy(errors, 'caption', scope)}
        onChange={(event) => setCaption(event.target.value)}
      />
      {/* The CK-22 gesture: blanking the input clears the caption, and the
          hint says what the row is called once it is gone. */}
      <p className="field-hint">
        Leaving the caption blank removes it; the photo is then called {fallbackName}.
      </p>
      <FieldError errors={errors} field="caption" scope={scope} />

      <span id={`${scope}-tags-label`}>Tags</span>
      {tags.length > 0 && (
        <ul className="media-tags" aria-labelledby={`${scope}-tags-label`}>
          {tags.map((tag, index) => (
            <li key={`${index}-${tag}`}>
              <span>{tag}</span>
              <button
                type="button"
                className="link-button"
                aria-label={`Remove tag ${tag}`}
                onClick={() => removeTag(index)}
              >
                Remove
              </button>
              <FieldError errors={errors} field={`tags.${index}`} scope={scope} />
            </li>
          ))}
        </ul>
      )}
      <label htmlFor={`${scope}-tag-entry`}>Add a tag</label>
      <input
        id={`${scope}-tag-entry`}
        type="text"
        maxLength={50}
        value={entry}
        aria-describedby={describedBy(errors, 'tags', scope)}
        onChange={(event) => setEntry(event.target.value)}
        onKeyDown={onEntryKey}
      />
      <button type="button" onClick={addTag} disabled={entry.trim() === ''}>
        Add tag
      </button>
      <p className="field-hint">
        Tags are words to find this photo by. Saving keeps exactly the tags listed above.
      </p>
      <FieldError errors={errors} field="tags" scope={scope} />

      <button type="submit" disabled={!dirty || saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
      <button type="button" className="link-button" onClick={onClose}>
        Cancel
      </button>
      <FormLevelErrors errors={errors} />
    </form>
  )
}

export function GatheringMedia({
  gatheringId,
  isHost,
  requiresApproval,
  occurrences,
  zone,
  pollIntervalMs = POLL_INTERVAL_MS,
  searchDebounceMs = SEARCH_DEBOUNCE_MS,
}: Props) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<MediaItem[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  const [files, setFiles] = useState<File[]>([])
  const [errors, setErrors] = useState<FormErrors>(noErrors())
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [problems, setProblems] = useState<Record<string, LocalProblem>>({})
  const [openedId, setOpenedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)

  // The search box as typed, and the term the list is actually filtered by
  // — the second follows the first after the debounce, trimmed, and is ''
  // whenever the box is blank (no `q` goes at all then).
  const [searchInput, setSearchInput] = useState('')
  const [term, setTerm] = useState('')

  // The host's review (CK-43.1). `reviewer` is the one gate: the host of a
  // gathering that resolves gated, and nobody else, sees any of it. The
  // queue is a view of the same list (`awaiting_review=true`); the
  // selection is the batch's; a refused act's message is kept per row until
  // the row moves; a decline waits for its second click.
  const reviewer = isHost && requiresApproval
  const [view, setView] = useState<'all' | 'queue'>('all')
  const queueView = reviewer && view === 'queue'
  const [selected, setSelected] = useState<string[]>([])
  const [rowErrors, setRowErrors] = useState<Record<string, FormErrors>>({})
  const [actingId, setActingId] = useState<string | null>(null)
  const [decliningId, setDecliningId] = useState<string | null>(null)
  const [batchErrors, setBatchErrors] = useState<FormErrors>(noErrors())
  // The ids the last batch sent, in order — a refusal lands on
  // `media_ids.N`, and N is this list's index for the row it names.
  const [batchSent, setBatchSent] = useState<string[]>([])
  const [publishing, setPublishing] = useState(false)

  const fileInput = useRef<HTMLInputElement>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => setTerm(searchInput.trim()), searchDebounceMs)
    return () => clearTimeout(timer)
  }, [searchInput, searchDebounceMs])

  // The list loads only once the section is opened, and re-reads after every
  // upload step, on each poll tick, when the search term settles, and when
  // the host switches between all photos and the queue. The term rides the
  // request as `q` and the queue as `awaiting_review=true`; the server
  // decides what the caller may see and narrows within that — nothing is
  // filtered or cached here.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    async function load() {
      try {
        const response = await authFetch(
          mediaListPath(gatheringId, term, { awaitingReview: queueView }),
        )
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
  }, [gatheringId, open, reloadKey, term, queueView])

  // Poll while anything is still moving; stop the moment everything is
  // `ready` or `failed`. `items` is a fresh array per load, so each read
  // re-arms exactly one timer; a load that failed does not — the person gets
  // a retry control instead of a page hammering a failing endpoint. The
  // queue never polls by construction: every row in it is `ready`, and
  // nothing but the host's own act moves one (CK-43.1).
  useEffect(() => {
    if (!open || loadFailed || items === null || !anyInFlight(items)) return
    const timer = setTimeout(() => setReloadKey((key) => key + 1), pollIntervalMs)
    return () => clearTimeout(timer)
  }, [open, loadFailed, items, pollIntervalMs])

  // The batch selection follows the list: an id the last read no longer
  // returned (published, declined, or gone from the queue) is dropped, so
  // no batch ever names a row the host cannot see on the screen.
  useEffect(() => {
    if (items === null) return
    const present = new Set(items.map((item) => item.id))
    setSelected((current) => {
      const kept = current.filter((id) => present.has(id))
      return kept.length === current.length ? current : kept
    })
  }, [items])

  function noteProblem(mediaId: string, problem: LocalProblem) {
    setProblems((prev) => ({ ...prev, [mediaId]: problem }))
  }

  // The review's transient state — a decline awaiting its second click and
  // the last batch's refusal — is dropped whenever the list is re-read on
  // the host's own initiative: the refusal it explains belongs to the rows
  // as they were.
  function clearBatch() {
    setBatchErrors(noErrors())
    setBatchSent([])
    setDecliningId(null)
  }

  function switchView(next: 'all' | 'queue') {
    if (next === view) return
    setView(next)
    setSelected([])
    clearBatch()
  }

  function showAll() {
    setSearchInput('')
    setTerm('')
    if (view !== 'all') switchView('all')
  }

  function refresh() {
    clearBatch()
    setRowErrors({})
    setReloadKey((key) => key + 1)
  }

  // One act on one photograph (CK-43.1). Optimistic-free: a success re-reads
  // the list and the server's body is what renders (the row leaves the
  // queue; its line in the full list changes to the state it is now in). A
  // refusal is kept ON THE ROW, in this module's words for the server's
  // code, and the list is NOT re-read — a re-read could drop the row the
  // message is about (a declined photograph is in nobody's queue) and take
  // the explanation with it; the refresh control beside it is the way on.
  async function act(item: MediaItem, which: ReviewAct) {
    if (actingId !== null) return
    setActingId(item.id)
    setDecliningId(null)
    setRowErrors((prev) => {
      const { [item.id]: _dropped, ...rest } = prev
      return rest
    })
    const outcome = await reviewMedia(item.id, which)
    if (!alive.current) return
    setActingId(null)
    if (outcome.ok) {
      setSelected((current) => current.filter((id) => id !== item.id))
      setReloadKey((key) => key + 1)
      return
    }
    setRowErrors((prev) => ({
      ...prev,
      [item.id]: { fields: {}, form: [reviewRefusalMessage(which, outcome)] },
    }))
  }

  // Bulk approve (roadmap §3's one tap; record §5): the batch endpoint, the
  // ids in the order selected. The server refuses the batch WHOLE on any
  // bad item and changes nothing; its item-level 422 carries the row's
  // index, so the refusal renders against the row that caused it — never
  // as a banner alone — and the rows stay exactly as they were read.
  async function publishSelected(event: FormEvent) {
    event.preventDefault()
    const ids = selected
    if (ids.length === 0 || ids.length > MAX_PUBLISH_BATCH || publishing) return
    setPublishing(true)
    setBatchErrors(noErrors())
    setBatchSent(ids)
    try {
      const response = await authFetch(`/gatherings/${gatheringId}/media/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ media_ids: ids }),
      })
      if (!alive.current) return
      if (response.ok) {
        setSelected([])
        setBatchSent([])
        setReloadKey((key) => key + 1)
        return
      }
      setBatchErrors(await errorsFromResponse(response, publishBatchErrorFields(ids.length)))
    } catch {
      if (alive.current) setBatchErrors(networkErrors())
    } finally {
      if (alive.current) setPublishing(false)
    }
  }

  function toggleSelected(mediaId: string, on: boolean) {
    setSelected((current) =>
      on ? (current.includes(mediaId) ? current : [...current, mediaId]) : current.filter((id) => id !== mediaId),
    )
  }

  // Intent → PUT → confirm, per file, with the batch endpoint used as a
  // batch. The server refuses the batch WHOLE on any bad item (no row is
  // created), and its 422 lands on the file it names. Each item comes from
  // its File and nothing else (lib/media.ts::intentItem — the size is
  // signed into the PUT, so it must be the blob's own).
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
        body: JSON.stringify({ items: chosen.map(intentItem) }),
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

    // Rows exist now, each carrying its name server-side. Leave any filtered
    // view so the new rows are in sight while the bytes go up (a term that
    // matched three photographs would hide the ones just added), and show
    // them in their honest state. The presigned URLs stay in `intents`, a
    // local of this handler.
    setFiles([])
    if (fileInput.current) fileInput.current.value = ''
    showAll()
    setReloadKey((key) => key + 1)

    for (let index = 0; index < intents.length; index++) {
      const intent = intents[index]
      const put = await putUpload(chosen[index], intent.upload)
      if (!alive.current) return
      if (put !== 'stored') {
        noteProblem(intent.media.id, 'upload_failed')
      } else {
        const confirmed = await confirmUpload(intent.media.id)
        if (!alive.current) return
        // `not_pending` means it was already confirmed — nothing to note.
        if (!confirmed.ok && confirmed.code !== 'not_pending') {
          noteProblem(intent.media.id, 'confirm_failed')
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
  const filtered = term !== ''
  const matchCount =
    items === null ? '' : items.length === 1 ? '1 photo' : `${items.length} photos`
  const listed = items ?? []
  const allSelected = listed.length > 0 && listed.every((item) => selected.includes(item.id))
  const batchRefused = Object.keys(batchErrors.fields).length > 0

  // The queue's own status line (CK-43.1): what is waiting, or that nothing
  // is — a state, never a blank area, and never "No photos yet", which
  // means something else.
  const queueStatus =
    listed.length === 0
      ? filtered
        ? `No photos awaiting your review match “${term}”.`
        : 'Nothing is waiting for your review.'
      : filtered
        ? `Showing ${matchCount} awaiting your review, matching “${term}”.`
        : `Showing ${matchCount} awaiting your review.`

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
                <FieldError errors={errors} field={`items.${index}.filename`} />
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

      {/* Search (CK-40): per gathering, by caption, tag or file name; the
          term goes as `q` after the debounce and the server narrows the
          list within what this caller may see. */}
      <div className="media-search">
        <label htmlFor="media-search">Find a photo</label>
        <input
          id="media-search"
          type="search"
          maxLength={200}
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
        />
        <p className="field-hint">
          Looks through captions, tags and file names in this gathering.
        </p>
      </div>

      {/* The host's review (CK-43.1): the queue is a view of this same list
          — asked for with `awaiting_review=true`, rendered through the same
          rows — and the switch exists only for the host of a gathering that
          resolves gated. Where nothing waits for anyone, nothing here
          renders and no string below reaches the page. */}
      {reviewer && (
        <div className="media-view" role="group" aria-label="Show">
          <button
            type="button"
            className="link-button"
            aria-pressed={!queueView}
            onClick={() => switchView('all')}
          >
            All photos
          </button>
          <button
            type="button"
            className="link-button"
            aria-pressed={queueView}
            onClick={() => switchView('queue')}
          >
            Awaiting your review
          </button>
        </div>
      )}

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

      {items !== null && !loadFailed && !queueView && filtered && (
        // The filtered view says it is one, and how to leave it; an empty
        // result is a state with the way back, never a blank area.
        <p className="field-hint" role="status">
          {items.length === 0
            ? `No photos match “${term}”.`
            : `Showing ${matchCount} matching “${term}”.`}{' '}
          <button type="button" className="link-button" onClick={showAll}>
            Show all photos
          </button>
        </p>
      )}

      {items !== null && !loadFailed && queueView && (
        // The queue's state — what is waiting, or that nothing is — with
        // the way back to everything.
        <p className="field-hint" role="status">
          {queueStatus}{' '}
          <button type="button" className="link-button" onClick={showAll}>
            Show all photos
          </button>
        </p>
      )}

      {items !== null && items.length === 0 && !loadFailed && !filtered && !queueView && (
        // The empty state is a real screen (CK-17): the control that fills
        // it is right above.
        <p className="field-hint">No photos yet.</p>
      )}

      {queueView && items !== null && !loadFailed && items.length > 0 && (
        // Bulk approve: the batch endpoint over the selected rows, refused
        // whole on any bad item. A refusal lands on the row it names (below,
        // through the one mapper); the line here says the consequence — that
        // NOTHING was published — and offers the re-read, because the rows
        // shown are the rows as they were when the batch was built.
        <form
          className="media-batch"
          aria-label="Publish selected photos"
          onSubmit={(event) => void publishSelected(event)}
        >
          <button
            type="button"
            className="link-button"
            onClick={() => setSelected(allSelected ? [] : listed.map((item) => item.id))}
          >
            {allSelected ? 'Clear selection' : 'Select all'}
          </button>
          <button
            type="submit"
            disabled={selected.length === 0 || selected.length > MAX_PUBLISH_BATCH || publishing}
          >
            {publishing
              ? 'Publishing…'
              : selected.length === 1
                ? 'Publish 1 selected photo'
                : `Publish ${selected.length} selected photos`}
          </button>
          {selected.length > MAX_PUBLISH_BATCH && (
            <p className="field-hint">Up to {MAX_PUBLISH_BATCH} photos can be published at once.</p>
          )}
          <FieldError errors={batchErrors} field="media_ids" scope="publish" />
          {batchRefused && (
            <p className="field-hint">
              Nothing was published — one of the selected photos can't be, and the note
              beside it says why.{' '}
              <button type="button" className="link-button" onClick={refresh}>
                Refresh the list
              </button>{' '}
              and try again.
            </p>
          )}
          <FormLevelErrors errors={batchErrors} />
        </form>
      )}

      {items !== null && items.length > 0 && (
        <ul className="media-list" aria-label="Photos">
          {items.map((item) => {
            const problem = problems[item.id]
            const who = whoFor(item)
            const label = labelFor(item)
            const name = mediaName(item)
            // This device's knowledge overrides the server's rung for a row
            // whose upload never landed FROM HERE; otherwise the row's own
            // state decides, through the one message function — which says
            // what the row waits on only where the gathering resolves gated.
            const message =
              problem === 'upload_failed'
                ? "This upload didn't finish."
                : problem === 'confirm_failed'
                  ? "This upload couldn't be confirmed."
                  : mediaStateMessage(item, { isHost, gated: requiresApproval })
            const offerRetry = item.status === 'failed' || problem !== undefined
            // The editor: the caller's own rows only (the server reserves
            // the edit to the uploader — no affordance that cannot succeed),
            // and never on a row whose one affordance is try again — a
            // failed photograph has nothing to caption.
            const offerEdit = item.is_own && !offerRetry
            const editing = offerEdit && editingId === item.id
            // The acts: the host of a gated gathering, on a ready row that
            // is pending — the server's own criterion, so no control is
            // ever offered on a row the server would refuse. The checkbox
            // belongs to the queue view, where the batch is built.
            const reviewable = reviewer && awaitingReview(item)
            const declining = reviewable && decliningId === item.id
            const batchIndex = batchSent.indexOf(item.id)
            const batchField = batchIndex === -1 ? null : `media_ids.${batchIndex}`
            const rowError = rowErrors[item.id]
            return (
              <li key={item.id} className="media-item">
                {queueView && reviewable && (
                  <input
                    type="checkbox"
                    className="media-select"
                    aria-label={`Select ${name}`}
                    checked={selected.includes(item.id)}
                    disabled={publishing}
                    aria-describedby={batchField ? describedBy(batchErrors, batchField, 'publish') : undefined}
                    onChange={(event) => toggleSelected(item.id, event.target.checked)}
                  />
                )}
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
                <TagList tags={item.tags} label={`Tags on ${name}`} />
                <p className={item.status === 'failed' || problem ? 'form-error' : 'field-hint'}>
                  {message}
                </p>
                {offerRetry && (
                  <button type="button" className="link-button" onClick={chooseAgain}>
                    Try again
                  </button>
                )}
                {offerEdit && !editing && (
                  <button type="button" className="link-button" onClick={() => setEditingId(item.id)}>
                    Edit caption and tags
                  </button>
                )}
                {editing && (
                  <MediaWordsEditor
                    key={item.id}
                    item={item}
                    onSaved={() => {
                      // Optimistic-free: the server's body is what renders.
                      setEditingId(null)
                      setReloadKey((key) => key + 1)
                    }}
                    onClose={() => setEditingId(null)}
                  />
                )}
                {reviewable && !declining && (
                  <div className="media-review">
                    <button
                      type="button"
                      disabled={actingId !== null}
                      onClick={() => void act(item, 'publish')}
                    >
                      {actingId === item.id ? 'Publishing…' : 'Publish'}
                    </button>
                    <button
                      type="button"
                      className="link-button"
                      disabled={actingId !== null}
                      onClick={() => setDecliningId(item.id)}
                    >
                      Decline
                    </button>
                  </div>
                )}
                {declining && (
                  // Decline is removal (record §4): the gathering never sees
                  // it, the uploader keeps it for the bin's window, nothing
                  // is destroyed — said plainly, and taken on a deliberate
                  // second click, with a do-nothing beside it.
                  <div className="media-review media-decline" role="group" aria-label={`Decline ${name}`}>
                    <p className="field-hint">
                      The gathering won't see this photo.{' '}
                      {item.is_own
                        ? `You can still see it yourself for ${REMOVED_BIN_DAYS} days.`
                        : `${who} can still see it for ${REMOVED_BIN_DAYS} days; you won't see it again here.`}
                    </p>
                    <button type="button" onClick={() => void act(item, 'decline')}>
                      {actingId === item.id ? 'Declining…' : 'Decline it'}
                    </button>
                    <button
                      type="button"
                      className="link-button"
                      disabled={actingId !== null}
                      onClick={() => setDecliningId(null)}
                    >
                      Leave it waiting
                    </button>
                  </div>
                )}
                {batchField && <FieldError errors={batchErrors} field={batchField} scope="publish" />}
                {rowError && (
                  <div className="media-review">
                    <FormLevelErrors errors={rowError} />
                    <button type="button" className="link-button" onClick={refresh}>
                      Refresh the list
                    </button>
                  </div>
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
          <p>
            <strong>{mediaName(opened)}</strong>
          </p>
          <TagList tags={opened.tags} label={`Tags on ${mediaName(opened)}`} />
          <p className="field-hint">
            {mediaStateMessage(opened, { isHost, gated: requiresApproval })}
          </p>
          <button type="button" onClick={() => setOpenedId(null)}>
            Close
          </button>
        </div>
      )}
    </div>
  )
}
