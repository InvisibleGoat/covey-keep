import { Link } from 'react-router-dom'
import { PRODUCT_NAME } from '../brand'

// Placeholder only. The real terms are their own pass with a legal-review
// gate, and must land before anyone outside the first household signs up.
export function Tos() {
  return (
    <main className="auth-screen">
      <h1>Terms of Service</h1>
      <p>The Terms of Service are still being written and will appear here before {PRODUCT_NAME} opens beyond its first household.</p>
      <Link to="/">Back to sign-in</Link>
    </main>
  )
}
