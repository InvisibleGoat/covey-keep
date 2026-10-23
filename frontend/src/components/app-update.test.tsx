// CK-75.1 — the one owner of the service worker. The value under test: the
// update state CK-8.1 kept inside PwaUpdatePrompt now lives in
// AppUpdateProvider — exactly one source file calls useRegisterSW, and the
// notice is a reader of it — with CK-8.1's behaviour byte for byte: nothing
// until a new worker has activated, then "A new version is ready." with
// Reload and Not now; Not now puts the notice off until the next update
// check, which brings it back; a check asks the registration for an update
// when online, not when offline, and a failed check never throws into the
// app; the hourly interval and the on-visible check still run; and
// checkForUpdate is the same check, callable by any reader.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { AppUpdateProvider } from './AppUpdateProvider'
import { PwaUpdatePrompt } from './PwaUpdatePrompt'
import { useAppUpdate } from './useAppUpdate'
import promptSource from './PwaUpdatePrompt.tsx?raw'

vi.mock('virtual:pwa-register/react', () => ({ useRegisterSW: vi.fn() }))

type SwOptions = {
  onNeedReload?: () => void
  onRegisteredSW?: (swUrl: string, registration: ServiceWorkerRegistration | undefined) => void
}

const registerSW = vi.mocked(useRegisterSW)
let captured: SwOptions | undefined

beforeEach(() => {
  captured = undefined
  registerSW.mockReset()
  registerSW.mockImplementation((options?: SwOptions) => {
    captured = options
    return {
      needRefresh: [false, () => {}],
      offlineReady: [false, () => {}],
      updateServiceWorker: async () => {},
    }
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'onLine')
  Reflect.deleteProperty(document, 'visibilityState')
})

// A reader beside the notice: shows the ready state and offers the check,
// the way the catch-all screen uses the provider.
function Reader() {
  const { updateReady, checkForUpdate } = useAppUpdate()
  return (
    <div>
      <span data-testid="ready">{updateReady ? 'ready' : 'not ready'}</span>
      <button type="button" onClick={checkForUpdate}>
        Check now
      </button>
    </div>
  )
}

function renderOwner() {
  return render(
    <AppUpdateProvider>
      <PwaUpdatePrompt />
      <Reader />
    </AppUpdateProvider>,
  )
}

function fakeRegistration(update = vi.fn(() => Promise.resolve())) {
  return { registration: { update } as unknown as ServiceWorkerRegistration, update }
}

function registered(update?: () => Promise<void>) {
  const fake = fakeRegistration(update ? vi.fn(update) : undefined)
  act(() => captured?.onRegisteredSW?.('/sw.js', fake.registration))
  return fake
}

function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online })
}

test('useRegisterSW is called by exactly one source file, once at mount, with the no-ambush-reload callback', () => {
  renderOwner()
  // One component calls it: one call at mount, and the callback that keeps
  // the register helper from reloading the page on its own is registered.
  expect(registerSW).toHaveBeenCalledTimes(1)
  expect(captured?.onNeedReload).toBeTypeOf('function')
  expect(captured?.onRegisteredSW).toBeTypeOf('function')
  // And no other file names the hook: the owner is the only registration,
  // beside vite.config.ts's injectRegister: null (comments stripped — the
  // CK-70 idiom; test files and the test-support stub set aside).
  const sources = import.meta.glob<string>('../**/*.{ts,tsx}', {
    query: '?raw',
    import: 'default',
    eager: true,
  })
  // The glob really reached the whole tree (a wrong pattern would pass this
  // test over nothing): the route table and the catch-all are among the keys.
  expect(Object.keys(sources)).toContain('../App.tsx')
  expect(Object.keys(sources)).toContain('../routes/PageNotAvailable.tsx')
  const callers = Object.entries(sources)
    .filter(([path]) => !/\.test\.tsx?$/.test(path) && !path.includes('/test-support/'))
    .filter(([, source]) =>
      /useRegisterSW\(/.test(
        source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
      ),
    )
    // Vite keys a same-directory match `./x` and the rest `../dir/x`.
    .map(([path]) => path.replace(/^(\.\.\/|\.\/)+/, ''))
  expect(callers).toEqual(['AppUpdateProvider.tsx'])
  // The notice is a reader now: it imports no register module.
  expect(promptSource).not.toContain('pwa-register')
})

test('nothing renders until a new worker has activated; then the notice with Reload and Not now, in a status region', () => {
  renderOwner()
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.getByTestId('ready').textContent).toBe('not ready')
  act(() => captured?.onNeedReload?.())
  const notice = screen.getByRole('status')
  expect(notice.textContent).toContain('A new version is ready.')
  expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Not now' })).toBeTruthy()
  expect(screen.getByTestId('ready').textContent).toBe('ready')
})

test('Not now puts the notice off, and the next update check brings it back — the hourly check, on fake timers', () => {
  vi.useFakeTimers()
  renderOwner()
  const { update } = registered()
  act(() => captured?.onNeedReload?.())
  fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
  expect(screen.queryByRole('status')).toBeNull()
  // The reader still knows an update is ready: dismissal is the notice's.
  expect(screen.getByTestId('ready').textContent).toBe('ready')
  // 59 minutes: nothing. The hour: the check runs and the notice returns.
  act(() => {
    vi.advanceTimersByTime(59 * 60 * 1000)
  })
  expect(screen.queryByRole('status')).toBeNull()
  expect(update).not.toHaveBeenCalled()
  act(() => {
    vi.advanceTimersByTime(60 * 1000)
  })
  expect(screen.getByRole('status')).toBeTruthy()
  expect(update).toHaveBeenCalledTimes(1)
})

test('the tab becoming visible runs the same check', () => {
  renderOwner()
  const { update } = registered()
  act(() => captured?.onNeedReload?.())
  fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
  expect(screen.queryByRole('status')).toBeNull()
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
  expect(screen.getByRole('status')).toBeTruthy()
  expect(update).toHaveBeenCalledTimes(1)
})

test('checkForUpdate from a reader asks the registration for an update when online, and not when offline — but still brings a dismissed notice back', () => {
  renderOwner()
  // Before the registration arrives there is nothing to ask, and nothing throws.
  fireEvent.click(screen.getByRole('button', { name: 'Check now' }))
  const { update } = registered()
  setOnline(true)
  fireEvent.click(screen.getByRole('button', { name: 'Check now' }))
  expect(update).toHaveBeenCalledTimes(1)
  // Offline: no request to the store of worker scripts — the next check
  // simply tries again — but the dismissal rule still runs.
  act(() => captured?.onNeedReload?.())
  fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
  expect(screen.queryByRole('status')).toBeNull()
  setOnline(false)
  fireEvent.click(screen.getByRole('button', { name: 'Check now' }))
  expect(update).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('status')).toBeTruthy()
})

test('a failed check never throws into the app', async () => {
  renderOwner()
  registered(() => Promise.reject(new Error('captive portal')))
  setOnline(true)
  fireEvent.click(screen.getByRole('button', { name: 'Check now' }))
  // Let the rejection settle; an unhandled one would fail this test.
  await act(async () => {
    await Promise.resolve()
  })
  expect(screen.getByTestId('ready').textContent).toBe('not ready')
})

test('a reader outside the provider is a programming error, loudly', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(() => render(<Reader />)).toThrow(/inside AppUpdateProvider/)
  error.mockRestore()
})
