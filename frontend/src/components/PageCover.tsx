import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  announceCoverChange,
  CHANGE_COVER,
  clearCover,
  COVER_GETTING_READY,
  COVER_REFUSED,
  COVER_UPLOADING,
  coverFailureLine,
  coverImageProgress,
  forgetCoverPicture,
  KEEP_IT,
  readCoverImage,
  REMOVE_COVER,
  REMOVE_UPLOADED_SENTENCE,
  UPLOAD_A_PICTURE,
  uploadCoverPicture,
  type CoverBody,
  type CoverFailure,
  type CoverSubject,
} from '../lib/covers'
import { PICKER_ACCEPT, POLL_INTERVAL_MS } from '../lib/media'
import { Cover } from './Cover'
import { useFocusRequest } from './useFocusRequest'

// A PAGE'S COVER CARD (CK-84): the cover at the top of a group's or a
// gathering's page, the page's <h1> over it, and — for the people who may
// set it — Change cover. `organises` is the page's own flag (`roleFlags` on
// a gathering's page, `groupRoleFlags` on a group's), read from the body's
// `caller_role` and nothing else; for anyone else the card is the picture
// and the heading, and no control the server would refuse.
//
// CHANGE COVER is a frosted pill at the card's top right, `aria-expanded`
// over an inline panel beneath the card — never a modal. The panel holds:
// - UPLOAD A PICTURE: a hidden file input (`accept` the photographs'
//   allowlist — the server stays the authority), one file, through
//   lib/covers.ts's three steps (intent, PUT, confirm) under *Uploading your
//   picture…*, then a read of the cover image every POLL_INTERVAL_MS under
//   *Getting it ready…* until it is `ready` — the page re-reads its subject
//   and the menu is told — or will not be, and the panel says why. THE OLD
//   COVER STAYS ON THE CARD UNTIL `ready`: the card draws the body's cover,
//   and the body changes only on that re-read. THE UPLOAD OUTLIVES THE PAGE:
//   the three steps run to the end after a navigation, so the cover still
//   lands; only the state updates are skipped, and the polling stops on
//   unmount (the cancel-on-unmount convention).
// - REMOVE COVER, only while a cover is set: a second step saying what
//   happens — an uploaded picture is deleted, a photograph stays in its
//   gathering — with Remove cover and Keep it. The card holds this step's
//   state. (Until CK-86 a group's page held it, as one of the page's steps
//   beside its members' — `removeStep`; those steps moved to the People
//   page, and the cover's is the only step left on the group's page.)
// - The hint: the way to a cover from a photograph, in the page's words.
//
// FOCUS AFTER AN ANSWER (CK-95; the components doc's Focus after an answer):
// Upload a picture is disabled while its upload runs, so when the picture is
// ready, has failed or was refused, focus goes back to it; Remove cover's step
// takes focus as it opens — a group labelled by its sentence, never its Remove
// cover — Keep it and a refusal put focus back on the opener, and a removal,
// once the re-read has taken Remove cover away, goes to Upload a picture.
// Every move only from the body or from inside the panel, so a person who
// moved elsewhere while it waited keeps their place.
//
// The card is the cover's `wide` variant, the mockup's measure
// (components/Cover.tsx) — a group's page since CK-86, a gathering's since
// CK-87. (A `variant` prop chose between it and the old column-width `card`
// until CK-87 retired that one; with one left, the prop went too.) `badge`:
// the date badge on the picture's corner — a gathering's page passes it in
// the full view while a date is still ahead (CK-87).
export function PageCover({
  subject,
  id,
  cover,
  badge,
  organises,
  hint,
  photoRemovalSentence,
  onChanged,
  pollIntervalMs = POLL_INTERVAL_MS,
  children,
}: {
  subject: CoverSubject
  id: string
  cover: CoverBody | null | undefined
  badge?: ReactNode
  organises: boolean
  hint: string
  // Remove cover's sentence when the cover is a photograph: the gathering's
  // title on a gathering's page, "its gathering" on a group's (no group body
  // names the photograph or where it came from).
  photoRemovalSentence: string
  // The page re-reads its subject: a cover act landed.
  onChanged: () => void
  // Overridable for tests only; the product uses the one constant.
  pollIntervalMs?: number
  children: ReactNode
}) {
  const panelId = useId()
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<
    | { state: 'idle' }
    | { state: 'uploading' }
    | { state: 'preparing'; coverImageId: string }
    | { state: 'failed'; code: CoverFailure }
  >({ state: 'idle' })
  const [removeOpen, setRemoveOpen] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const uploadRef = useRef<HTMLButtonElement>(null)
  const removeOpenerRef = useRef<HTMLButtonElement>(null)
  const removeStepRef = useRef<HTMLDivElement>(null)
  const removeSentence = useId()
  const focusInPanel = useFocusRequest(panelRef)
  // A removal landed: focus is owed to Upload a picture once the re-read has
  // taken the cover, and Remove cover with it, away.
  const removedOwed = useRef(false)

  // Cancel-on-unmount for the handlers (the CK-18 convention).
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // The page's callback, read when it is needed — pages pass a fresh arrow
  // on every render, and the polling must not restart on each one.
  const onChangedRef = useRef(onChanged)
  useEffect(() => {
    onChangedRef.current = onChanged
  })

  // Following the upload to `ready`: one read per interval, stopped on
  // unmount and whenever the phase moves on.
  const preparingId = phase.state === 'preparing' ? phase.coverImageId : null
  useEffect(() => {
    if (preparingId === null) return
    const coverImageId = preparingId
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    function schedule() {
      timer = setTimeout(() => void tick(), pollIntervalMs)
    }
    async function tick() {
      const progress = coverImageProgress(await readCoverImage(coverImageId))
      if (cancelled) return
      if (progress.state === 'preparing') {
        schedule()
        return
      }
      if (progress.state === 'ready') {
        setPhase({ state: 'idle' })
        focusInPanel(uploadRef)
        onChangedRef.current()
        announceCoverChange()
        return
      }
      setPhase({ state: 'failed', code: progress.code })
      focusInPanel(uploadRef)
    }
    schedule()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [preparingId, pollIntervalMs, focusInPanel])

  const busy = phase.state === 'uploading' || phase.state === 'preparing'
  const coverSet = cover !== null && cover !== undefined

  useEffect(() => {
    if (!removedOwed.current || coverSet) return
    removedOwed.current = false
    focusInPanel(uploadRef)
  }, [coverSet, focusInPanel])

  function togglePanel() {
    if (open && removeOpen) setRemoveOpen(false)
    setOpen(!open)
  }

  async function upload(file: File) {
    setRefusal(null)
    if (removeOpen) setRemoveOpen(false)
    setPhase({ state: 'uploading' })
    const outcome = await uploadCoverPicture(subject, id, file)
    if (!alive.current) return
    setPhase(
      outcome.ok
        ? { state: 'preparing', coverImageId: outcome.coverImageId }
        : { state: 'failed', code: outcome.code },
    )
    if (!outcome.ok) focusInPanel(uploadRef)
  }

  async function remove() {
    setRemoving(true)
    setRefusal(null)
    const outcome = await clearCover(subject, id)
    if (!alive.current) return
    setRemoving(false)
    setRemoveOpen(false)
    if (outcome.ok) {
      forgetCoverPicture(subject, id)
      removedOwed.current = true
      onChangedRef.current()
      announceCoverChange()
      return
    }
    setRefusal(COVER_REFUSED)
    focusInPanel(removeOpenerRef)
  }

  const action = organises ? (
    <button
      type="button"
      className="cover-change"
      aria-expanded={open}
      aria-controls={panelId}
      onClick={togglePanel}
    >
      {CHANGE_COVER}
    </button>
  ) : undefined

  return (
    <>
      <Cover subject={subject} id={id} cover={cover} variant="wide" action={action} badge={badge}>
        {children}
      </Cover>
      {organises && (
        <div id={panelId} ref={panelRef} className="auth-card cover-panel" hidden={!open}>
          {open && (
            <>
              <input
                ref={fileInput}
                type="file"
                accept={PICKER_ACCEPT}
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  // Cleared, so the same file can be chosen again after a refusal.
                  event.target.value = ''
                  if (file) void upload(file)
                }}
              />
              <button ref={uploadRef} type="button" disabled={busy} onClick={() => fileInput.current?.click()}>
                {UPLOAD_A_PICTURE}
              </button>
              <p className="field-hint cover-status" role="status">
                {phase.state === 'uploading' && COVER_UPLOADING}
                {phase.state === 'preparing' && COVER_GETTING_READY}
              </p>
              {phase.state === 'failed' && (
                <p className="form-error" role="alert">
                  {coverFailureLine(phase.code)}
                </p>
              )}
              {coverSet &&
                (removeOpen ? (
                  // The second, deliberate step: the first click only asked,
                  // and Keep it does nothing.
                  <div ref={removeStepRef} role="group" aria-labelledby={removeSentence} tabIndex={-1}>
                    <p className="field-hint" id={removeSentence}>
                      {cover?.source === 'photo' ? photoRemovalSentence : REMOVE_UPLOADED_SENTENCE}
                    </p>
                    <button type="button" disabled={removing} onClick={() => void remove()}>
                      {removing ? 'Removing…' : REMOVE_COVER}
                    </button>{' '}
                    <button
                      type="button"
                      className="link-button"
                      disabled={removing}
                      onClick={() => {
                        setRemoveOpen(false)
                        focusInPanel(removeOpenerRef)
                      }}
                    >
                      {KEEP_IT}
                    </button>
                  </div>
                ) : (
                  <button
                    ref={removeOpenerRef}
                    type="button"
                    onClick={() => {
                      setRefusal(null)
                      setRemoveOpen(true)
                      focusInPanel(removeStepRef)
                    }}
                  >
                    {REMOVE_COVER}
                  </button>
                ))}
              {refusal && (
                <p className="form-error" role="alert">
                  {refusal}
                </p>
              )}
              <p className="field-hint">{hint}</p>
            </>
          )}
        </div>
      )}
    </>
  )
}
