import { Link } from 'react-router-dom'

// Deliberately unguarded: the person landing here has no session any more.
// A plain confirmation, not the sign-in form with no explanation (CK-8).
export function AccountDeleted() {
  return (
    <main className="auth-screen">
      <h1>Your account is deleted</h1>
      <p>Your name and sign-in details are gone. What you contributed stays with the gatherings you gave it to.</p>
      <p>You're welcome back any time — signing up again starts a fresh account, not a way back into this one.</p>
      <Link to="/">Back to sign in</Link>
    </main>
  )
}
