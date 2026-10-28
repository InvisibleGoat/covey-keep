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
import { GroupDetail } from './routes/GroupDetail'
import { GroupInvitationAccept } from './routes/GroupInvitationAccept'
import { GroupJoin } from './routes/GroupJoin'
import { GroupNew } from './routes/GroupNew'
import { Groups } from './routes/Groups'
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
        {/* Your groups (CK-78, Groups 3a). `/groups/new` sits before
            `/groups/:id` so it reads as the static route it is. */}
        <Route
          path="/groups"
          element={
            <RequireAuth>
              <Groups />
            </RequireAuth>
          }
        />
        <Route
          path="/groups/new"
          element={
            <RequireAuth>
              <GroupNew />
            </RequireAuth>
          }
        />
        {/* The two landings the backend's URLs point at (CK-79, Groups 3b):
            the group's link (`/groups/join#token=…`) and the emailed group
            invitation (`/groups/invitations/accept#token=…`). Deliberately
            NOT behind RequireAuth — a signed-out holder must see what the
            link is for and how to sign in, and RequireAuth would send them to
            `/` without the fragment, the token with it (CK-75's finding 1).
            Both sit before `/groups/:id`; the static `/groups/join` segment
            outranks the dynamic one, which until CK-79 a static row
            rendering the catch-all held for it. */}
        <Route path="/groups/join" element={<GroupJoin />} />
        <Route path="/groups/invitations/accept" element={<GroupInvitationAccept />} />
        <Route
          path="/groups/:id"
          element={
            <RequireAuth>
              <GroupDetail />
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
