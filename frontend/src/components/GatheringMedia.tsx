import {
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react'
import { Link } from 'react-router-dom'
import { authFetch } from '../lib/api'
import {
  announceCoverChange,
  COVER_REFUSED,
  groupCoverConfirmSentence,
  groupCoverSetLine,
  NOT_NOW,
  setCoverFromPhoto,
  USE_AS_COVER,
  USE_AS_GROUP_COVER,
  type CoverBody,
} from '../lib/covers'
import { formatDayWithYear, formatInstant } from '../lib/datetime'
import {
  describedBy,
  errorsFromResponse,
  errorType,
  networkErrors,
  noErrors,
  type FormErrors,
} from '../lib/formErrors'
import { type GatheringGroup, type Occurrence } from '../lib/gatherings'
import { groupRoleFlags, readGroup } from '../lib/groups'
import {
  anyInFlight,
  anyWaiting,
  awaitingReview,
  binMedia,
  binRefusalMessage,
  confirmUpload,
  DELETE_PERMANENTLY_CONFIRMATION,
  dismissMedia,
  dismissRefusalMessage,
  failureRetry,
  fetchLayerObjectUrl,
  intentErrorFields,
  intentItem,
  isPublishedPhoto,
  KEEPER_SPACE_FULL,
  MAX_PUBLISH_BATCH,
  mediaListPath,
  mediaName,
  mediaStateMessage,
  mediaWordsPatch,
  photoCountLabel,
  PICKER_ACCEPT,
  POLL_INTERVAL_MS,
  publishBatchErrorFields,
  putUpload,
  REMOVED_BIN_DAYS,
  RESTORE_HINT_EVERYONE,
  RESTORE_HINT_HOST_LOOKS,
  RESTORE_HINT_WAITS_FOR_YOU,
  RETRY_LABEL,
  reviewMedia,
  reviewRefusalMessage,
  SEARCH_DEBOUNCE_MS,
  takedownSentence,
  whoFor,
  wordsErrorFields,
  type BinAct,
  type IntentResponse,
  type MediaItem,
  type MediaList,
  type ReviewAct,
} from '../lib/media'
import { FieldError, FormLevelErrors } from './FieldError'
import { usePagePlace } from './pagePlace'
import { LazyThumbnail, PhotoViewer, TagList } from './PhotoViewer'
import { firstFieldWithError, useFocusRequest, useRefMap, type FocusSource } from './useFocusRequest'
import { PREVIEW_PHONE, PREVIEW_WIDE_COUNT, usePreviewWide } from './usePreviewWide'
import { useViewerEntry } from './useViewerEntry'

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
// And, since CK-71, a photograph that cannot be kept (pipeline record §6.5
// as amended — three defects, one subject: what a person is told when a
// photograph fails):
//
// 10. A FAILED ROW SAYS WHY, AND ITS CONTROLS ARE THE UPLOADER'S. The
//    server writes `failure_reason` at the dead-letter and lists a failed
//    row to its uploader alone (§6.5: failure belongs to the uploader —
//    until CK-71 the host read every guest's failure beside a Try again
//    that opened the host's own picker). The line follows the reason
//    (lib/media.ts::failureMessage; the second sentence, what will work,
//    for the uploader alone), and so do the controls (failureRetry): a
//    retry only where a retry can succeed — Try again for an upload that
//    did not finish or a worker that was interrupted, Choose a smaller
//    copy for a photograph over the pixel guard, nothing for a file that
//    is not a photo — and Dismiss beside every one of them, ONE click
//    with no confirmation, because it removes a row that holds nothing:
//    no photograph, no bytes, nothing anyone else can see. On the 204 the
//    row leaves the list on the re-read. The gate on the controls is
//    `is_own` and does not lean on the server's audience: a failed row
//    that is not the caller's gets the line and nothing to press. The
//    device-side lines (a PUT or a confirm that failed FROM HERE) and
//    their Try again are untouched — those rows are not `failed` on the
//    server, and are reaped at 24 hours.
//
// And, since CK-84, covers (decisions/2026-10-31-the-design-and-how-it-is-merged.md
// §1.3; the CK-84 kickoff, Steven's answers of 2026-11-01):
//
// 11. A COVER IS CHOSEN FROM THE OPENED PHOTO, AND ONLY FROM A PUBLISHED ONE.
//    On a `ready`, `live` photograph — never a pending, removed or failed
//    one, which the server would refuse — the viewer offers Use as cover to
//    the gathering's organisers (`organises`), in ONE click: a gathering's
//    cover is seen by its memory tier, the same people who see the live
//    photograph. It is hidden on the photograph that already is the cover
//    (the gathering body names it), and a success hands the PUT's `cover`
//    to the page, whose card draws it at once. On a group's gathering the
//    viewer offers Use as the group's cover to the GROUP's admin and
//    co-admins — no gathering role is needed, since a member only shared
//    with the gathering may run the group — read from `GET /groups/{id}`'s
//    `caller_role` once, the first time the viewer opens from the grid
//    (CK-88, Steven's answer of 2026-11-02: the section is open on load now,
//    and the photos-only page still loads in two requests), and only on a
//    group's gathering. It always shows for
//    them, because no group body names its photograph, and it takes a
//    second step saying who will see the photograph — everyone in the group,
//    including people who cannot see this gathering. A success says the
//    group's cover is set; a refusal of either reads the house line, and
//    nothing is re-read. Each landing tells the menu (announceCoverChange).
//    Nothing else in this section changes: no cover is listed among the
//    photos, and a cover is never counted.
//
// And, since CK-87, the page's Add photos (the gathering page in the mockup's
// layout; Steven's answer 2 of 2026-11-01):
//
// 12. ONE PRESS UNDER THE COVER OPENS THE DEVICE'S PICKER. The page holds a
//    handle on this section (`ref`, `GatheringMediaHandle`) and its Add
//    photos calls `pickPhotos()` inside the click: the input — rendered from
//    the start, since the section is open on load (CK-88) — is clicked in
//    the same handler, before anything is awaited, because a picker needs
//    the click's user activation (CK-79's lesson). The chosen files wait in
//    the form as before, and Upload sends them as before — nothing about
//    uploading changes. When the picker closes with files chosen after that
//    press, the section is brought into view and focus moves to Upload; a
//    choice made in the form itself leaves focus where it was, as before.
//    Without the upload form (`canUpload` false) the handle does nothing.
//
// And, since CK-88, the grid and the photo viewer (the merge record §1.4 and
// §3 item 8; Steven's answers of 2026-11-02):
//
// 13. A GATHERING'S PUBLISHED PHOTOS ARE A GRID, OPENED IN THE VIEWER, WHICH
//    CARRIES THEIR ACTIONS. The section is open on load — no toggle — and
//    reads the list at once, in both views (the list is not something the
//    photos-only view withholds). Its head is the heading and the count: the
//    published, ready photos of the last All-view read made without a
//    search, which a search, the queue or the bin never changes. In the All
//    view every published, ready photo is a tile in the grid (`.pgrid`), a
//    button named "Photo {i} of {n} in {gathering}" holding the thumbnail
//    layer and no control; the first 6 on a phone and 8 from 640px (the
//    window), then See all {N} photos, which shows the rest in place, moves
//    focus to the first it revealed, and stays for as long as the page is
//    open (Steven); with a search every match shows. A tile not rendered
//    mints nothing, and one below the fold mints when it nears the
//    viewport. Every other photo stays a row, with its acts on the row,
//    unchanged — the host's waiting rows first, then the caller's others —
//    and the queue and the bin are rows as before. A tile opens the viewer
//    on the grid's photos (components/PhotoViewer.tsx); a row's thumbnail
//    opens it on that photo alone, with no act, because the row keeps them.
//    In the viewer, a published photo carries exactly the acts its row
//    carried, from the same predicates and calls — Edit caption and tags,
//    Send to bin and Delete permanently on your own, Remove from gathering
//    on someone else's for an organiser, the two covers — each with its
//    step, its sentence and its refusal by code; a photo the person
//    uploaded keeps its acts in the photos-only view as its row did, and
//    nothing else is offered there but the group's cover to the group's
//    admin and co-admins (Steven). A landing that takes the photo out of the
//    grid closes the viewer and puts focus where the next thing is: the
//    photo's new row's Put back, the Removed view's button, or the heading
//    with "Photo deleted.". Opening the viewer adds ONE history entry for the
//    same path and search, its state `{ photoViewer: true }` and nothing
//    else; Back closes it, and Close and Escape close it and pop that entry,
//    so the history ends where it began.
// 14. THE ARRIVAL (CK-88.1b; Steven's answer 6): a group page's See all lands
//    here at `#photos`, and the page says so once, as this section mounts:
//    every published photo showing, with no second See all and each tile still
//    minting as it nears the viewport. Once the section's first read has settled
//    its tiles have their height and the page can reach it (a scroll made at
//    mount stopped short), so then the section scrolls into view and focus moves
//    to the heading. It runs once, because opening the viewer pushes an entry
//    with no hash and closing it pops back to the hash. A return owes no arrival
//    (CK-88.2): Back to a `#photos` entry lands where the person was, its grid
//    still out, and the frame's place re-applied as this section's tiles land.

// What the page holds on this section (CK-87, point 12).
export interface GatheringMediaHandle {
  pickPhotos: () => void
}

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
  // The gathering's dates, for the label on a photograph — or NULL when the
  // dates are WITHHELD (the photos-only view, CK-80): then no photograph
  // carries a date label, and no row — nor the viewer's "Added by" line
  // (CK-88) — shows the moment it was added either (that moment says when
  // the event was, which the view withholds). Withheld is not empty: null
  // never reads as a gathering with no dates.
  occurrences: Occurrence[] | null
  // Whether the caller may add photographs (CK-80): false in the
  // photos-only view, where the server refuses an upload intent (a member
  // only shared with sees the photos and adds none — record §11 item 4).
  // Then no upload form renders and no row offers a retry that would open
  // the picker. Default true: every pre-CK-80 site means exactly what it
  // meant.
  canUpload?: boolean
  // The gathering's cover (CK-84), read to hide Use as cover on the
  // photograph that already is it. Absent reads as none.
  cover?: CoverBody | null
  // The group the gathering belongs to (CK-84), or null: on a group's
  // gathering the group's admin and co-admins get Use as the group's cover.
  group?: GatheringGroup | null
  // The gathering's title, for the group's confirming step.
  gatheringTitle?: string
  // The page's card draws the cover the PUT answered with.
  onCoverSet?: (cover: CoverBody | null) => void
  zone: string
  // Overridable for tests only; the product uses the one constant each.
  pollIntervalMs?: number
  searchDebounceMs?: number
  // The page's handle for Add photos (CK-87, point 12).
  ref?: Ref<GatheringMediaHandle>
  // The page's address is the gathering's Photos (CK-88.1b, point 14): read
  // once, as this section mounts.
  arrivedAtPhotos?: boolean
  // The line about who can see a group's gathering (CK-93; the record §6),
  // drawn straight after the section's head in both views: the page hands
  // it to the group's members alone. Absent or null draws nothing.
  groupLine?: string | null
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

// A row's thumbnail, as an <img> over a blob: URL, in the button that opens the
// photo. Owns the object URL for its lifetime and revokes it on unmount or
// re-fetch — the bytes stay in this browser, the credential that fetched them
// is gone. One that can't be shown keeps the button, on the ground alone as a
// tile does, with its line and Retry beside it: a button can't hold a button,
// and Retry asks again without opening anything. Retry goes as it is pressed,
// so focus moves to the button, which stays.
function RowThumbnail({
  mediaId,
  label,
  onOpen,
}: {
  mediaId: string
  label: string
  onOpen: (opener: HTMLButtonElement) => void
}) {
  const [state, setState] = useState<LayerState>({ status: 'loading' })
  const [retryKey, setRetryKey] = useState(0)
  const opener = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let cancelled = false
    let held: string | null = null
    setState({ status: 'loading' })
    void fetchLayerObjectUrl(mediaId, 'thumbnail').then((outcome) => {
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
  }, [mediaId, retryKey])

  return (
    <>
      <button
        ref={opener}
        type="button"
        className="media-thumb-button"
        onClick={(event) => onOpen(event.currentTarget)}
        aria-label={label}
      >
        {state.status === 'shown' ? (
          <img className="media-thumb" src={state.objectUrl} alt="" />
        ) : (
          <span className="media-thumb media-placeholder">{state.status === 'loading' ? 'Loading…' : null}</span>
        )}
      </button>
      {state.status === 'failed' && (
        <>
          <p className="field-hint">
            {state.reason === 'not_ready' ? 'Not ready to show yet.' : "Couldn't show this photo just now."}
          </p>
          <button
            type="button"
            className="link-button"
            onClick={() => {
              opener.current?.focus()
              setRetryKey((key) => key + 1)
            }}
          >
            Retry
          </button>
        </>
      )}
    </>
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
  autoFocus = false,
}: {
  item: MediaItem
  onSaved: () => void
  onClose: () => void
  // The viewer's editor takes focus as it opens (CK-88), and a row's too
  // since CK-95.
  autoFocus?: boolean
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
  // Focus after an answer (CK-95): a 422 on a field goes to that field, the
  // first in the form's order; anything else back to Save, still there.
  const formRef = useRef<HTMLFormElement>(null)
  const saveRef = useRef<HTMLButtonElement>(null)
  const focusInForm = useFocusRequest(formRef)

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
      focusInForm(() => firstFieldWithError(formRef.current) ?? saveRef.current)
    } catch {
      if (alive.current) {
        setErrors(networkErrors())
        focusInForm(saveRef)
      }
    } finally {
      if (alive.current) setSaving(false)
    }
  }

  return (
    <form
      ref={formRef}
      className="media-editor"
      onSubmit={(event) => void save(event)}
      aria-label={`Edit ${mediaName(item)}`}
    >
      <label htmlFor={`${scope}-caption`}>Caption</label>
      <input
        id={`${scope}-caption`}
        type="text"
        maxLength={500}
        autoFocus={autoFocus}
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

      <button ref={saveRef} type="submit" disabled={!dirty || saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
      <button type="button" className="link-button" onClick={onClose}>
        Cancel
      </button>
      <FormLevelErrors errors={errors} />
    </form>
  )
}

// Where focus goes once the viewer has closed: back to what opened it, to the
// Photos heading, to the Removed view's button, or to a row's Put back once
// the re-read that brings the row has landed.
type PendingFocus =
  | { kind: 'opener'; element: HTMLElement | null }
  | { kind: 'heading' }
  | { kind: 'binView' }
  | { kind: 'putBack'; mediaId: string; afterRead: number }

// A focus owed to the re-read an act asked for (CK-95), spent by the first read
// that STARTED after the act landed: a row's act on the row's own control that
// carries it on, where the row is still listed, else on THE ROW GONE's rule
// (GatheringMedia's afterRead); the section's own acts on the heading; the
// viewer's Refresh on its Close. A read that fails spends it on the section's
// Try again (the viewer's Close in the viewer).
interface OwedAfterRead {
  kind: 'row' | 'section' | 'viewer'
  seq: number
  mediaId?: string
  index?: number
  carryOn?: string
  container?: HTMLElement | null
}

interface ViewerState {
  // 'grid': the grid's photos; 'row': one row's photo alone, with no act.
  mode: 'grid' | 'row'
  mediaId: string
  opener: HTMLElement | null
}

export function GatheringMedia({
  gatheringId,
  isHost,
  organises: organisesProp,
  requiresApproval,
  occurrences,
  canUpload = true,
  cover = null,
  group = null,
  gatheringTitle = '',
  onCoverSet,
  zone,
  pollIntervalMs = POLL_INTERVAL_MS,
  searchDebounceMs = SEARCH_DEBOUNCE_MS,
  ref,
  arrivedAtPhotos = false,
  groupLine = null,
}: Props) {
  // The delegable flag (point 9): a host organises by definition.
  const organises = organisesProp ?? isHost
  const [items, setItems] = useState<MediaItem[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  // Every successful read, counted (CK-88): a focus owed to a row that the
  // NEXT read brings waits for it.
  const [readSeq, setReadSeq] = useState(0)
  const readSeqRef = useRef(0)
  // The heading's count (CK-88, point 13): the published, ready photos of the
  // last All-view read made without a search — null until one lands.
  const [publishedCount, setPublishedCount] = useState<number | null>(null)
  // See all (point 13): the grid's rest shown in place, for as long as the
  // page is open (Steven's answer of 2026-11-02); and the tile focus is owed
  // to once it has rendered. The arrival (point 14) starts it out, and so does
  // a return to a page left with it out (CK-88.2): a grid that folded on Back
  // would clamp the place being restored.
  const { isReturn, shownAll, rememberShownAll } = usePagePlace()
  const [expanded, setExpanded] = useState(arrivedAtPhotos || shownAll)
  const [focusTile, setFocusTile] = useState<string | null>(null)
  const previewWide = usePreviewWide()
  // The photo viewer (point 13): what is open, and where focus goes once it
  // has closed.
  const [viewer, setViewer] = useState<ViewerState | null>(null)
  const [pendingFocus, setPendingFocus] = useState<PendingFocus | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const binViewButton = useRef<HTMLButtonElement>(null)
  const tileRefs = useRef(new Map<string, HTMLButtonElement>())
  const putBackRefs = useRef(new Map<string, HTMLButtonElement>())

  const [files, setFiles] = useState<File[]>([])
  const [errors, setErrors] = useState<FormErrors>(noErrors())
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [problems, setProblems] = useState<Record<string, LocalProblem>>({})
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
  const [actingAct, setActingAct] = useState<ReviewAct | BinAct | 'dismiss' | null>(null)
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

  // Covers (CK-84; point 11). The caller's seat in the gathering's group,
  // read once the viewer first opens from the grid on a group's gathering
  // (CK-88; until then once the section opened) — null until then, and for
  // good when the read fails, which gates the group's button closed.
  // One cover act at a time; the group's second step, a refusal and the
  // group's success line are each held for the photograph they are about.
  const [groupSeat, setGroupSeat] = useState<{ name: string; organises: boolean } | null>(null)
  const [groupWanted, setGroupWanted] = useState(false)
  const [coverActing, setCoverActing] = useState(false)
  const [groupStepFor, setGroupStepFor] = useState<string | null>(null)
  const [coverNote, setCoverNote] = useState<{ mediaId: string; kind: 'refused' | 'group_set' } | null>(
    null,
  )
  const groupId = group?.id ?? null

  const fileInput = useRef<HTMLInputElement>(null)
  // Add photos (CK-87, point 12): the root, to bring the section into view;
  // the Upload button, to move focus to it; and whether the picker open now
  // was opened by the page's press — a choice made in the form itself moves
  // nothing — and, once files are chosen after that press, a focus owed.
  const blockRef = useRef<HTMLDivElement>(null)
  const uploadButton = useRef<HTMLButtonElement>(null)
  const pickedFromPage = useRef(false)
  const [focusUploadOwed, setFocusUploadOwed] = useState(false)

  // FOCUS AFTER AN ANSWER (CK-95; the components doc's Focus after an answer).
  // Each act's request is spent after the render that draws its target, and
  // only from the body or from inside the act's own container — a row's acts
  // their <li>, the upload form's and the batch's their form, the viewer's its
  // words column (.vinfo), and the section's own acts (Refresh the list, Try
  // again, Show all photos) the section — so a person who moved elsewhere
  // while an answer waited keeps their place. A step is a group labelled by
  // its sentence and takes focus as it opens, never its acting button.
  const sectionFocus = useFocusRequest(blockRef)
  const focusRow = useRef<HTMLElement | null>(null)
  const rowFocus = useFocusRequest(() => focusRow.current)
  const uploadForm = useRef<HTMLFormElement>(null)
  const uploadFocus = useFocusRequest(uploadForm)
  const batchForm = useRef<HTMLFormElement>(null)
  const batchSubmit = useRef<HTMLButtonElement>(null)
  const batchFocus = useFocusRequest(batchForm)
  const viewerFocusReq = useFocusRequest(() => document.querySelector<HTMLElement>('.vinfo'))
  const rowButtons = useRefMap<string>()
  const allViewButton = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const tryAgainRef = useRef<HTMLButtonElement>(null)
  const viewerStepRefs = useRef<Record<string, HTMLElement | null>>({})
  const declineSentence = useId()
  const deleteSentence = useId()
  const removeSentence = useId()
  const viewerDeleteSentence = useId()
  const viewerRemoveSentence = useId()
  const viewerGroupSentence = useId()
  const owedAfterRead = useRef<OwedAfterRead | null>(null)
  const loadSeq = useRef(0)
  const latestRows = useRef<MediaItem[]>([])
  const latestView = useRef<'all' | 'queue' | 'bin'>('all')
  const latestViewerId = useRef<string | null>(null)

  // A row's request: the row's <li> its container.
  function focusInRow(mediaId: string, target: FocusSource) {
    focusRow.current = rowButtons.get(`${mediaId}:row`)
    rowFocus(target)
  }

  // The act landed: the re-read it asks for owes focus.
  function owe(mark: Omit<OwedAfterRead, 'seq'>) {
    owedAfterRead.current = { ...mark, seq: loadSeq.current }
  }

  // THE ROW GONE: once the re-read lands, the row's own control that carries
  // the act on where the row is still listed; else in the queue Publish on the
  // row now at its place (the last row's where it was last), in the Removed
  // view Put back there; else the section's heading.
  function afterRead(owed: OwedAfterRead): HTMLElement | null {
    const listedNow = latestRows.current
    if (
      owed.mediaId !== undefined &&
      owed.carryOn !== undefined &&
      listedNow.some((item) => item.id === owed.mediaId)
    ) {
      const carry = rowButtons.get(`${owed.mediaId}:${owed.carryOn}`)
      if (carry !== null) return carry
    }
    const shown = latestView.current
    if (shown !== 'all' && listedNow.length > 0) {
      const next = listedNow[Math.min(owed.index ?? 0, listedNow.length - 1)]
      const carry = rowButtons.get(`${next.id}:${shown === 'queue' ? 'publish' : 'putBack'}`)
      if (carry !== null) return carry
    }
    return headingRef.current
  }

  // Called by each read with its own number, so only a read that started
  // after the act spends what the act owes.
  function spendOwed(seq: number, landed: boolean) {
    const owed = owedAfterRead.current
    if (owed === null || seq <= owed.seq) return
    owedAfterRead.current = null
    if (owed.kind === 'viewer') viewerFocusReq(viewerClose)
    else if (!landed) sectionFocus(tryAgainRef)
    else if (owed.kind === 'section') sectionFocus(headingRef)
    else {
      focusRow.current = owed.container ?? null
      rowFocus(() => afterRead(owed))
    }
  }
  // The load's effect calls the latest spendOwed, as it calls the latest
  // closeViewer, so the effect need not re-run on every render.
  const latestSpendOwed = useRef(spendOwed)

  function viewerClose(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[role="dialog"] button[aria-label="Close"]')
  }

  // In the viewer a target is the photograph's only while it is still the one
  // on screen: a person who moved to another photo keeps their place.
  function onViewerPhoto(mediaId: string, target: () => HTMLElement | null | undefined) {
    return () => (latestViewerId.current === mediaId ? (target() ?? null) : null)
  }

  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // The page's Add photos (point 12): click the input in the same press, so
  // the picker keeps the click's activation. The section is open from the
  // start (CK-88), so the input is already rendered.
  useImperativeHandle(
    ref,
    () => ({
      pickPhotos() {
        if (!canUpload) return
        const input = fileInput.current
        if (input === null) return
        pickedFromPage.current = true
        // A picker closed with nothing chosen owes nothing.
        input.addEventListener(
          'cancel',
          () => {
            pickedFromPage.current = false
          },
          { once: true },
        )
        input.click()
      },
    }),
    [canUpload],
  )

  // Files chosen after the page's press: bring the section into view and
  // move focus to Upload, once the button is enabled by the chosen files.
  useEffect(() => {
    if (!focusUploadOwed || files.length === 0) return
    setFocusUploadOwed(false)
    const section = blockRef.current?.closest('section') ?? blockRef.current
    section?.scrollIntoView?.({ block: 'start' })
    uploadButton.current?.focus({ preventScroll: true })
  }, [focusUploadOwed, files])

  useEffect(() => {
    if (!groupWanted || groupId === null) return
    let cancelled = false
    void readGroup(groupId).then((result) => {
      if (cancelled || result.status !== 'loaded') return
      setGroupSeat({ name: result.value.name, organises: groupRoleFlags(result.value.caller_role).organises })
    })
    return () => {
      cancelled = true
    }
  }, [groupWanted, groupId])

  useEffect(() => {
    const timer = setTimeout(() => setTerm(searchInput.trim()), searchDebounceMs)
    return () => clearTimeout(timer)
  }, [searchInput, searchDebounceMs])

  // The list loads as the section mounts (CK-88: open on load, in both
  // views), and re-reads after every upload step, on each poll tick, when
  // the search term settles, and when an organiser switches between all
  // photos, the queue (the host's) and the gathering's bin. The term rides
  // the request as `q`, the queue as `awaiting_review=true` and the bin as
  // `removed=true` — never both flags (mediaListPath refuses to emit two,
  // and the views are exclusive here); the server decides what the caller
  // may see and narrows within that — nothing is filtered or cached here.
  // The heading's count follows the All view's reads made without a search,
  // and no other.
  useEffect(() => {
    let cancelled = false
    async function load() {
      loadSeq.current += 1
      const seq = loadSeq.current
      try {
        const response = await authFetch(
          mediaListPath(gatheringId, term, { awaitingReview: queueView, removed: binView }),
        )
        if (cancelled) return
        if (response.ok) {
          const body = (await response.json()) as Partial<MediaList>
          const media = body.media ?? []
          setItems(media)
          setLoadFailed(false)
          if (!queueView && !binView && term === '') {
            setPublishedCount(media.filter(isPublishedPhoto).length)
          }
          readSeqRef.current += 1
          setReadSeq(readSeqRef.current)
          latestSpendOwed.current(seq, true)
        } else {
          setLoadFailed(true)
          latestSpendOwed.current(seq, false)
        }
      } catch {
        if (!cancelled) {
          setLoadFailed(true)
          latestSpendOwed.current(seq, false)
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [gatheringId, reloadKey, term, queueView, binView])

  // Poll while anything is still moving; stop the moment everything is
  // `ready` or `failed`. `items` is a fresh array per load, so each read
  // re-arms exactly one timer; a load that failed does not — the person gets
  // a retry control instead of a page hammering a failing endpoint. The
  // queue never polls by construction: every row in it is `ready`, and
  // nothing but the host's own act moves one (CK-43.1).
  useEffect(() => {
    if (loadFailed || items === null || !anyInFlight(items)) return
    const timer = setTimeout(() => setReloadKey((key) => key + 1), pollIntervalMs)
    return () => clearTimeout(timer)
  }, [loadFailed, items, pollIntervalMs])

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

  // Use as cover / Use as the group's cover (point 11): one PUT, the
  // photograph's id and nothing else. The gathering's answer goes to the
  // page's card; the group's is a line here, because the group's cover
  // changes on a page the person is not looking at.
  async function chooseAsCover(item: MediaItem, subject: 'gathering' | 'group') {
    const target = subject === 'gathering' ? gatheringId : groupId
    if (coverActing || target === null) return
    setCoverActing(true)
    setCoverNote(null)
    const outcome = await setCoverFromPhoto(subject, target, item.id)
    if (!alive.current) return
    setCoverActing(false)
    setGroupStepFor(null)
    // Focus (CK-95), while this photo is still the one on screen: the group's
    // step closes on either answer, back to its opener; the gathering's
    // refusal back on Use as cover; its success — the button gone, this photo
    // the cover now — on the viewer's Close.
    if (subject === 'group') viewerFocusReq(onViewerPhoto(item.id, () => viewerActRefs.current.group))
    else if (!outcome.ok) viewerFocusReq(onViewerPhoto(item.id, () => viewerActRefs.current.cover))
    else viewerFocusReq(onViewerPhoto(item.id, viewerClose))
    if (!outcome.ok) {
      setCoverNote({ mediaId: item.id, kind: 'refused' })
      return
    }
    if (subject === 'gathering') onCoverSet?.(outcome.cover)
    else setCoverNote({ mediaId: item.id, kind: 'group_set' })
    announceCoverChange()
  }

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

  function resetToAll() {
    setSearchInput('')
    setTerm('')
    clearBin()
    if (view !== 'all') switchView('all')
  }

  // Show all photos (CK-95): after a search, focus on Find a photo, cleared for
  // the next one; otherwise on the view switch's All photos, where there is one.
  function showAll() {
    const searched = term !== ''
    resetToAll()
    sectionFocus(() => (searched ? searchRef.current : (allViewButton.current ?? searchRef.current)))
  }

  // Refresh the list (CK-95): once the re-read lands, focus on the section's
  // heading — in the viewer, on its Close — and on Try again if it fails.
  function refresh(from: 'section' | 'viewer' = 'section') {
    clearBatch()
    clearBin()
    setRowErrors({})
    owe({ kind: from })
    setReloadKey((key) => key + 1)
  }

  // One act on one photograph (CK-43.1). Optimistic-free: a success re-reads
  // the list and the server's body is what renders (the row leaves the
  // queue; its line in the full list changes to the state it is now in). A
  // refusal is kept ON THE ROW, in this module's words for the server's
  // code, and the list is NOT re-read — a re-read could drop the row the
  // message is about (a declined photograph is in nobody's queue) and take
  // the explanation with it; the refresh control beside it is the way on.
  async function act(item: MediaItem, which: ReviewAct, index = 0) {
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
      // A decline puts the host's own photo in their own bin, its row
      // carrying Put back; any other landing leaves the row's place.
      owe({
        kind: 'row',
        mediaId: item.id,
        index,
        carryOn: which === 'decline' ? 'putBack' : undefined,
        container: rowButtons.get(`${item.id}:row`),
      })
      setReloadKey((key) => key + 1)
      return
    }
    setRowErrors((prev) => ({
      ...prev,
      [item.id]: { fields: {}, form: [reviewRefusalMessage(which, outcome)] },
    }))
    focusInRow(item.id, () => rowButtons.get(`${item.id}:${which}`))
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
  // It answers whether the act landed (CK-88), so the viewer can close on a
  // landing, or was refused (CK-95), so the viewer can put focus back; what
  // the act does is unchanged. A row's act passes its place, and focus follows
  // the rule on the row (CK-95).
  async function bin(
    item: MediaItem,
    which: BinAct,
    context: 'personal' | 'gathering' = 'personal',
    row: { index: number } | null = null,
  ): Promise<'landed' | 'refused' | null> {
    if (actingId !== null) return null
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
    if (!alive.current) return null
    setActingId(null)
    setActingAct(null)
    setDeletingId(null)
    setRemovingId(null)
    if (outcome.ok) {
      if (which === 'destroy') setNotice('Photo deleted.')
      setSelected((current) => current.filter((id) => id !== item.id))
      if (row !== null) {
        // Your own photo, to the bin or back from it, keeps its row: the
        // control that undoes the act carries it on.
        owe({
          kind: 'row',
          mediaId: item.id,
          index: row.index,
          carryOn:
            context === 'personal' && which === 'remove'
              ? 'putBack'
              : context === 'personal' && which === 'restore'
                ? 'sendToBin'
                : undefined,
          container: rowButtons.get(`${item.id}:row`),
        })
      }
      setReloadKey((key) => key + 1)
      return 'landed'
    }
    setRowErrors((prev) => ({
      ...prev,
      [item.id]: { fields: {}, form: [binRefusalMessage(outcome, { bin: context })] },
    }))
    if (row !== null) {
      // The step, where one was open, closed with the answer: back on the
      // button that opens it, or on the act pressed.
      const refused =
        which === 'destroy' ? 'delete' : which === 'restore' ? 'putBack' : context === 'gathering' ? 'remove' : 'sendToBin'
      focusInRow(item.id, () => rowButtons.get(`${item.id}:${refused}`))
    }
    return 'refused'
  }

  // Dismiss a photograph that could not be kept (CK-71; pipeline record §6.5
  // as amended): ONE click, no confirmation — the row holds nothing (no
  // photograph, no bytes, nothing anyone else can see), so there is
  // nothing a second step would protect. On the `actingId` guard like every
  // other act; optimistic-free — on the 204 the list is re-read and the row
  // is gone from it, which is the whole of what the person asked for, so no
  // status line follows; a refusal stays on the row, in this module's words
  // for the server's CODE, with Refresh the list beside it.
  async function dismiss(item: MediaItem, index = 0) {
    if (actingId !== null) return
    setActingId(item.id)
    setActingAct('dismiss')
    setDecliningId(null)
    clearBin()
    setRowErrors((prev) => {
      const { [item.id]: _dropped, ...rest } = prev
      return rest
    })
    const outcome = await dismissMedia(item.id)
    if (!alive.current) return
    setActingId(null)
    setActingAct(null)
    if (outcome.ok) {
      owe({ kind: 'row', mediaId: item.id, index, container: rowButtons.get(`${item.id}:row`) })
      setReloadKey((key) => key + 1)
      return
    }
    setRowErrors((prev) => ({
      ...prev,
      [item.id]: { fields: {}, form: [dismissRefusalMessage(outcome)] },
    }))
    focusInRow(item.id, () => rowButtons.get(`${item.id}:dismiss`))
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
        // THE ROW GONE, from the first of the published rows' places.
        const places = ids
          .map((id) => latestRows.current.findIndex((item) => item.id === id))
          .filter((place) => place !== -1)
        owe({ kind: 'row', index: places.length > 0 ? Math.min(...places) : 0, container: batchForm.current })
        setSelected([])
        setBatchSent([])
        setReloadKey((key) => key + 1)
        return
      }
      setBatchErrors(await errorsFromResponse(response, publishBatchErrorFields(ids.length)))
      // A refusal on one photo goes to its checkbox; any other, back to the
      // button pressed.
      batchFocus(
        () =>
          firstFieldWithError(blockRef.current?.querySelector<HTMLElement>('ul.media-list') ?? null) ??
          batchSubmit.current,
      )
    } catch {
      if (alive.current) {
        setBatchErrors(networkErrors())
        batchFocus(batchSubmit)
      }
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
        // A 422 names the files or the batch: the picker, their field;
        // anything else back on Upload (CK-95).
        uploadFocus(response.status === 422 ? fileInput : uploadButton)
        return
      }
      intents = ((await response.json()) as IntentResponse).intents
    } catch {
      if (alive.current) {
        setErrors(networkErrors())
        setProgress(null)
        uploadFocus(uploadButton)
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
    resetToAll()
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
    // Every file gone up: the picker, cleared for the next ones (CK-95).
    uploadFocus(fileInput)
  }

  // §6.5's retry re-uploads FROM THE DEVICE — Try again, and since CK-71
  // Choose a smaller copy, both open the picker. Never a re-queue: the
  // quarantine original is deleted at dead-letter, so there is nothing on
  // the server to retry.
  function chooseAgain() {
    fileInput.current?.click()
  }

  // The date a photograph is labelled with — never where the dates are
  // withheld (`occurrences` null, the photos-only view, CK-80).
  function labelFor(item: MediaItem): string | null {
    if (occurrences === null || item.occurrence_id === null) return null
    const occurrence = occurrences.find((candidate) => candidate.id === item.occurrence_id)
    return occurrence ? formatInstant(occurrence.starts_at, zone) : null
  }
  const datesWithheld = occurrences === null

  // THE VIEWER (point 13). Opening it adds ONE history entry for the same
  // path and search, its state the marker alone; Back closes it (the effect
  // below), and every other close pops that entry, so the history ends where
  // it began. A grid tile opens the grid's photos; a row's thumbnail opens
  // its photo alone. The group's seat is read the first time the grid's
  // viewer opens (point 11).
  function openViewer(mode: 'grid' | 'row', mediaId: string, opener: HTMLElement | null) {
    if (viewer !== null) return
    setPendingFocus(null)
    setViewer({ mode, mediaId, opener })
    if (mode === 'grid') setGroupWanted(true)
    viewerEntry.push()
  }

  // The steps the viewer opened on a photograph close with it, or when it
  // moves to another; the rows' own steps are left alone.
  function closeStepsFor(mediaId: string) {
    setEditingId((current) => (current === mediaId ? null : current))
    setDeletingId((current) => (current === mediaId ? null : current))
    setRemovingId((current) => (current === mediaId ? null : current))
    setGroupStepFor((current) => (current === mediaId ? null : current))
  }

  function closeViewer(focus: PendingFocus | null = null, popHistory = true) {
    if (viewer === null) return
    if (popHistory) viewerEntry.pop()
    closeStepsFor(viewer.mediaId)
    setViewer(null)
    setPendingFocus(focus ?? { kind: 'opener', element: viewer.opener })
  }

  function moveViewer(mediaId: string) {
    if (viewer === null || mediaId === viewer.mediaId) return
    closeStepsFor(viewer.mediaId)
    setViewer({ ...viewer, mediaId })
  }

  // An act in the viewer that takes the photograph out of the grid: the
  // viewer closes, and focus goes where the next thing is — the photo's new
  // row's Put back after Send to bin (once the re-read brings the row), the
  // Removed view's button after Remove from gathering, and the heading after
  // Delete permanently, beside "Photo deleted.". The act itself is bin(),
  // unchanged.
  async function viewerBin(item: MediaItem, which: BinAct, context: 'personal' | 'gathering') {
    const outcome = await bin(item, which, context)
    if (outcome === null || !alive.current) return
    if (outcome === 'refused') {
      // The step, where one was open, closed with the answer: focus back on
      // the button that opens it, or on Send to bin, while this photo is
      // still the one on screen (CK-95).
      const key = which === 'destroy' ? 'delete' : context === 'gathering' ? 'remove' : 'bin'
      viewerFocusReq(onViewerPhoto(item.id, () => viewerActRefs.current[key]))
      return
    }
    closeViewer(
      which === 'destroy'
        ? { kind: 'heading' }
        : context === 'gathering'
          ? { kind: 'binView' }
          : { kind: 'putBack', mediaId: item.id, afterRead: readSeqRef.current },
    )
  }

  function keepRef(map: Map<string, HTMLButtonElement>, mediaId: string, element: HTMLButtonElement | null) {
    if (element === null) map.delete(mediaId)
    else map.set(mediaId, element)
  }

  const filtered = term !== ''
  const matchCount = items === null ? '' : photoCountLabel(items.length)
  const listed = items ?? []
  const allSelected = listed.length > 0 && listed.every((item) => selected.includes(item.id))
  const batchRefused = Object.keys(batchErrors.fields).length > 0

  // The grid (point 13): the All view's published, ready photographs, in the
  // list's order — a row this device knows did not finish stays a row, as
  // before. Everything else is a row; in the All view the host's waiting
  // rows come first, then the caller's others.
  const gridItems = allView
    ? listed.filter((item) => isPublishedPhoto(item) && problems[item.id] === undefined)
    : []
  const inGrid = new Set(gridItems.map((item) => item.id))
  const rows = allView
    ? [
        ...listed.filter((item) => !inGrid.has(item.id) && reviewer && awaitingReview(item)),
        ...listed.filter((item) => !inGrid.has(item.id) && !(reviewer && awaitingReview(item))),
      ]
    : listed
  const previewLimit = previewWide ? PREVIEW_WIDE_COUNT : PREVIEW_PHONE
  const showEveryTile = filtered || expanded
  const shownTiles = showEveryTile ? gridItems : gridItems.slice(0, previewLimit)
  const offerSeeAll = !showEveryTile && gridItems.length > previewLimit
  const countLine = publishedCount === null || publishedCount === 0 ? '' : photoCountLabel(publishedCount)

  // The viewer's set: the grid's photos, or a row's photo alone. If a re-read
  // takes the open photograph out of it, the viewer closes.
  const viewerPhotos =
    viewer === null
      ? []
      : viewer.mode === 'grid'
        ? gridItems
        : listed.filter((item) => item.id === viewer.mediaId)
  const viewerLost = viewer !== null && items !== null && !viewerPhotos.some((item) => item.id === viewer.mediaId)

  // The effects below close the viewer through the latest render's
  // closeViewer, which reads the state it closes.
  const latestCloseViewer = useRef(closeViewer)
  useLayoutEffect(() => {
    latestCloseViewer.current = closeViewer
  })

  // What a focus owed to a re-read reads when it is spent (CK-95): the rows
  // and the view of the render that drew them, and the photo on screen.
  useLayoutEffect(() => {
    latestRows.current = rows
    latestView.current = queueView ? 'queue' : binView ? 'bin' : 'all'
    latestViewerId.current = viewer === null || viewerLost ? null : viewer.mediaId
    latestSpendOwed.current = spendOwed
  })

  useEffect(() => {
    if (viewerLost) latestCloseViewer.current({ kind: 'heading' })
  }, [viewerLost])

  // Out, however it came to be out, is what a return to this page must find.
  useEffect(() => {
    if (expanded) rememberShownAll()
  }, [expanded, rememberShownAll])

  // The arrival (point 14): the section into view and focus on its heading,
  // once, when the first read has settled and the page is tall enough to get
  // there. The ref holds what the page said at mount; a later change of the hash
  // reads nothing. Back to a `#photos` entry lands where the person was, so a
  // return owes no arrival (CK-88.2), though its grid still starts out.
  const arrivalOwed = useRef(arrivedAtPhotos && !isReturn)
  const firstReadSettled = items !== null || loadFailed
  useEffect(() => {
    if (!arrivalOwed.current || !firstReadSettled) return
    arrivalOwed.current = false
    const section = blockRef.current?.closest('section') ?? blockRef.current
    section?.scrollIntoView?.({ block: 'start' })
    headingRef.current?.focus({ preventScroll: true })
  }, [firstReadSettled])

  // Back (Steven's answer 4): the entry the viewer pushed is left, so the
  // viewer closes without popping anything (components/useViewerEntry.ts).
  const viewerEntry = useViewerEntry(() => latestCloseViewer.current(null, false))

  // Focus, once the viewer has closed and the page is no longer inert.
  useEffect(() => {
    if (pendingFocus === null || viewer !== null) return
    const focus = (element: HTMLElement | null | undefined) => element?.focus({ preventScroll: true })
    if (pendingFocus.kind === 'opener') {
      const element = pendingFocus.element
      if (element !== null && element.isConnected && !(element as HTMLButtonElement).disabled) focus(element)
      else focus(headingRef.current)
    } else if (pendingFocus.kind === 'heading') {
      focus(headingRef.current)
    } else if (pendingFocus.kind === 'binView') {
      focus(binViewButton.current ?? headingRef.current)
    } else {
      if (readSeq <= pendingFocus.afterRead) return
      focus(putBackRefs.current.get(pendingFocus.mediaId) ?? headingRef.current)
    }
    setPendingFocus(null)
  }, [pendingFocus, viewer, readSeq])

  // The viewer's steps (CK-88; the mockup's): opening one moves focus to its
  // act, and closing it without acting returns focus to the button that
  // opened it — the button a step replaces would otherwise leave focus on
  // nothing, and the step below the fold of the words column.
  const [viewerFocus, setViewerFocus] = useState<'edit' | 'delete' | 'remove' | 'group' | null>(null)
  const viewerActRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  useEffect(() => {
    if (viewerFocus === null) return
    viewerActRefs.current[viewerFocus]?.focus()
    setViewerFocus(null)
  }, [viewerFocus])

  // See all's focus: the first tile it revealed, once it has rendered.
  useEffect(() => {
    if (focusTile === null) return
    tileRefs.current.get(focusTile)?.focus()
    setFocusTile(null)
  }, [focusTile])

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

  // THE VIEWER'S ACTS (point 13): exactly what a published, ready photo's row
  // carried before CK-88, from the same predicates and the same calls, each
  // with its step, its sentence and its refusal by code — on the caller's
  // own photograph, Edit caption and tags, Send to bin and Delete
  // permanently; on someone else's, for an organiser, Remove from gathering;
  // and the two covers. Nobody else is offered an act. Only the grid's
  // viewer has acts: a row keeps its own.
  function viewerActs(item: MediaItem): ReactNode {
    const published = isPublishedPhoto(item)
    const own = published && item.is_own && problems[item.id] === undefined
    const editing = own && editingId === item.id
    const deleting = own && deletingId === item.id
    const removable = published && organises && !item.is_own
    const removing = removable && removingId === item.id
    const offerCover = published && organises && !(cover?.source === 'photo' && cover.media_id === item.id)
    const groupStep = published && groupSeat?.organises === true && groupStepFor === item.id
    const offerGroupCover = published && groupSeat?.organises === true && !groupStep
    const rowError = rowErrors[item.id]
    // The acts' buttons in one wrapping row (the mockup's .vacts); a step,
    // the editor and every line beneath it.
    const anyButton = (own && (!editing || !deleting)) || (removable && !removing) || offerCover || offerGroupCover
    return (
      <>
        {anyButton && (
          <div className="vacts">
            {own && !editing && (
              <button
                ref={(element) => {
                  viewerActRefs.current.edit = element
                }}
                type="button"
                onClick={() => {
                  setDeletingId(null)
                  setRemovingId(null)
                  setEditingId(item.id)
                }}
              >
                Edit caption and tags
              </button>
            )}
            {own && !deleting && (
              <>
                <button
                  ref={(element) => {
                    viewerActRefs.current.bin = element
                  }}
                  type="button"
                  disabled={actingId !== null}
                  onClick={() => void viewerBin(item, 'remove', 'personal')}
                >
                  {actingId === item.id && actingAct === 'remove' ? 'Sending to bin…' : 'Send to bin'}
                </button>
                <button
                  ref={(element) => {
                    viewerActRefs.current.delete = element
                  }}
                  type="button"
                  disabled={actingId !== null}
                  onClick={() => {
                    setEditingId(null)
                    setRemovingId(null)
                    setDeletingId(item.id)
                    viewerFocusReq(() => viewerStepRefs.current.delete ?? null)
                  }}
                >
                  Delete permanently
                </button>
              </>
            )}
            {removable && !removing && (
              // The organiser's takedown (CK-67) on someone else's photo:
              // only OPENS the step below, closing every other step, as the
              // row's did.
              <button
                ref={(element) => {
                  viewerActRefs.current.remove = element
                }}
                type="button"
                disabled={actingId !== null}
                onClick={() => {
                  setEditingId(null)
                  setDeletingId(null)
                  setDecliningId(null)
                  setRemovingId(item.id)
                  viewerFocusReq(() => viewerStepRefs.current.remove ?? null)
                }}
              >
                Remove from gathering
              </button>
            )}
            {offerCover && (
              // Covers (point 11): only on a published photograph, hidden on
              // the one that already is the cover; one click.
              <button
                ref={(element) => {
                  viewerActRefs.current.cover = element
                }}
                type="button"
                disabled={coverActing}
                onClick={() => void chooseAsCover(item, 'gathering')}
              >
                {USE_AS_COVER}
              </button>
            )}
            {offerGroupCover && (
              // The group's cover: only OPENS its confirming step.
              <button
                ref={(element) => {
                  viewerActRefs.current.group = element
                }}
                type="button"
                disabled={coverActing}
                onClick={() => {
                  setCoverNote(null)
                  setGroupStepFor(item.id)
                  viewerFocusReq(() => viewerStepRefs.current.group ?? null)
                }}
              >
                {USE_AS_GROUP_COVER}
              </button>
            )}
          </div>
        )}
        {editing && (
          <MediaWordsEditor
            key={item.id}
            item={item}
            autoFocus
            onSaved={() => {
              // Optimistic-free: the server's body is what renders — the
              // viewer shows the saved words once the re-read lands.
              setEditingId(null)
              setViewerFocus('edit')
              setReloadKey((key) => key + 1)
            }}
            onClose={() => {
              setEditingId(null)
              setViewerFocus('edit')
            }}
          />
        )}
        {deleting && (
          // The step takes focus as it opens, never its Delete permanently
          // (CK-95): a second Enter confirms nothing.
          <div
            ref={(element) => {
              viewerStepRefs.current.delete = element
            }}
            className="media-review media-decline"
            role="group"
            aria-labelledby={viewerDeleteSentence}
            tabIndex={-1}
          >
            <p className="field-hint" id={viewerDeleteSentence}>
              {DELETE_PERMANENTLY_CONFIRMATION}
            </p>
            <button
              type="button"
              disabled={actingId !== null}
              onClick={() => void viewerBin(item, 'destroy', 'personal')}
            >
              {actingId === item.id ? 'Deleting…' : 'Delete permanently'}
            </button>
            <button
              type="button"
              className="link-button"
              disabled={actingId !== null}
              onClick={() => {
                setDeletingId(null)
                setViewerFocus('delete')
              }}
            >
              Keep it
            </button>
          </div>
        )}
        {removing && (
          <div
            ref={(element) => {
              viewerStepRefs.current.remove = element
            }}
            className="media-review media-decline"
            role="group"
            aria-labelledby={viewerRemoveSentence}
            tabIndex={-1}
          >
            <p className="field-hint" id={viewerRemoveSentence}>
              {takedownSentence({ isHost, requiresApproval })}
            </p>
            <button
              type="button"
              disabled={actingId !== null}
              onClick={() => void viewerBin(item, 'remove', 'gathering')}
            >
              {actingId === item.id && actingAct === 'remove' ? 'Removing…' : 'Remove it'}
            </button>
            <button
              type="button"
              className="link-button"
              disabled={actingId !== null}
              onClick={() => {
                setRemovingId(null)
                setViewerFocus('remove')
              }}
            >
              Leave it
            </button>
          </div>
        )}
        {groupStep && groupSeat !== null && (
          // The second, deliberate step: the first click only asked, and Not
          // now does nothing.
          <div
            ref={(element) => {
              viewerStepRefs.current.group = element
            }}
            className="media-decline"
            role="group"
            aria-labelledby={viewerGroupSentence}
            tabIndex={-1}
          >
            <p id={viewerGroupSentence}>{groupCoverConfirmSentence(groupSeat.name, gatheringTitle)}</p>
            <div className="media-review">
              <button type="button" disabled={coverActing} onClick={() => void chooseAsCover(item, 'group')}>
                {USE_AS_GROUP_COVER}
              </button>
              <button
                type="button"
                className="link-button"
                disabled={coverActing}
                onClick={() => {
                  setGroupStepFor(null)
                  setViewerFocus('group')
                }}
              >
                {NOT_NOW}
              </button>
            </div>
          </div>
        )}
        {published && groupSeat?.organises && (
          <p className="form-success" role="status">
            {coverNote?.mediaId === item.id && coverNote.kind === 'group_set' ? groupCoverSetLine(groupSeat.name) : ''}
          </p>
        )}
        {coverNote?.mediaId === item.id && coverNote.kind === 'refused' && (
          <p className="form-error" role="alert">
            {COVER_REFUSED}
          </p>
        )}
        {rowError && (
          // A refusal stays on the viewer's words, in this module's words for
          // the server's code; nothing is re-read, and this is the way on.
          <div className="media-review">
            <FormLevelErrors errors={rowError} />
            <button type="button" className="link-button" onClick={() => refresh('viewer')}>
              Refresh the list
            </button>
          </div>
        )}
      </>
    )
  }

  // The rows (CK-88): in the All view every photo that is not published and
  // ready — the host's waiting rows first, then the caller's others — and
  // in the queue and the bin every row, as before. Each row keeps its acts.
  const rowsList = rows.length > 0 && (
    <ul className="media-list" aria-label="Photos">
      {rows.map((item, index) => {
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
          // A row whose upload failed FROM THIS DEVICE (CK-38) keeps its one
          // affordance, Try again, exactly as it was: the row is not
          // `failed` on the server (it is reaped at 24 hours), so none of
          // the failed row's controls below apply to it.
          const deviceProblem = problem !== undefined
          // A `failed` row's line and controls follow its failure_reason,
          // and the controls are THE UPLOADER'S (CK-71; point 10). The
          // server lists a failed row to its uploader alone, but the gate
          // does not lean on that: a non-own failed row — should one ever
          // arrive — gets the line and nothing to press.
          const failedRow = item.status === 'failed' && !deviceProblem
          // A retry opens the picker, so it is offered only where an upload
          // can succeed (CK-80: never in the photos-only view).
          const failedRetry =
            failedRow && item.is_own && canUpload ? failureRetry(item.failure_reason) : null
          const dismissable = failedRow && item.is_own
          // The editor: the caller's own rows only (the server reserves
          // the edit to the uploader — no affordance that cannot succeed),
          // and never on a failed row or one whose upload failed from
          // here — a failed photograph has nothing to caption.
          const offerEdit = item.is_own && !failedRow && !deviceProblem
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
            <li key={item.id} className="media-item" ref={rowButtons.register(`${item.id}:row`)}>
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
                <RowThumbnail
                  mediaId={item.id}
                  label={`Open photo added by ${who}`}
                  onOpen={(opener) => openViewer('row', item.id, opener)}
                />
              )}
              <p>
                <strong>{name}</strong> — added by {who}
                {label ? ` for ${label}` : ''}
                {datesWithheld ? '' : `, ${formatInstant(item.created_at, zone)}`}
              </p>
              <TagList tags={item.tags} label={`Tags on ${name}`} />
              <p className={item.status === 'failed' || problem ? 'form-error' : 'field-hint'}>
                {message}
              </p>
              {deviceProblem && (
                <button type="button" className="link-button" onClick={chooseAgain}>
                  Try again
                </button>
              )}
              {dismissable && (
                // The uploader's controls on a failed row (CK-71; point 10): a
                // retry only where one can succeed — the label says which kind
                // — and Dismiss, one click, no confirmation. Both retry labels
                // open the picker: the re-upload is from the device.
                <div className="media-review media-bin">
                  {failedRetry !== null && (
                    <button type="button" className="link-button" onClick={chooseAgain}>
                      {RETRY_LABEL[failedRetry]}
                    </button>
                  )}
                  <button
                    ref={rowButtons.register(`${item.id}:dismiss`)}
                    type="button"
                    className="link-button"
                    disabled={actingId !== null}
                    onClick={() => void dismiss(item, index)}
                  >
                    {actingId === item.id && actingAct === 'dismiss' ? 'Dismissing…' : 'Dismiss'}
                  </button>
                </div>
              )}
              {offerEdit && !editing && (
                <button
                  ref={rowButtons.register(`${item.id}:edit`)}
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
                  autoFocus
                  onSaved={() => {
                    // Optimistic-free: the server's body is what renders, and
                    // focus waits for it, on the row's Edit caption and tags.
                    setEditingId(null)
                    owe({
                      kind: 'row',
                      mediaId: item.id,
                      index,
                      carryOn: 'edit',
                      container: rowButtons.get(`${item.id}:row`),
                    })
                    setReloadKey((key) => key + 1)
                  }}
                  onClose={() => {
                    setEditingId(null)
                    focusInRow(item.id, () => rowButtons.get(`${item.id}:edit`))
                  }}
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
                      ref={(element) => {
                        keepRef(putBackRefs.current, item.id, element)
                        rowButtons.register(`${item.id}:putBack`)(element)
                      }}
                      type="button"
                      disabled={actingId !== null}
                      onClick={() => void bin(item, 'restore', 'personal', { index })}
                    >
                      {actingId === item.id && actingAct === 'restore' ? 'Putting back…' : 'Put back'}
                    </button>
                  ) : (
                    <button
                      ref={rowButtons.register(`${item.id}:sendToBin`)}
                      type="button"
                      className="link-button"
                      disabled={actingId !== null}
                      onClick={() => void bin(item, 'remove', 'personal', { index })}
                    >
                      {actingId === item.id && actingAct === 'remove' ? 'Sending to bin…' : 'Send to bin'}
                    </button>
                  )}
                  <button
                    ref={rowButtons.register(`${item.id}:delete`)}
                    type="button"
                    className="link-button"
                    disabled={actingId !== null}
                    onClick={() => {
                      setEditingId(null)
                      setRemovingId(null)
                      setDeletingId(item.id)
                      focusInRow(item.id, () => rowButtons.get(`${item.id}:deleteStep`))
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
                <div
                  ref={rowButtons.register(`${item.id}:deleteStep`)}
                  className="media-review media-decline"
                  role="group"
                  aria-labelledby={deleteSentence}
                  tabIndex={-1}
                >
                  <p className="field-hint" id={deleteSentence}>
                    {DELETE_PERMANENTLY_CONFIRMATION}
                  </p>
                  <button
                    type="button"
                    disabled={actingId !== null}
                    onClick={() => void bin(item, 'destroy', 'personal', { index })}
                  >
                    {actingId === item.id ? 'Deleting…' : 'Delete permanently'}
                  </button>
                  <button
                    type="button"
                    className="link-button"
                    disabled={actingId !== null}
                    onClick={() => {
                      setDeletingId(null)
                      focusInRow(item.id, () => rowButtons.get(`${item.id}:delete`))
                    }}
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
                    ref={rowButtons.register(`${item.id}:remove`)}
                    type="button"
                    className="link-button"
                    disabled={actingId !== null}
                    onClick={() => {
                      setEditingId(null)
                      setDeletingId(null)
                      setDecliningId(null)
                      setRemovingId(item.id)
                      focusInRow(item.id, () => rowButtons.get(`${item.id}:removeStep`))
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
                  ref={rowButtons.register(`${item.id}:removeStep`)}
                  className="media-review media-decline"
                  role="group"
                  aria-labelledby={removeSentence}
                  tabIndex={-1}
                >
                  <p className="field-hint" id={removeSentence}>
                    {takedownSentence({ isHost, requiresApproval })}
                  </p>
                  <button
                    type="button"
                    disabled={actingId !== null}
                    onClick={() => void bin(item, 'remove', 'gathering', { index })}
                  >
                    {actingId === item.id && actingAct === 'remove' ? 'Removing…' : 'Remove it'}
                  </button>
                  <button
                    type="button"
                    className="link-button"
                    disabled={actingId !== null}
                    onClick={() => {
                      setRemovingId(null)
                      focusInRow(item.id, () => rowButtons.get(`${item.id}:remove`))
                    }}
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
                    ref={rowButtons.register(`${item.id}:putBack`)}
                    type="button"
                    disabled={actingId !== null}
                    onClick={() => void bin(item, 'restore', 'gathering', { index })}
                  >
                    {actingId === item.id && actingAct === 'restore' ? 'Putting back…' : 'Put back'}
                  </button>
                  <p className="field-hint">
                    {isHost || !requiresApproval ? RESTORE_HINT_EVERYONE : RESTORE_HINT_HOST_LOOKS}
                  </p>
                  {destroyable && (
                    <button
                      ref={rowButtons.register(`${item.id}:delete`)}
                      type="button"
                      className="link-button"
                      disabled={actingId !== null}
                      onClick={() => {
                        setEditingId(null)
                        setRemovingId(null)
                        setDeletingId(item.id)
                        focusInRow(item.id, () => rowButtons.get(`${item.id}:deleteStep`))
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
                    ref={rowButtons.register(`${item.id}:publish`)}
                    type="button"
                    disabled={actingId !== null}
                    onClick={() => void act(item, 'publish', index)}
                  >
                    {actingId === item.id && actingAct === 'publish' ? 'Publishing…' : 'Publish'}
                  </button>
                  <button
                    ref={rowButtons.register(`${item.id}:decline`)}
                    type="button"
                    className="link-button"
                    disabled={actingId !== null}
                    onClick={() => {
                      // The decline step and the remove step (CK-67)
                      // never share the screen: each closes the other.
                      setRemovingId(null)
                      setDecliningId(item.id)
                      focusInRow(item.id, () => rowButtons.get(`${item.id}:declineStep`))
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
                <div
                  ref={rowButtons.register(`${item.id}:declineStep`)}
                  className="media-review media-decline"
                  role="group"
                  aria-labelledby={declineSentence}
                  tabIndex={-1}
                >
                  <p className="field-hint" id={declineSentence}>
                    {item.is_own
                      ? `The gathering won't see this photo. You can still see it yourself for ${REMOVED_BIN_DAYS} days.`
                      : takedownSentence({ isHost: true, requiresApproval })}
                  </p>
                  <button type="button" onClick={() => void act(item, 'decline', index)}>
                    {actingId === item.id ? 'Declining…' : 'Decline it'}
                  </button>
                  <button
                    type="button"
                    className="link-button"
                    disabled={actingId !== null}
                    onClick={() => {
                      setDecliningId(null)
                      focusInRow(item.id, () => rowButtons.get(`${item.id}:decline`))
                    }}
                  >
                    Leave it waiting
                  </button>
                </div>
              )}
              {batchField && <FieldError errors={batchErrors} field={batchField} scope="publish" />}
              {rowError && (
                <div className="media-review">
                  <FormLevelErrors errors={rowError} />
                  <button type="button" className="link-button" onClick={() => refresh()}>
                    Refresh the list
                  </button>
                </div>
              )}
            </li>
          )

      })}
    </ul>
  )

  return (
    <div className="media-block" ref={blockRef}>
      {/* The card's head (CK-88; the mockup's .sect-head): the heading and
          the count of published photos, nothing when there are none or
          before the first read. The heading takes focus when the viewer
          closes with nowhere better to put it. */}
      <div className="sect-head photos-head">
        <h2 id="photos-heading" ref={headingRef} tabIndex={-1}>
          Photos
        </h2>
        {countLine !== '' && <span className="meta">{countLine}</span>}
      </div>

      {/* The line (CK-93; the mockup's .gline): who can see this group's
          gathering, until the chat is built to carry it (the record §6). */}
      {groupLine !== null && groupLine !== '' && <p className="gline">{groupLine}</p>}

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
            ref={allViewButton}
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
            ref={binViewButton}
            aria-pressed={binView}
            onClick={() => switchView('bin')}
          >
            Removed from this gathering
          </button>
        </div>
      )}

      {/* The upload form is the invited tier's (CK-80): none in the
          photos-only view, where the server refuses an intent. */}
      {canUpload && (
        <form ref={uploadForm} onSubmit={(event) => void upload(event)}>
          <label htmlFor="media-files">Add photos</label>
          <input
            id="media-files"
            ref={fileInput}
            type="file"
            multiple
            accept={PICKER_ACCEPT}
            aria-describedby={describedBy(errors, 'items')}
            onChange={(event) => {
              const chosen = Array.from(event.target.files ?? [])
              setFiles(chosen)
              setErrors(noErrors())
              // Chosen after the page's Add photos (point 12): focus is owed
              // to Upload once the button is enabled.
              if (pickedFromPage.current && chosen.length > 0) setFocusUploadOwed(true)
              pickedFromPage.current = false
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
          {/* The keeper's own "no room" refusal — and ONLY that one, by its
              stable code and never its wording — offers the way to more
              space beneath the server's message: it is their space (CK-74;
              paid-tiers record §12). The non-keeper form, the ceiling and
              every other refusal render exactly as before, with no link
              (CK-50's rule; keeping-explained moment 6 binds the rest). */}
          {errorType(errors, 'items') === KEEPER_SPACE_FULL && (
            <p className="field-hint">
              <Link to="/plan">Get more space</Link>
            </p>
          )}
          <button ref={uploadButton} type="submit" disabled={files.length === 0 || progress !== null}>
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
      )}

      {loadFailed && (
        <p className="form-error" role="alert">
          <span aria-hidden="true">⚠ </span>
          Photos couldn't be loaded just now.{' '}
          <button
            ref={tryAgainRef}
            type="button"
            className="link-button"
            onClick={() => {
              // Once the re-read lands, the heading; a second failure, the
              // new Try again (CK-95).
              owe({ kind: 'section' })
              setLoadFailed(false)
              setReloadKey((key) => key + 1)
            }}
          >
            Try again
          </button>
        </p>
      )}

      {allView && rowsList}

      {/* Search (CK-40): per gathering, by caption, tag or file name; the
          term goes as `q` after the debounce and the server narrows the
          list within what this caller may see. */}
      <div className="media-search">
        <label htmlFor="media-search">Find a photo</label>
        <input
          ref={searchRef}
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
          ref={batchForm}
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
            ref={batchSubmit}
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
              <button type="button" className="link-button" onClick={() => refresh()}>
                Refresh the list
              </button>{' '}
              and try again.
            </p>
          )}
          <FormLevelErrors errors={batchErrors} />
        </form>
      )}

      {!allView && rowsList}

      {shownTiles.length > 0 && (
        // THE GRID (point 13): a button per published photo, its thumbnail
        // layer and nothing else — the tiles carry no controls. A tile not
        // rendered mints nothing; one below the fold mints as it nears the
        // viewport.
        <ul className="pgrid">
          {shownTiles.map((item, position) => (
            <li key={item.id}>
              <button
                ref={(element) => keepRef(tileRefs.current, item.id, element)}
                type="button"
                className="ph"
                aria-label={`Photo ${position + 1} of ${gridItems.length} in ${gatheringTitle}`}
                onClick={(event) => openViewer('grid', item.id, event.currentTarget)}
              >
                <LazyThumbnail mediaId={item.id} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {offerSeeAll && (
        // See all (Steven's answer 2): the rest in place, focus to the first
        // tile it revealed.
        <div className="seeall">
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              setExpanded(true)
              setFocusTile(gridItems[previewLimit].id)
            }}
          >
            See all {gridItems.length} photos
          </button>
        </div>
      )}

      {items !== null && items.length === 0 && !loadFailed && !filtered && allView && (
        // The empty state is a real screen (CK-17): the control that fills
        // it is right above.
        <p className="field-hint">No photos yet.</p>
      )}

      {viewer !== null && !viewerLost && (
        <PhotoViewer
          photos={viewerPhotos}
          current={viewer.mediaId}
          onMove={moveViewer}
          single={viewer.mode === 'row'}
          setLabel={gatheringTitle}
          addedLine={(item) =>
            // The date where the dates are not withheld (the photos-only
            // view gives none), in the profile's zone, with its year.
            datesWithheld
              ? `Added by ${whoFor(item)}`
              : `Added by ${whoFor(item)} · ${formatDayWithYear(item.created_at, zone)}`
          }
          stateLine={(item) => mediaStateMessage(item, { isHost, organises, gatheringBin: binView })}
          acts={viewer.mode === 'grid' ? viewerActs : undefined}
          onClose={() => closeViewer()}
        />
      )}
    </div>
  )
}
