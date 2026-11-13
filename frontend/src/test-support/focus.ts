// Focus after an answer, as a test can stage it (CK-93.1, shared since
// CK-94). A press disables the control it was made on (or removes it), and
// Chrome then drops focus to the body while the request waits; jsdom has no
// such fixup and will not blur a disabled button, so a test stages it by
// hand: the control focused and pressed, the request held on a released
// promise, focus dropped to the body (or moved to where the person went),
// then the answer released and document.activeElement read.
import { act, fireEvent, waitFor } from '@testing-library/react'
import { expect } from 'vitest'

export interface Gate {
  promise: Promise<void>
  release: () => void
}

// A request the fake server holds until the test releases it.
export function gate(): Gate {
  let release = () => {}
  const promise = new Promise<void>((resolve) => (release = resolve))
  return { promise, release }
}

// Let what an answer started run, inside act.
export async function settle(ms = 30) {
  await act(() => new Promise((resolve) => setTimeout(resolve, ms)))
}

// Chrome's fixup, as jsdom can do it: jsdom will not blur a disabled
// control (it is no longer a focusable area), so focus a throwaway button and
// blur that — the body ends up focused, exactly where Chrome leaves it.
export function dropFocusToBody() {
  const stand = document.createElement('button')
  document.body.append(stand)
  stand.focus()
  stand.blur()
  stand.remove()
}

// Press a control whose request the fake server holds on `hold`: wait until
// the control is disabled or gone, drop focus to the body (or move it to
// `movedTo`, the person going elsewhere while it waits), then release the
// answer and let it land.
export async function pressHeld(control: HTMLElement, hold: Gate, movedTo?: HTMLElement) {
  control.focus()
  fireEvent.click(control)
  await waitFor(() => expect(!control.isConnected || (control as HTMLButtonElement).disabled).toBe(true))
  if (movedTo) movedTo.focus()
  else dropFocusToBody()
  expect(document.activeElement).toBe(movedTo ?? document.body)
  await act(async () => hold.release())
  await settle()
}
