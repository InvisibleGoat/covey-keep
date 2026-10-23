import { Route, Routes } from 'react-router-dom'
import './App.css'
import { AppUpdateProvider } from './components/AppUpdateProvider'
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
import { PageNotAvailable } from './routes/PageNotAvailable'
import { Plan } from './routes/Plan'
import { Settings } from './routes/Settings'
import { SignIn } from './routes/SignIn'
import { Tos } from './routes/Tos'

function App() {
  return (
    <AppUpdateProvider>
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
        {/* The path is fixed by the backend's return URLs (CK-74): Checkout
            returns to /plan?checkout=complete|cancelled, the portal to /plan. */}
        <Route
          path="/plan"
          element={
            <RequireAuth>
              <Plan />
            </RequireAuth>
          }
        />
        {/* Deliberately NOT behind RequireAuth (CK-25): a signed-out invitee
            must see what they were invited to and where to sign in. */}
        <Route path="/invitations/accept" element={<InvitationAccept />} />
        <Route path="/tos" element={<Tos />} />
        <Route path="/email-change" element={<EmailChangeResult />} />
        <Route path="/account-deleted" element={<AccountDeleted />} />
        {/* The catch-all NEVER navigates (CK-75.1): it renders a screen and
            keeps the address — path, query and fragment — exactly as it
            arrived, asks the service worker for an update, and offers a
            reload when a newer version is waiting. Until CK-75.1 this was
            `<Navigate to="/" replace />`, which discarded the address, a
            fragment-carried token included (CK-75's finding 1). */}
        <Route path="*" element={<PageNotAvailable />} />
      </Routes>
    </AppUpdateProvider>
  )
}

export default App
