// /groups/new — start a group (CK-78, Groups 3a; `POST /groups`). ONE
// field, the name. NO TYPE CONTROL: the API accepts HOUSEHOLD alone (the
// rung-2 gate) and refuses every other type, and offering a control the
// API rejects is worse than none (the CK-18 lesson) — so `group_type` is
// never sent. The button waits for a non-blank character (presence only,
// the "can plausibly succeed" idiom); every other rule — blank after
// trimming, over-long — is the server's, and its 422 lands on the field
// through the one mapper. A 201 lands on the new group's page.
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { FieldError, FormLevelErrors } from '../components/FieldError'
import { describedBy, noErrors, type FormErrors } from '../lib/formErrors'
import { createGroup } from '../lib/groups'

export function GroupNew() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errors, setErrors] = useState<FormErrors>(noErrors())

  // Cancel-on-unmount for the submit handler (the CK-18 convention).
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setErrors(noErrors())
    const outcome = await createGroup(name)
    if (!alive.current) return
    if (outcome.ok) {
      navigate(`/groups/${outcome.group.id}`)
      return
    }
    setErrors(outcome.errors)
    setSubmitting(false)
  }

  return (
    <main className="auth-screen">
      <h1>Start a group</h1>

      <form className="auth-card" onSubmit={(event) => void handleSubmit(event)}>
        <label htmlFor="group-name">Name</label>
        <input
          id="group-name"
          type="text"
          maxLength={200}
          value={name}
          aria-describedby={describedBy(errors, 'name')}
          onChange={(event) => setName(event.target.value)}
        />
        <p className="field-hint">Most groups are named for a family — the Hawkins Family, the Lees.</p>
        <FieldError errors={errors} field="name" />

        <button type="submit" disabled={name.trim() === '' || submitting}>
          {submitting ? 'Starting…' : 'Start group'}
        </button>
        <FormLevelErrors errors={errors} />
      </form>

      <Link to="/groups">Back to your groups</Link>
    </main>
  )
}
