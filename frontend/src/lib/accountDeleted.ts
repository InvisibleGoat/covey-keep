// The one-shot signal the account deletion hands the confirmation screen
// (CK-76.1).
//
// Deleting an account ends in two steps that must land in this order: the
// person is shown /account-deleted, and THEN the browser forgets the session.
// Until CK-76.1 `Settings.tsx` did both in one handler — navigate, then
// `clearToken()` — counting on one batched render. React Router 7 runs a
// navigation inside `React.startTransition`, so the urgent signed-out update
// rendered first, at /settings, where `RequireAuth` redirected to `/` and
// that navigation superseded the one to /account-deleted: the person landed
// on the sign-in form with no explanation (CK-76's observation 1).
//
// So the handler now ONLY navigates, with this object as the navigation's
// state, and `routes/AccountDeleted.tsx` clears the session once it has
// rendered — only when the state carries this signal, and it then replaces
// the entry's state so the signal is spent. A direct visit to
// /account-deleted — typed, bookmarked, reached by Back, reloaded — carries
// no signal and signs nobody out.
//
// The signal says only that the deletion just happened. It carries no id, no
// email and no token, and nothing may be added to it: it rides the history
// entry, which outlives the session it ends.
export const ACCOUNT_DELETED_SIGNAL = { accountDeleted: true } as const

export function carriesAccountDeletedSignal(state: unknown): boolean {
  return (
    typeof state === 'object' &&
    state !== null &&
    (state as { accountDeleted?: unknown }).accountDeleted === true
  )
}
