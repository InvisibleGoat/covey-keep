import { Navigate, Route, Routes } from 'react-router-dom'
import './App.css'
import { RequireAuth } from './components/RequireAuth'
import { AuthCallback } from './routes/AuthCallback'
import { Home } from './routes/Home'
import { Settings } from './routes/Settings'
import { SignIn } from './routes/SignIn'
import { Tos } from './routes/Tos'

function App() {
  return (
    <Routes>
      <Route path="/" element={<SignIn />} />
      <Route path="/auth/callback" element={<AuthCallback />} />
      <Route
        path="/home"
        element={
          <RequireAuth>
            <Home />
          </RequireAuth>
        }
      />
      <Route
        path="/settings"
        element={
          <RequireAuth>
            <Settings />
          </RequireAuth>
        }
      />
      <Route path="/tos" element={<Tos />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
