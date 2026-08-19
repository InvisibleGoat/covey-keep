import { useEffect, useState } from 'react'
import './App.css'

const API_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:8000').replace(/\/$/, '')

function App() {
  const [apiStatus, setApiStatus] = useState('checking…')

  useEffect(() => {
    let cancelled = false
    fetch(`${API_URL}/health`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: { status?: string }) => {
        if (!cancelled) setApiStatus(body.status === 'ok' ? 'ok' : 'unexpected response')
      })
      .catch(() => {
        if (!cancelled) setApiStatus('unreachable')
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <main className="placeholder">
      <h1>Covey Keep</h1>
      <p>Plan the gathering. Keep the day.</p>
      <p className="api-status">API: {apiStatus}</p>
    </main>
  )
}

export default App
