// Passkeys (CK-10). The SECURITY path, not the accessibility path (docs root,
// decisions/2026-08-20-sign-in-ergonomics.md §4): a second credential so one
// email-provider outage can't lock everyone out at once. Nothing that imports
// from here may present passkeys as the easier or recommended option, and
// email sign-in is never gated behind one.
//
// @simplewebauthn/browser is the library exception mirroring py_webauthn on
// the backend (see backend/requirements.txt for the reasoning) — it drives the
// browser's WebAuthn ceremonies and does the JSON<->ArrayBuffer plumbing.

import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser'
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser'
import { apiFetch, authFetch } from './api'

export interface Passkey {
  id: string
  nickname: string | null
  backup_eligible: boolean | null
  created_at: string
  last_used_at: string | null
}

export { browserSupportsWebAuthn }

// The person closed or dismissed the browser's passkey prompt — a choice, not
// a failure, so callers stay silent on it.
export function isCeremonyCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === 'NotAllowedError'
}

export async function listPasskeys(): Promise<Passkey[]> {
  const response = await authFetch('/me/passkeys')
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return ((await response.json()) as { passkeys: Passkey[] }).passkeys
}

export async function addPasskey(nickname: string): Promise<Passkey> {
  const begin = await authFetch('/me/passkeys/register/begin', { method: 'POST' })
  if (!begin.ok) throw new Error(`HTTP ${begin.status}`)
  const optionsJSON = (await begin.json()) as PublicKeyCredentialCreationOptionsJSON
  const credential = await startRegistration({ optionsJSON })
  const complete = await authFetch('/me/passkeys/register/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential, nickname: nickname.trim() || null }),
  })
  if (!complete.ok) throw new Error(`HTTP ${complete.status}`)
  return (await complete.json()) as Passkey
}

export async function removePasskey(id: string): Promise<void> {
  const response = await authFetch(`/me/passkeys/${id}`, { method: 'DELETE' })
  if (response.status !== 204) throw new Error(`HTTP ${response.status}`)
}

// Usernameless, deliberately: no address is sent at any point — the browser
// offers whatever discoverable credentials it holds for this domain, so there
// is nothing for an enumeration probe to learn. Returns the session JWT.
export async function signInWithPasskey(): Promise<string> {
  const begin = await apiFetch('/auth/passkey/begin', { method: 'POST' })
  if (!begin.ok) throw new Error(`HTTP ${begin.status}`)
  const optionsJSON = (await begin.json()) as PublicKeyCredentialRequestOptionsJSON
  const credential = await startAuthentication({ optionsJSON })
  const complete = await apiFetch('/auth/passkey/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential }),
  })
  if (!complete.ok) throw new Error(`HTTP ${complete.status}`)
  return ((await complete.json()) as { token: string }).token
}
