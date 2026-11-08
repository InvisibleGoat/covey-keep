import { Navigate, Route, Routes } from 'react-router-dom'
import './App.css'
import { AppUpdateProvider } from './components/AppUpdateProvider'
import { Frame } from './components/Frame'
import { PwaUpdatePrompt } from './components/PwaUpdatePrompt'
import { RequireAuth } from './components/RequireAuth'
import { AccountDeleted } from './routes/AccountDeleted'
import { AuthCallback } from './routes/AuthCallback'
import { Calendar } from './routes/Calendar'
import { EmailChangeResult } from './routes/EmailChangeResult'
import { GatheringDetail } from './routes/GatheringDetail'
import { GatheringNew } from './routes/GatheringNew'
import { Gatherings } from './routes/Gatherings'
import { GroupDetail } from './routes/GroupDetail'
import { GroupGatheringNew } from './routes/GroupGatheringNew'
import { GroupInvitationAccept } from './routes/GroupInvitationAccept'
import { GroupJoin } from './routes/GroupJoin'
import { GroupNew } from './routes/GroupNew'
import { GroupPeople } from './routes/GroupPeople'
import { Groups } from './routes/Groups'
import { InvitationAccept } from './routes/InvitationAccept'
import { PageNotAvailable } from './routes/PageNotAvailable'
import { Plan } from './routes/Plan'
import { Settings } from './routes/Settings'
import { SignIn } from './routes/SignIn'
import { Tos } from './routes/Tos'
import { You } from './routes/You'

function App() {
  return (
    <AppUpdateProvider>
      <PwaUpdatePrompt />
      <Routes>
        <Route path="/" element={<SignIn />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
        {/* Every signed-in page, under ONE layout route (CK-82): RequireAuth
            around the frame — the menu, the top and bottom bars — which
            renders the page through its <Outlet />. RequireAuth's behaviour
            is unchanged: a signed-out visit to any of these parks its
            `pathname + search` and goes to `/` (the sign-in return). Each
            page keeps its own <main>. */}
        <Route
          element={
            <RequireAuth>
              <Frame />
            </RequireAuth>
          }
        >
          {/* Home is retired (CK-82; the merge record §1.4): sign-in lands
              on Groups, and an old link or bookmark to /home forwards there.
              Inside the layout, so a signed-out visit parks /home as any
              gated page does. */}
          <Route path="/home" element={<Navigate to="/groups" replace />} />
          <Route path="/gatherings" element={<Gatherings />} />
          <Route path="/gatherings/new" element={<GatheringNew />} />
          <Route path="/gatherings/:id" element={<GatheringDetail />} />
          {/* Your groups (CK-78, Groups 3a). */}
          <Route path="/groups" element={<Groups />} />
          <Route path="/groups/new" element={<GroupNew />} />
          <Route path="/groups/:id" element={<GroupDetail />} />
          {/* A group's People page (CK-86; the merge record §1.3): Members,
              Requests to join, Invite people, rename and Leave, moved from
              the group's page, which reaches it through its People button. */}
          <Route path="/groups/:id/people" element={<GroupPeople />} />
          {/* A gathering in the group (CK-80): the group page's New gathering
              opens the form with the group's member list. */}
          <Route path="/groups/:id/gatherings/new" element={<GroupGatheringNew />} />
          <Route path="/settings" element={<Settings />} />
          {/* The path is fixed by the backend's return URLs (CK-74): Checkout
              returns to /plan?checkout=complete|cancelled, the portal to /plan. */}
          <Route path="/plan" element={<Plan />} />
          <Route path="/you" element={<You />} />
          {/* The calendar (CK-91): the Calendar tab, and a group's calendar
              at /calendar?group=<id> — one route, the group in the query. */}
          <Route path="/calendar" element={<Calendar />} />
        </Route>
        {/* The routes OUTSIDE the frame stay outside: the landings are
            reached signed out, and the mockup draws them without a frame. */}
        {/* The two landings the backend's URLs point at (CK-79, Groups 3b):
            the group's link (`/groups/join#token=…`) and the emailed group
            invitation (`/groups/invitations/accept#token=…`). Deliberately
            NOT behind RequireAuth — a signed-out holder must see what the
            link is for and how to sign in, and RequireAuth would send them to
            `/` without the fragment, the token with it (CK-75's finding 1).
            Their static segments outrank the layout's dynamic
            `/groups/:id`, which until CK-79 a static row rendering the
            catch-all held for `/groups/join`. */}
        <Route path="/groups/join" element={<GroupJoin />} />
        <Route path="/groups/invitations/accept" element={<GroupInvitationAccept />} />
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
