// Inviting people outside the group, on the surface (CK-93 — the screens for
// CK-92's backend; decisions/2026-10-04-a-groups-gathering-stays-in-the-group.md
// §5, §7, §11 items 7–11; Steven's answers of 2026-11-10 and 2026-11-12).
// Two pieces of a group's gathering's page, each reading only what the page
// hands it — the body decides who sees either (lib/outsideInvitations.ts's
// `outsideFlags`), never this file:
//
// THE CARD (`OutsideInvitationsCard`), for everyone the body says
// `may_change`: the heading *Invite people outside {group}* and a switch it
// names, the two second steps, and — handed in by the page, for the
// gathering's organisers while it is on — the email form and *Waiting on*.
// THE SWITCH NEVER MOVES BEFORE THE SERVER HAS ANSWERED: `aria-checked` is
// the `on` the page holds, and a press only asks. Off, a press opens the
// turn-on step (always — it is never skipped). On, a press reads the preview
// first, and asks only when turning it off would name someone or stop an
// invitation (Steven's answer 3); with nobody from outside and nothing
// pending it turns off in one press. Nothing is turned off without a
// preview. A step takes focus itself, labelled by its sentence, so a screen
// reader reads it and a second key press confirms nothing; leaving it gives
// focus back to the switch, as a landed change does.
//
// THE ALERT (`OutsideAlert`), for whoever the body says `outside_alert`:
// the approved sentence and Got it, which posts the dismissal once. No live
// role: it is on the page when the page loads, not a change. Nothing is
// stored on the device — the server keeps the dismissal.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { GatheringWithOccurrences } from '../lib/gatherings'
import {
  ALERT_FAILED,
  CHANGE_FAILED,
  dismissOutsideAlert,
  GOT_IT,
  KEEP_IT_ON,
  NOT_ALLOWED,
  NOT_NOW,
  PREVIEW_FAILED,
  readOutsideInvitations,
  REFRESH,
  setOutsideInvitations,
  switchLabel,
  TRY_AGAIN,
  TURN_IT_OFF,
  TURN_IT_ON,
  TURNING_IT_OFF,
  TURNING_IT_ON,
  turnOffNeedsStep,
  turnOffSentence,
  turnOnSentence,
  type OutsidePreview,
} from '../lib/outsideInvitations'

type Phase = 'idle' | 'confirmOn' | 'turningOn' | 'previewing' | 'confirmOff' | 'turningOff'
type Problem = null | 'preview' | 'notAllowed' | 'failed'

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p className="form-error" role="alert">
      <span aria-hidden="true">⚠ </span>
      {children}
    </p>
  )
}

