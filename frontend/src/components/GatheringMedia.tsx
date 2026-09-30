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
  anyWaiting,
  awaitingReview,
  binMedia,
  binRefusalMessage,
  confirmUpload,
  DELETE_PERMANENTLY_CONFIRMATION,
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
  RESTORE_HINT_EVERYONE,
  RESTORE_HINT_HOST_LOOKS,
  RESTORE_HINT_WAITS_FOR_YOU,
  reviewMedia,
  reviewRefusalMessage,
  SEARCH_DEBOUNCE_MS,
  takedownSentence,
  wordsErrorFields,
  type BinAct,
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
// 6. THE REVIEW EXISTS FOR THE HOST WHILE REVIEW IS ON OR ANYTHING IS
//    WAITING, AND FOR NOBODY ELSE (the-hosts-review §13 — the strand rule,
//    CK-44). The detail body carries `requires_approval` as the EFFECTIVE
//    value (CK-41's ladder) and this list carries the rows, and
//    `isHost && (requiresApproval || anyWaiting(items))` is the one gate on
//    the queue, the publish and decline controls and the batch. CK-43.1
//    gated all of it on the setting alone, and its deploy run found the
//    strand: turn review off with a row still `ready` + `pending` and the
//    row was orphaned — no control could reach it — though re-setting the
//    flag restored it verbatim, because stranding writes nothing. So the
//    queue now renders while anything waits, whatever the switch says:
//    nothing is published as a side effect of turning review off, the
//    switch is never refused, and the host who turned it off still clears
//    what waited. Where review is off and nothing waits, nothing renders —
//    not disabled, not hidden-but-present — and no string names a reviewer,
//    an approval or a queue: a control that cannot succeed teaches a host
//    the product does something it does not. The pending line's second
//    sentence follows the same predicate — a `ready` + `pending` row is
//    waiting for the host, who can act on it — with no gathering-level
//    flag at all (lib/media.ts::mediaStateMessage). The queue is THE SAME LIST asked for
//    with `awaiting_review=true` (record §10 — a filter, never a sibling
//    route), rendered through the same rows; its empty state is its own
//    ("nothing is waiting"), never "no photos yet". Publish and decline
//    switch on the server's stable codes, never its wording; decline is
//    removal — into the GATHERING's bin since CK-63 (two-bins record §3:
//    the uploader does not see a declined photograph again; the organisers
//    read that bin in the Removed view — the host since CK-67, a co-host
//    since CK-69 — and since CK-67.1 the confirmation names the host's own
//    way back, in the Remove step's words, while promising the uploader
//    nothing), nothing destroyed — and takes
//    a deliberate second click. Bulk approve is the batch endpoint, refused
//    whole on any bad item, the refusal landing on the row that caused it.
//    A `ready` + `pending` row is terminal for `status`, so nothing here
//    polls the queue: only the host's own act moves it. The publication
//    stamp rides every body and is rendered nowhere (record §7).
//
// And, since CK-64, your own photographs (decisions/2026-09-27-two-bins.md
// §1, §2, §4 — the surface for CK-54's remove and destroy and CK-63's
// restore, none of which had a control until now):
//
// 7. YOUR BIN IS YOURS, AND THE THREE ACTS RENDER ON YOUR OWN ROWS ONLY.
//    Send to bin, Put back and Delete permanently appear on a row the caller
//    uploaded, at `ready`, and on no other — never on someone else's row,
//    whoever the viewer is (an organiser's controls on someone else's row
//    are point 8's, and different acts), never on a failed or in-flight row,
//    never on a row whose upload failed from this device. The server would
//    refuse each of those, and a control the server would refuse is its own
//    defect. Send to bin is one click, because it can be undone; Delete
//    permanently takes a deliberate second step, inline, with the bin
//    record §7.1's sentence verbatim and a do-nothing beside it — never a
//    browser dialog; Put back lets the SERVER decide where the photograph
//    goes (the gate, asked at restore time — never a parameter, never
//    "back to what it was"), and a hint beside it says so where the
//    gathering requires approval. Every act is optimistic-free and one at a
//    time on the same guard as the review; a destroyed row is visible to
//    nobody, so it leaves the list on the re-read and a status line says
//    why. The bin's line counts the days the way back stays open and never
//    says what happens at the window's end, because nothing is enforced
//    there today (lib/media.ts::binDaysLeft).
//
// And, since CK-67, the host's side (decisions/2026-09-27-two-bins.md §1–§4
// — the surface for CK-66's backend):
//
// 8. THE GATHERING'S BIN IS THE ORGANISERS', AND SO IS THE TAKEDOWN. Remove
//    from gathering renders for an organiser — the host or, since CK-69, a
//    co-host — on someone ELSE's `live`, `ready` row and on no other: not
//    on a pending row, which keeps Decline (same result, one act per state;
//    the host's alone), not on the caller's own rows, which keep point 7's
//    controls, and never for anyone but an organiser. It takes a
//    deliberate second step — the uploader loses sight of the photograph
//    at once — that says who will still see it and what the way back is
//    (lib/media.ts::takedownSentence, from the reader's seat and the gate),
//    with a do-nothing beside it, and posts CK-54's `remove`; the server
//    records the caller as the remover, which is what puts the row in the
//    GATHERING's bin (two-bins §3). That bin is a third view on the same
//    list (`removed=true` — the rows someone other than the uploader
//    removed, which the server shows to the organisers; anyone else would
//    read an empty list), beside the all and queue views, rendered for
//    organisers only. In it: Put back — one click, no confirmation; a host
//    restore always goes `live` (CK-66), so the host's hint says everyone
//    will see it again, and a co-host's passes THROUGH THE GATE (two-bins
//    §4, CK-68), so where the gathering requires approval the co-host's
//    hint says the host will look at it again — and Delete permanently,
//    point 7's step with the same constant and the same sentence, one
//    photograph at a time, FOR THE HOST OR THE UPLOADER and never a co-host
//    on someone else's (the server's `_may_destroy`); no bulk empty, no
//    multi-select. The uploader is told nothing (two-bins §8, open): the
//    photograph simply leaves their list.
//
// And, since CK-69, co-hosts on the surface (co-hosts §4 as amended by
// two-bins §4; the classification is CK-68's):
//
// 9. TWO FLAGS, AND EVERY CONTROL READS ONE OF THEM ON PURPOSE. `isHost` is
//    the RESERVED set — the review (the queue, Publish and Decline, the
//    batch; `pending` visibility is the server's), and Delete permanently on
//    someone else's photograph — and `organises` (the host or a co-host) is
//    the DELEGABLE set — the view switch and the Removed view, the takedown,
//    and Put back from the gathering's bin. Both come from the gathering
//    body's `caller_role` (the detail page reads it through
//    lib/gatherings.ts::roleFlags); nothing here compares account ids. A
//    row in the Removed view is a gathering-bin row WHOEVER uploaded it —
//    the server lists gathering-bin rows there and nothing else — so an
//    organiser's own photograph that another organiser removed renders the
//    gathering-bin line and the gathering-bin controls there, never "In
//    your bin" and never the personal controls (which, outside that view,
//    are exactly as point 7 says). `mediaStateMessage` keeps `isHost`
//    meaning the host alone for the pending lines — a co-host's own
//    waiting photograph reads "Only you and the host can see this", which
//    is right — and reads the role for the removed branch.
//
// Collapsed by default (the CK-25/CK-27 pattern): the detail page stays one
// request until the person opens this section.

