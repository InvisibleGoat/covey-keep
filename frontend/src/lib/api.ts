import { clearToken, getToken } from './session'

export const API_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:8000').replace(/\/$/, '')

// The ToS version the sign-in form presents. Bump only when the published
// terms actually change — the accepted version is recorded per account.
export const TOS_VERSION = 1

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