export function OutsideInvitationsCard({
  gatheringId,
  groupName,
  on,
  notice,
  onLanded,
  onRefresh,
  children,
}: {
  gatheringId: string
  groupName: string
  // The setting as the page holds it — the body's, never a press.
  on: boolean
  // A refusal the page met elsewhere in the card (the email form's 409
  // `members_only`), shown beneath the switch.
  notice: string | null
  // A change landed: the returned body replaces the page's; a turn-off
  // reads the roster again.
  onLanded: (gathering: GatheringWithOccurrences, turnedOff: boolean) => void
  // Re-read the gathering (Refresh; a preview that says it is already off).
  onRefresh: () => void
  // The email form and *Waiting on*, the page's, for its organisers while on.
  children?: ReactNode
}) {
  const headingId = useId()
  const sentenceId = useId()
  const [phase, setPhase] = useState<Phase>('idle')
  const [preview, setPreview] = useState<OutsidePreview | null>(null)
  const [problem, setProblem] = useState<Problem>(null)
  const switchRef = useRef<HTMLButtonElement>(null)
  const stepRef = useRef<HTMLDivElement>(null)
  // Where focus goes once the next render is on screen: the step that just
  // opened, or the switch after a step closes or a change lands.
  const focusNext = useRef<'step' | 'switch' | null>(null)

  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    const target = focusNext.current
    if (target === null) return
    focusNext.current = null
    ;(target === 'step' ? stepRef.current : switchRef.current)?.focus()
  })

  const turnOnStep = phase === 'confirmOn' || phase === 'turningOn'
  const turnOffStep = preview !== null && (phase === 'confirmOff' || phase === 'turningOff')
  const busy = phase === 'turningOn' || phase === 'previewing' || phase === 'turningOff'

  function close() {
    focusNext.current = 'switch'
    setPhase('idle')
    setPreview(null)
    setProblem(null)
  }

  async function turn(value: boolean, fromStep: boolean) {
    setProblem(null)
    setPhase(value ? 'turningOn' : 'turningOff')
    const outcome = await setOutsideInvitations(gatheringId, value)
    if (!alive.current) return
    if (outcome.ok) {
      focusNext.current = 'switch'
      setPhase('idle')
      setPreview(null)
      onLanded(outcome.gathering, !value)
      return
    }
    if (outcome.code === 'not_found') {
      setPhase('idle')
      setPreview(null)
      setProblem('notAllowed')
      return
    }
    // The switch stays as it was; a step stays open to try again.
    setProblem('failed')
    setPhase(fromStep ? (value ? 'confirmOn' : 'confirmOff') : 'idle')
  }

  async function checkPreview() {
    setProblem(null)
    setPhase('previewing')
    const outcome = await readOutsideInvitations(gatheringId)
    if (!alive.current) return
    if (!outcome.ok) {
      setPhase('idle')
      setProblem(outcome.code === 'not_found' ? 'notAllowed' : 'preview')
      return
    }
    if (!outcome.preview.on) {
      // Someone else turned it off meanwhile: re-read, post nothing.
      setPhase('idle')
      onRefresh()
      return
    }
    if (!turnOffNeedsStep(outcome.preview)) {
      await turn(false, false)
      return
    }
    focusNext.current = 'step'
    setPreview(outcome.preview)
    setPhase('confirmOff')
  }

  function press() {
    if (busy) return
    // A second press with a step open leaves it, as its quiet button does:
    // the switch has not moved, so pressing it again confirms nothing.
    if (turnOnStep || turnOffStep) {
      close()
      return
    }
    setProblem(null)
    if (!on) {
      focusNext.current = 'step'
      setPhase('confirmOn')
      return
    }
    void checkPreview()
  }

  return (
    <section className="auth-card outside-card" aria-labelledby={headingId}>
      <div className="switch-row">
        <h2 id={headingId}>{switchLabel(groupName)}</h2>
        <button
          ref={switchRef}
          type="button"
          role="switch"
          className="ck-switch"
          aria-checked={on}
          aria-labelledby={headingId}
          aria-busy={busy && !turnOnStep && !turnOffStep ? true : undefined}
          disabled={busy}
          onClick={press}
        >
          <span className="ck-switch-track" aria-hidden="true">
            <span className="ck-switch-thumb" />
          </span>
        </button>
      </div>

      {turnOnStep && (
        <div ref={stepRef} className="outside-step" role="group" aria-labelledby={sentenceId} tabIndex={-1}>
          <p id={sentenceId}>{turnOnSentence(groupName)}</p>
          <div className="outside-step-actions">
            <button
              type="button"
              className="btn-primary"
              disabled={phase === 'turningOn'}
              onClick={() => void turn(true, true)}
            >
              {phase === 'turningOn' ? TURNING_IT_ON : TURN_IT_ON}
            </button>
            <button type="button" disabled={phase === 'turningOn'} onClick={close}>
              {NOT_NOW}
            </button>
          </div>
        </div>
      )}

      {turnOffStep && preview !== null && (
        <div ref={stepRef} className="outside-step" role="group" aria-labelledby={sentenceId} tabIndex={-1}>
          <p id={sentenceId}>{turnOffSentence(preview)}</p>
          <div className="outside-step-actions">
            <button
              type="button"
              className="danger-button"
              disabled={phase === 'turningOff'}
              onClick={() => void turn(false, true)}
            >
              {phase === 'turningOff' ? TURNING_IT_OFF : TURN_IT_OFF}
            </button>
            <button type="button" disabled={phase === 'turningOff'} onClick={close}>
              {KEEP_IT_ON}
            </button>
          </div>
        </div>
      )}

      {problem === 'preview' && (
        <>
          <ErrorLine>{PREVIEW_FAILED}</ErrorLine>
          <button type="button" onClick={() => void checkPreview()}>
            {TRY_AGAIN}
          </button>
        </>
      )}
      {problem === 'notAllowed' && (
        <>
          <ErrorLine>{NOT_ALLOWED}</ErrorLine>
          <button
            type="button"
            onClick={() => {
              setProblem(null)
              onRefresh()
            }}
          >
            {REFRESH}
          </button>
        </>
      )}
      {problem === 'failed' && <ErrorLine>{CHANGE_FAILED}</ErrorLine>}
      {notice !== null && <ErrorLine>{notice}</ErrorLine>}

      {children}
    </section>
  )
}

export function OutsideAlert({
  gatheringId,
  sentence,
  onDismissed,
}: {
  gatheringId: string
  sentence: string
  // The 204 landed: the page sets `outside_alert` false on the body it holds
  // (nothing re-read) and moves focus to its <h1>.
  onDismissed: () => void
}) {
  const [acting, setActing] = useState(false)
  const [failed, setFailed] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  async function dismiss() {
    if (acting) return
    setActing(true)
    setFailed(false)
    const outcome = await dismissOutsideAlert(gatheringId)
    if (!alive.current) return
    setActing(false)
    if (outcome.ok) {
      onDismissed()
      return
    }
    setFailed(true)
  }

  return (
    <div className="auth-card outside-alert">
      <p>{sentence}</p>
      <div className="outside-alert-actions">
        <button type="button" disabled={acting} onClick={() => void dismiss()}>
          {GOT_IT}
        </button>
        {failed && <ErrorLine>{ALERT_FAILED}</ErrorLine>}
      </div>
    </div>
  )
}
