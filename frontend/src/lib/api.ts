import { clearToken, getToken } from './session'

export const API_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:8000').replace(/\/$/, '')

// The ToS version the sign-in form presents, recorded per account at
// creation. 1 = the CK-26 private test notice; 2 = the notice as revised at
// CK-73.3, true about what is stored; the published terms take 3. Bump only
// when the text behind /tos changes — a changed text is a NEW number, never
// a rewrite under the old one, and an existing version is never renumbered
// (decisions/2026-08-31-private-alpha-scope.md §3, §3.1).
export const TOS_VERSION = 2

export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_URL}${path}`, init)
}

export async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken()
  const headers = new Headers(init.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const response = await fetch(`${API_URL}${path}`, { ...init, headers })
  // A 401 means the server expired or revoked the session — drop the stored
  // token so auth state returns to signed-out instead of retry-looping.
  if (response.status === 401) clearToken()
  return response
}