interface Props {
  gatheringId: string
  // The RESERVED set's flag: the caller is THE HOST (`caller_role ===
  // 'host'`). Never derived from an account id here or on the page.
  isHost: boolean
  // The DELEGABLE set's flag (CK-69): the caller is the host OR a co-host.
  // Optional, defaulting to `isHost`, because a host always organises and a
  // caller that passes `isHost` alone (every pre-CK-69 site, and every test
  // written for the host's or a member's seat) means exactly that; a
  // co-host's seat is `isHost={false} organises={true}`, which the detail
  // page passes from the same `roleFlags` read.
  organises?: boolean
  // The gathering's effective `requires_approval` (CK-41): true means a
  // ready photograph waits for the host. Read, never written here — the
  // host's own switch lives on the gathering's edit surface (CK-44) — and
  // one of the two things that render the review: this, or anything
  // waiting in the list (the strand rule, point 6 above).
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
  organises: organisesProp,
  requiresApproval,
  occurrences,
  zone,
  pollIntervalMs = POLL_INTERVAL_MS,
  searchDebounceMs = SEARCH_DEBOUNCE_MS,
}: Props) {
  // The delegable flag (point 9): a host organises by definition.
  const organises = organisesProp ?? isHost
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

  // The host's review (CK-43.1; the strand rule CK-44). `reviewer` is the
  // one gate: the host, while review is on OR anything the host can see is
  // waiting — and nobody else. `items` is the list as loaded, so a waiting
  // row on the screen always carries its acts, and a queue with nothing
  // left in it, on a gathering whose review is off, closes by itself. The
  // queue is a view of the same list (`awaiting_review=true`); the
  // selection is the batch's; a refused act's message is kept per row until
  // the row moves; a decline waits for its second click.
  const reviewer = isHost && (requiresApproval || anyWaiting(items ?? []))
  const [view, setView] = useState<'all' | 'queue' | 'bin'>('all')
  const queueView = reviewer && view === 'queue'
  // The gathering's bin (CK-67; a co-host's too since CK-69): a third view
  // on the same list, reached only through the organisers' control below,
  // so `view === 'bin'` implies the caller organises — and if anyone else
  // somehow reached it, the server would answer the empty list (CK-66:
  // never a refusal that confirms the bin exists). Every row listed in it
  // is a gathering-bin row, whoever uploaded it (point 9).
  const binView = view === 'bin'
  // The full list's own lines (the filtered state, "No photos yet.") key on
  // the VIEW, not on `!queueView`: in the one render between the review
  // closing by itself and the view falling back (below), neither view's
  // status line belongs on the screen.
  const allView = view === 'all'
  const [selected, setSelected] = useState<string[]>([])
  const [rowErrors, setRowErrors] = useState<Record<string, FormErrors>>({})
  const [actingId, setActingId] = useState<string | null>(null)
  const [decliningId, setDecliningId] = useState<string | null>(null)
  // WHICH act is in flight beside who is acting (CK-64): a row the host both
  // reviews and owns carries Publish beside Send to bin, and a progress label
  // keyed on the id alone would read "Publishing…" during a bin act.
  const [actingAct, setActingAct] = useState<ReviewAct | BinAct | null>(null)
  // Your own photographs (CK-64): the row whose permanent-delete step is open
  // (never the editor's row at the same time — each closes the other), and
  // the one line that explains a destroyed row's disappearance until the
  // next act or the next re-read the person asks for.
  const [deletingId, setDeletingId] = useState<string | null>(null)
  // The organisers' side (CK-67; a co-host's since CK-69): the row whose
  // Remove-from-gathering step is open — a step that shares a row with
  // nothing else: opening it closes the editor, the delete step and the
  // decline step, and each of those closes it.
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
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
  // an organiser switches between all photos, the queue (the host's) and
  // the gathering's bin. The term rides the request as `q`, the queue as
  // `awaiting_review=true` and the bin as `removed=true` — never both flags
  // (mediaListPath refuses to emit two, and the views are exclusive here);
  // the server decides what the caller may see and narrows within that —
  // nothing is filtered or cached here.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    async function load() {
      try {
        const response = await authFetch(
          mediaListPath(gatheringId, term, { awaitingReview: queueView, removed: binView }),
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
  }, [gatheringId, open, reloadKey, term, queueView, binView])

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

  // When the review closes by itself — the last waiting row decided on a
  // gathering whose review is off, or the host turning review off with
  // nothing waiting — the QUEUE view falls back to the full list and the
  // queue's transient state goes with it; the load effect above re-reads
  // without the flag the moment `queueView` flips. The bin view never falls
  // back: it is the organisers' whatever the switch says (CK-67; a
  // co-host's since CK-69), and `reviewer` is not its condition.
  useEffect(() => {
    if (view !== 'queue' || reviewer) return
    setView('all')
    setSelected([])
    setBatchErrors(noErrors())
    setBatchSent([])
    setDecliningId(null)
  }, [reviewer, view])

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

  // The bin's transient state (CK-64; the remove step CK-67) — a delete or
  // remove step awaiting its second click and the "Photo deleted." line —
  // goes the same way, on the next act or the next re-read the person asks
  // for. A poll tick is neither: it must not take away a line the person
  // has not read.
  function clearBin() {
    setDeletingId(null)
    setRemovingId(null)
    setNotice(null)
  }

  function switchView(next: 'all' | 'queue' | 'bin') {
    if (next === view) return
    setView(next)
    setSelected([])
    clearBatch()
    clearBin()
  }

  function showAll() {
    setSearchInput('')
    setTerm('')
    clearBin()
    if (view !== 'all') switchView('all')
  }

  function refresh() {
    clearBatch()
    clearBin()
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
    setActingAct(which)
    setDecliningId(null)
    clearBin()
    setRowErrors((prev) => {
      const { [item.id]: _dropped, ...rest } = prev
      return rest
    })
    const outcome = await reviewMedia(item.id, which)
    if (!alive.current) return
    setActingId(null)
    setActingAct(null)
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

  // One of the three acts on a photograph (CK-64 the caller's own; CK-67
  // also an organiser's, on someone else's — the takedown, and the
  // gathering's bin's Put back and Delete permanently): to the bin, back
  // from it, or gone for good. `act`'s shape and `act`'s guard
  // (`actingId` — one act at a time, review or bin): optimistic-free, so a
  // success re-reads the list and the server's body is what renders — a
  // binned row's line becomes the bin's line, a restored row's the live or
  // the waiting line (the SERVER decided which), and a destroyed row leaves
  // the list, because a row in destruction is visible to nobody — which is
  // why a destroy alone sets the "Photo deleted." line below: the re-read
  // explains nothing on its own. A refusal is kept on the row, in this
  // module's words for the server's code — and for the act's CONTEXT
  // (CK-69): which bin the act was on decides whether a refusal says "your
  // bin" or the gathering's — with the list NOT re-read (the review's
  // reason: a re-read could drop the row the message is about); the refresh
  // control beside it is the way on. The delete step stays open while its
  // request runs, so "Deleting…" shows where the person is looking, and
  // closes with the outcome either way.
  async function bin(item: MediaItem, which: BinAct, context: 'personal' | 'gathering' = 'personal') {
    if (actingId !== null) return
    setActingId(item.id)
    setActingAct(which)
    setDecliningId(null)
    setDeletingId(which === 'destroy' ? item.id : null)
    // The Remove-from-gathering step (CK-67) stays open while ITS request
    // runs — the delete step's shape, so "Removing…" shows where the
    // organiser is looking — and any other act closes it.
    setRemovingId((current) => (which === 'remove' && current === item.id ? current : null))
    setNotice(null)
    setRowErrors((prev) => {
      const { [item.id]: _dropped, ...rest } = prev
      return rest
    })
    const outcome = await binMedia(item.id, which)
    if (!alive.current) return
    setActingId(null)
    setActingAct(null)
    setDeletingId(null)
    setRemovingId(null)
    if (outcome.ok) {
      if (which === 'destroy') setNotice('Photo deleted.')
      setSelected((current) => current.filter((id) => id !== item.id))
      setReloadKey((key) => key + 1)
      return
    }
    setRowErrors((prev) => ({
      ...prev,
      [item.id]: { fields: {}, form: [binRefusalMessage(outcome, { bin: context })] },
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

  // "Fix the photo named above" only when a photo is named (CK-65.1): a
  // refusal on a per-file field (`items.{index}.*`) renders against the file
  // it names, and the line below the button may send the person to it. One
  // on the batch-level `items` field alone — the quota's two forms, the
  // memorial ceiling, the count bounds — names nothing about any photo, and
  // the server's message above the button already says why. Decided by the
  // error KEYS, never the message text: the fields are the contract, the
  // strings are the server's.
  const refusalNamesAFile = Object.keys(errors.fields).some((field) =>
    /^items\.\d+\./.test(field),
  )

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

  // The gathering bin view's own status line (CK-67), the queue's shape:
  // what has been removed, or that nothing has — a state, never a blank
  // area, and never "No photos yet.", which means something else.
  const binStatus =
    listed.length === 0
      ? filtered
        ? `No removed photos match “${term}”.`
        : 'Nothing has been removed from this gathering.'
      : filtered
        ? `Showing ${matchCount} removed from this gathering, matching “${term}”.`
        : `Showing ${matchCount} removed from this gathering.`

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
          <p className="field-hint">
            {refusalNamesAFile
              ? 'Nothing was uploaded — fix the photo named above and try again.'
              : 'Nothing was uploaded.'}
          </p>
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

      {/* The view switch — the organisers' (the host's alone until CK-69).
          The queue (CK-43.1; CK-44) is a view of this same list asked for
          with `awaiting_review=true`, and its button exists for the HOST
          while review is on or anything waits — reserved, so a co-host
          never sees it; where review is off and nothing waits, no review
          string reaches the page. The gathering's bin (CK-67) is a view of
          the same list asked for with `removed=true`, and its button exists
          for every organiser always — an empty bin is a state the view
          itself reports, not a reason to hide the way in. Anyone else gets
          no switch at all. */}
      {organises && (
        <div className="media-view" role="group" aria-label="Show">
          <button
            type="button"
            className="link-button"
            aria-pressed={allView}
            onClick={() => switchView('all')}
          >
            All photos
          </button>
          {reviewer && (
            <button
              type="button"
              className="link-button"
              aria-pressed={queueView}
              onClick={() => switchView('queue')}
            >
              Awaiting your review
            </button>
          )}
          <button
            type="button"
            className="link-button"
            aria-pressed={binView}
            onClick={() => switchView('bin')}
          >
            Removed from this gathering
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

      {items !== null && !loadFailed && allView && filtered && (
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

      {items !== null && !loadFailed && binView && (
        // The bin's state (CK-67) — what has been removed, or that nothing
        // has — with the way back to everything.
        <p className="field-hint" role="status">
          {binStatus}{' '}
          <button type="button" className="link-button" onClick={showAll}>
            Show all photos
          </button>
        </p>
      )}

      {items !== null && items.length === 0 && !loadFailed && !filtered && allView && (
        // The empty state is a real screen (CK-17): the control that fills
        // it is right above.
        <p className="field-hint">No photos yet.</p>
      )}

      {notice !== null && (
        // What explains a row's disappearance (CK-64): a destroyed photograph
        // is visible to nobody, so the re-read simply drops it, and this line
        // — polite, cleared by the next act or the next re-read the person
        // asks for — says why.
        <p className="field-hint" role="status">
          {notice}
        </p>
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
            // what a ready + pending row waits on (the host, who can act on
            // it — the same predicate `reviewable` below reads), and, on a
            // removed row, whose bin it is in: the Removed view lists
            // gathering-bin rows only, so `gatheringBin` says so (point 9).
            const message =
              problem === 'upload_failed'
                ? "This upload didn't finish."
                : problem === 'confirm_failed'
                  ? "This upload couldn't be confirmed."
                  : mediaStateMessage(item, { isHost, organises, gatheringBin: binView })
            const offerRetry = item.status === 'failed' || problem !== undefined
            // The editor: the caller's own rows only (the server reserves
            // the edit to the uploader — no affordance that cannot succeed),
            // and never on a row whose one affordance is try again — a
            // failed photograph has nothing to caption.
            const offerEdit = item.is_own && !offerRetry
            const editing = offerEdit && editingId === item.id
            // The acts: the host, on a ready row that is pending — the
            // server's own criterion, so no control is ever offered on a
            // row the server would refuse; and a waiting row on the screen
            // is what makes `reviewer` true for the host, so it always
            // carries them. The checkbox belongs to the queue view, where
            // the batch is built.
            const reviewable = reviewer && awaitingReview(item)
            const declining = reviewable && decliningId === item.id
            // Your own photographs (CK-64): the three PERSONAL acts render
            // on the caller's OWN ready rows and nowhere else — never on
            // someone else's row, whoever the viewer is (an organiser's
            // controls on someone else's row are the CK-67 blocks below,
            // and different acts), never on a failed or in-flight row,
            // never on a row whose upload failed from this device, and
            // never in the Removed view, where an own row is a
            // gathering-bin row (point 9). The server would refuse each of
            // those, and the 404 on someone else's row is the audience
            // rule, not a broken control. Which two of the three a row
            // carries follows its state: to the bin or back from it, and
            // delete permanently on both.
            const ownReady = item.is_own && item.status === 'ready' && problem === undefined
            const inBin = item.publication_state === 'removed'
            const binnable =
              ownReady &&
              !binView &&
              (inBin || item.publication_state === 'live' || item.publication_state === 'pending')
            // The organisers' side (CK-67; a co-host's too since CK-69):
            // Remove from gathering on someone ELSE's live, ready row and
            // no other — not on a pending row, which keeps Decline (same
            // result, one act per state; reserved to the host), not on the
            // caller's own rows, which keep the personal controls above,
            // and never for a non-organiser. And the gathering-bin controls
            // on a gathering-bin row — someone else's removed, ready row,
            // which only an organiser is ever shown (CK-66's audience
            // rule), or ANY removed row in the Removed view, the caller's
            // own included (the view lists gathering-bin rows and nothing
            // else).
            const removable =
              organises && !item.is_own && item.status === 'ready' && item.publication_state === 'live'
            const removing = removable && removingId === item.id
            const inGatheringBin =
              organises &&
              item.status === 'ready' &&
              item.publication_state === 'removed' &&
              (binView || !item.is_own)
            // Delete permanently in the gathering's bin is the host's, or
            // the uploader's on their own — never a co-host's on someone
            // else's photograph (co-hosts §4 as amended by two-bins §4; the
            // server's `_may_destroy`). The step serves both bins (CK-64
            // the caller's own; CK-67 the gathering's): one step, one
            // constant, one sentence.
            const destroyable = inGatheringBin && (isHost || item.is_own)
            const deleting = (binnable || destroyable) && deletingId === item.id
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
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => {
                      // The editor and the delete step never share the row
                      // (CK-64): opening one closes the other. The remove
                      // step (CK-67) closes with them.
                      setDeletingId(null)
                      setRemovingId(null)
                      setEditingId(item.id)
                    }}
                  >
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
                {binnable && !deleting && (
                  // Your own photographs (CK-64). To the bin is one click — it
                  // can be undone. Back from it lets the server decide where the
                  // photograph goes (the gate, at restore time); where the
                  // gathering requires approval the hint says so, from the
                  // reader's seat — the host is told it waits for THEM, never
                  // for "the host", which would be themselves (the CK-43.1
                  // rule). Delete permanently only OPENS the step below.
                  <div className="media-review media-bin">
                    {inBin ? (
                      <button
                        type="button"
                        disabled={actingId !== null}
                        onClick={() => void bin(item, 'restore')}
                      >
                        {actingId === item.id && actingAct === 'restore' ? 'Putting back…' : 'Put back'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="link-button"
                        disabled={actingId !== null}
                        onClick={() => void bin(item, 'remove')}
                      >
                        {actingId === item.id && actingAct === 'remove' ? 'Sending to bin…' : 'Send to bin'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="link-button"
                      disabled={actingId !== null}
                      onClick={() => {
                        setEditingId(null)
                        setRemovingId(null)
                        setDeletingId(item.id)
                      }}
                    >
                      Delete permanently
                    </button>
                    {inBin && requiresApproval && (
                      <p className="field-hint">
                        {isHost ? RESTORE_HINT_WAITS_FOR_YOU : RESTORE_HINT_HOST_LOOKS}
                      </p>
                    )}
                  </div>
                )}
                {deleting && (
                  // The permanent delete's second step (bin record §7.1; two-bins
                  // §4): the sentence verbatim — "from <the product>" because a
                  // photograph already in a printed book is out of reach — taken
                  // on a deliberate second click, inline, with a do-nothing
                  // beside it (the decline's shape; never a browser dialog). The
                  // step stays open while the request runs and closes with its
                  // outcome; the word "cancel" appears nowhere in it (CK-30).
                  <div className="media-review media-decline" role="group" aria-label={`Delete ${name}`}>
                    <p className="field-hint">{DELETE_PERMANENTLY_CONFIRMATION}</p>
                    <button
                      type="button"
                      disabled={actingId !== null}
                      onClick={() => void bin(item, 'destroy')}
                    >
                      {actingId === item.id ? 'Deleting…' : 'Delete permanently'}
                    </button>
                    <button
                      type="button"
                      className="link-button"
                      disabled={actingId !== null}
                      onClick={() => setDeletingId(null)}
                    >
                      Keep it
                    </button>
                  </div>
                )}
                {removable && !removing && (
                  // The organiser's takedown (CK-67; two-bins §1; a
                  // co-host's since CK-69): only OPENS the step below —
                  // the uploader loses sight of the photograph at once, so
                  // the act takes a deliberate second click, like decline.
                  // Opening it closes every other row step.
                  <div className="media-review media-bin">
                    <button
                      type="button"
                      className="link-button"
                      disabled={actingId !== null}
                      onClick={() => {
                        setEditingId(null)
                        setDeletingId(null)
                        setDecliningId(null)
                        setRemovingId(item.id)
                      }}
                    >
                      Remove from gathering
                    </button>
                  </div>
                )}
                {removing && (
                  // The remove step (CK-67; its sentence by seat and gate
                  // since CK-69): who will still see it — the organisers,
                  // named from the reader's seat, and nobody else: the
                  // uploader loses sight of it at once (two-bins §2: from
                  // their side it is gone; no notice exists, §8 open) — and
                  // the way back, which CK-63's REMOVED_BIN window enforces
                  // today; a co-host's way back passes through the gate,
                  // and their sentence says so where the gathering requires
                  // approval (lib/media.ts::takedownSentence). "Remove it"
                  // acts; "Leave it" does nothing; the step stays open while
                  // its request runs and closes with the outcome.
                  <div
                    className="media-review media-decline"
                    role="group"
                    aria-label={`Remove ${name} from this gathering`}
                  >
                    <p className="field-hint">{takedownSentence({ isHost, requiresApproval })}</p>
                    <button
                      type="button"
                      disabled={actingId !== null}
                      onClick={() => void bin(item, 'remove', 'gathering')}
                    >
                      {actingId === item.id && actingAct === 'remove' ? 'Removing…' : 'Remove it'}
                    </button>
                    <button
                      type="button"
                      className="link-button"
                      disabled={actingId !== null}
                      onClick={() => setRemovingId(null)}
                    >
                      Leave it
                    </button>
                  </div>
                )}
                {inGatheringBin && !deleting && (
                  // The gathering's bin row (CK-67, on CK-66's backend; a
                  // co-host's since CK-69): Put back is one click — it can
                  // be undone. A host restore always goes `live`, whatever
                  // the gate says (two-bins §4: the host putting it back IS
                  // the host approving it), and so does any restore in an
                  // open gathering, so the hint says everyone will see it
                  // again; a co-host's restore in a gated gathering passes
                  // through the gate (CK-68), so their hint says the host
                  // will look at it again — the personal bin's constant,
                  // never a second copy. Delete permanently only OPENS the
                  // shared step above — the per-photograph empty, the
                  // host's or the uploader's own, never a co-host's on
                  // someone else's; no bulk empty exists.
                  <div className="media-review media-bin">
                    <button
                      type="button"
                      disabled={actingId !== null}
                      onClick={() => void bin(item, 'restore', 'gathering')}
                    >
                      {actingId === item.id && actingAct === 'restore' ? 'Putting back…' : 'Put back'}
                    </button>
                    <p className="field-hint">
                      {isHost || !requiresApproval ? RESTORE_HINT_EVERYONE : RESTORE_HINT_HOST_LOOKS}
                    </p>
                    {destroyable && (
                      <button
                        type="button"
                        className="link-button"
                        disabled={actingId !== null}
                        onClick={() => {
                          setEditingId(null)
                          setRemovingId(null)
                          setDeletingId(item.id)
                        }}
                      >
                        Delete permanently
                      </button>
                    )}
                  </div>
                )}
                {reviewable && !declining && (
                  <div className="media-review">
                    <button
                      type="button"
                      disabled={actingId !== null}
                      onClick={() => void act(item, 'publish')}
                    >
                      {actingId === item.id && actingAct === 'publish' ? 'Publishing…' : 'Publish'}
                    </button>
                    <button
                      type="button"
                      className="link-button"
                      disabled={actingId !== null}
                      onClick={() => {
                        // The decline step and the remove step (CK-67)
                        // never share the screen: each closes the other.
                        setRemovingId(null)
                        setDecliningId(item.id)
                      }}
                    >
                      Decline
                    </button>
                  </div>
                )}
                {declining && (
                  // Decline is removal (record §4) into the GATHERING's bin
                  // (two-bins record §3, CK-63): the gathering never sees it,
                  // and neither does its uploader — from their side it is gone
                  // — and nothing is destroyed. Since CK-66/CK-67 the host HAS
                  // a way back — the Removed view, Put back for 30 days — so
                  // the confirmation names it in the Remove step's words
                  // (CK-67.1; from CK-63 it said nobody would see it again,
                  // true only while the gathering's bin had no reader), and
                  // since CK-69 THE REMOVE STEP'S HOST FORM EXACTLY: who will
                  // still see it — "you and any co-hosts", true whether or
                  // not co-hosts exist — and the way back; the decline is
                  // reserved, so the reader is always the host. It stopped
                  // naming the uploader, because "neither will {who}" was
                  // false where {who} is a co-host. It promises the uploader
                  // nothing. Said plainly, and taken on a deliberate second
                  // click, with a do-nothing beside it. The host declining
                  // THEIR OWN photograph is its remover and its uploader, so
                  // that row stays in their own bin: the own-photo line is
                  // true and stays.
                  <div className="media-review media-decline" role="group" aria-label={`Decline ${name}`}>
                    <p className="field-hint">
                      {item.is_own
                        ? `The gathering won't see this photo. You can still see it yourself for ${REMOVED_BIN_DAYS} days.`
                        : takedownSentence({ isHost: true, requiresApproval })}
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
            {mediaStateMessage(opened, { isHost, organises, gatheringBin: binView })}
          </p>
          <button type="button" onClick={() => setOpenedId(null)}>
            Close
          </button>
        </div>
      )}
    </div>
  )
}
