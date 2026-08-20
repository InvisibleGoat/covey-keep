import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth()
  if (status === 'loading') {
    return (
      <main className="auth-screen">
        <p>Signing you in…</p>
      </main>
    )
  }
  if (status === 'signedOut') return <Navigate to="/" replace />
  return <>{children}</>
}
