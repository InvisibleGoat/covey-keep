import { useEffect, useRef, useState } from 'react'
import {
  addPasskey,
  browserSupportsWebAuthn,
  isCeremonyCancelled,
  listPasskeys,
  removePasskey,
  type Passkey,
} from '../lib/passkeys'
import { useFocusRequest, useRefMap } from './useFocusRequest'

// Quiet by default (CK-10): this section exists in settings and nowhere else —
// no prompt, no suggestion, no banner — until the custom domain is final,
// because a passkey is bound to its domain and would not survive the move.
// And the copy must never present passkeys as the easier or recommended
// option: they are the faster, phishing-resistant path for people who already
// know what they are (sign-in-ergonomics decision §4). The 6-digit codes and
// SMS that serve the wider audience are CK-11 and CK-12.

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export function PasskeySection() {
  // Feature detection, once: where WebAuthn is unavailable the add control is
  // hidden entirely rather than rendered as a button that errors.
  const [supported] = useState(() => browserSupportsWebAuthn())
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [nickname, setNickname] = useState('')
  const [busy, setBusy] = useState<'idle' | 'adding' | 'removing'>('idle')
  const [error, setError] = useState<string | null>(null)

  // Focus after an answer (CK-94): the section is the container; Add a
  // passkey after any answer to it, and after a removal the next passkey's
  // Remove, else Add a passkey, else (no WebAuthn here) the heading.
  const section = useRef<HTMLElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const removeButtons = useRefMap<string>()
  const requestFocus = useFocusRequest(section)

  useEffect(() => {
    let cancelled = false
    listPasskeys()
      .then((loaded) => {
        if (!cancelled) setPasskeys(loaded)
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleAdd() {
    setError(null)
    setBusy('adding')
    try {
      const added = await addPasskey(nickname)
      setPasskeys((current) => [...(current ?? []), added])
      setNickname('')
    } catch (err) {
      if (!isCeremonyCancelled(err)) {
        setError(
          err instanceof Error && err.message === 'HTTP 409'
            ? 'That passkey is already on your account.'
            : "Something went wrong adding the passkey. It wasn't saved — try again.",
        )
      }
    }
    setBusy('idle')
    requestFocus(addButton)
  }

  async function handleRemove(id: string) {
    setError(null)
    setBusy('removing')
    try {
      await removePasskey(id)
      setPasskeys((current) => (current ?? []).filter((p) => p.id !== id))
      const list = passkeys ?? []
      const next = list[list.findIndex((p) => p.id === id) + 1]
      requestFocus(() =>
        next ? removeButtons.get(next.id) : (addButton.current ?? heading.current),
      )
    } catch {
      setError('Something went wrong removing the passkey. Try again.')
      requestFocus(() => removeButtons.get(id))
    }
    setBusy('idle')
  }

  return (
    <section ref={section} className="auth-card" aria-labelledby="passkeys-heading">
      <h2 ref={heading} id="passkeys-heading" tabIndex={-1}>
        Passkeys
      </h2>
      <p className="field-hint">
        If you already use passkeys, you can add one to sign in with this device's screen
        lock or PIN. Signing in by emailed link keeps working either way.
      </p>

      {loadFailed && (
        <p className="form-error">Your passkeys couldn't be loaded just now.</p>
      )}
      {passkeys && passkeys.length === 0 && (
        <p className="field-hint">No passkeys on this account.</p>
      )}
      {passkeys &&
        passkeys.map((passkey) => (
          <div key={passkey.id} className="passkey-row">
            <div>
              <p>{passkey.nickname ?? 'Passkey'}</p>
              <p className="field-hint">
                Added {formatDay(passkey.created_at)}
                {passkey.last_used_at
                  ? ` · last used ${formatDay(passkey.last_used_at)}`
                  : ' · never used'}
              </p>
            </div>
            {/* Removing the last passkey needs no ceremony: email sign-in is
                always available, so there is no lockout to protect against. */}
            <button
              ref={removeButtons.register(passkey.id)}
              type="button"
              onClick={() => void handleRemove(passkey.id)}
              disabled={busy !== 'idle'}
            >
              Remove
            </button>
          </div>
        ))}

      {supported ? (
        <>
          <label htmlFor="passkey-nickname">Name this passkey (optional)</label>
          <input
            id="passkey-nickname"
            type="text"
            maxLength={60}
            autoComplete="off"
            placeholder="e.g. My phone"
            value={nickname}
            onChange={(event) => {
              setNickname(event.target.value)
              setError(null)
            }}
          />
          <button
            ref={addButton}
            type="button"
            onClick={() => void handleAdd()}
            disabled={busy !== 'idle' || passkeys === null}
          >
            {busy === 'adding' ? 'Waiting for your device…' : 'Add a passkey'}
          </button>
        </>
      ) : (
        <p className="field-hint">This browser doesn't support adding passkeys.</p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
