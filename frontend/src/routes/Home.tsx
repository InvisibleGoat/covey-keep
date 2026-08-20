import { Link } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'

export function Home() {
  const { person, signOut } = useAuth()
  return (
    <main className="auth-screen">
      <h1>{person ? `Welcome, ${person.display_name}` : 'Welcome'}</h1>
      {!person && <p>You're signed in, but your profile couldn't be loaded just now.</p>}
      <p>Your gatherings will live here.</p>
      <Link to="/settings">Settings</Link>
      <button type="button" onClick={() => void signOut()}>
        Sign out
      </button>
    </main>
  )
}
