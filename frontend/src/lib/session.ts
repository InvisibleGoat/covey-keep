// Browser session storage. localStorage is deliberate: the session must
// survive a browser restart (the 30-day trusted-device promise), and an
// httpOnly cookie is not viable while the frontend (*.netlify.app) and API
// (*.onrender.com) are cross-site — revisit at the prod cutover phase
// (decisions/2026-08-20-browser-session-storage.md in the docs root).

const STORAGE_KEY = 'covey-keep:session-token'

type Listener = () => void

const listeners = new Set<Listener>()

function notify(): void {
  for (const listener of listeners) listener()
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, token)
  } catch {
    // Storage unavailable (private mode): the session lasts until the tab closes.
  }
  notify()
}

export function clearToken(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Nothing stored to clear.
  }
  notify()
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
