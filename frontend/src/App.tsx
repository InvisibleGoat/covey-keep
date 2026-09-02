import { Navigate, Route, Routes } from 'react-router-dom'
import './App.css'
import { PwaUpdatePrompt } from './components/PwaUpdatePrompt'
import { RequireAuth } from './components/RequireAuth'
import { AccountDeleted } from './routes/AccountDeleted'
import { AuthCallback } from './routes/AuthCallback'
import { EmailChangeResult } from './routes/EmailChangeResult'
import { GatheringDetail } from './routes/GatheringDetail'
import { GatheringNew } from './routes/GatheringNew'
import { Gatherings } from './routes/Gatherings'
import { Home } from './routes/Home'
import { InvitationAccept } from './routes/InvitationAccept'
import { Settings } from './routes/Settings'
import { SignIn } from './routes/SignIn'
import { Tos } from './routes/Tos'

function App() {
  return (
    <>
      <PwaUpdatePrompt />
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
          path="/gatherings"
          element={
            <RequireAuth>
              <Gatherings />
            </RequireAuth>
          }
        />
        <Route
          path="/gatherings/new"
          element={
            <RequireAuth>
              <GatheringNew />
            </RequireAuth>
          }
        />
        <Route
          path="/gatherings/:id"
          element={
            <RequireAuth>
              <GatheringDetail />
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
        {/* Deliberately NOT behind RequireAuth (CK-25): a signed-out invitee
            must see what they were invited to and where to sign in. */}
        <Route path="/invitations/accept" element={<InvitationAccept />} />
        <Route path="/tos" element={<Tos />} />
        <Route path="/email-change" element={<EmailChangeResult />} />
        <Route path="/account-deleted" element={<AccountDeleted />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  )
}

export default App
