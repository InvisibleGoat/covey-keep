// CK-97 — the focus leftovers, through the app's REAL route table with the
// REAL AuthProvider, against the two fake servers (test-support/world96.ts
// and test-support/photos.ts). Chrome drops focus to the body from a control
// the press removes or disables; jsdom does not, so each test drops it by
// hand while the request is held (test-support/focus.ts). The values under
// test (the kickoff's §2–§10):
// - Your plan's already_subscribed: the line beneath the Upgrade pressed at
//   once, an alert; once the plan read again lands, beneath Manage your plan,
//   no alert, Manage described by it, focus on Manage; a failed read leaves
//   it beneath that Upgrade;
// - the co-host list's line and Try again drawn whenever that read failed,
//   the invitation list's failing too; its landing on Co-hosts, else the
//   section's heading;
// - You's Try again (Steven, 2026-11-14): the profile read again once, the
//   <h1> You on landing, the new Try again failing again, its line no alert;
// - the two invitation pages' failed screen: one sentence, an alert, and a
//   Try again landing on the new screen's <h1>, or navigating, or the new
//   Try again;
// - the decline step open while Decline it waits, both its buttons disabled;
// - the Removed view's Delete permanently refused, read in the gathering's
//   bin's words;
// - a view switch, or a move to another gathering, drawing no list until the
//   read for it lands;
// - no row offers Remove from gathering (the viewer still does);
// - a press that replaces itself with a form puts focus on the form's first
//   field;
// - a person who moved elsewhere while it waited keeps their place.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import App from '../App'
import { AuthProvider } from '../auth/AuthContext'
import { clearCoverPictures } from '../lib/covers'
import { setToken } from '../lib/session'
import { gate, pressHeld, settle } from '../test-support/focus'
import {
  conflict,
  inGatheringBin,
  inOwnBin,
  own,
  photo,
  photosWorld,
  resetPhotosWorld,
  rowOf,
  stubPhotosServer,
  waiting,
} from '../test-support/photos'
import { gatheringDetail, GROUP, paidBilling, resetWorld96, stubWidth, stubWorld96, world96, type Key } from '../test-support/world96'

vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
  startRegistration: async () => ({}),
  startAuthentication: async () => ({}),
}))

const CHECKED = "The invitation couldn't be checked just now."
const ALREADY = 'You already have a plan. Use Manage your plan to change it.'

function outside(): HTMLElement {
  const stand = document.createElement('button')
  stand.dataset.outside = ''
  stand.textContent = 'elsewhere'
  document.body.append(stand)
  return stand
}

function render96(path: string, signedIn = true) {
  if (signedIn) setToken('tok-ada')
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  )
}

// The element an aria-describedby names, read back as its text.
function describedText(element: Element): string | null {
  const by = element.getAttribute('aria-describedby')
  if (!by) return null
  return by
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
    .join(' ')
}

// ===================================================================== world96

describe('on world96', () => {
  beforeEach(() => {
    localStorage.clear()
    resetWorld96()
    stubWorld96()
    stubWidth(false)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    document.querySelectorAll('[data-outside]').forEach((node) => node.remove())
    window.location.hash = ''
  })

  async function settled() {
    await waitFor(() => expect(world96.inflight).toBe(0))
    await settle()
  }

  // Press with the request on `keys` held; `again` keeps it failing.
  async function press(control: HTMLElement, keys: Key[], again = true, movedTo?: HTMLElement) {
    await settled()
    const hold = gate()
    for (const key of keys) {
      world96.hold[key] = hold
      if (!again) delete world96.fail[key]
    }
    await pressHeld(control, hold, movedTo)
  }

  const section = (name: string) => screen.getByRole('heading', { name }).closest('section') as HTMLElement

  // ------------------------------------------------------------- §2 Your plan

  async function plan() {
    render96('/plan')
    await screen.findByRole('heading', { level: 1, name: 'Your plan' })
    await screen.findByText(/Space for the photos/)
    await settled()
  }

  const upgrade = () => screen.getByRole('button', { name: 'Upgrade for $4.99 a month' })
  const upgradeCard = () => upgrade().closest('section') as HTMLElement
  const currentCard = () => document.querySelector('.plan-current') as HTMLElement

  async function alreadySubscribed(read: 'held' | 'fails' | 'lands', movedTo?: HTMLElement) {
    await plan()
    const hold = gate()
    world96.hold.checkout = hold
    world96.answer.checkout = { status: 409, body: { detail: { code: 'already_subscribed' } } }
    const reread = gate()
    if (read === 'fails') world96.fail.billing = { status: 500 }
    else world96.billing = paidBilling()
    world96.hold.billing = reread
    await pressHeld(upgrade(), hold, movedTo)
    return reread
  }

  test('§2 Your plan: already_subscribed puts its line beneath the Upgrade pressed at once, an alert', async () => {
    const reread = await alreadySubscribed('held')
    const line = within(upgradeCard()).getByRole('alert')
    expect(line.textContent).toBe(ALREADY)
    await act(async () => reread.release())
  })

  test('§2 Your plan: once the plan read lands, the line is beneath Manage your plan, no alert, Manage described by it, focus on Manage', async () => {
    const reread = await alreadySubscribed('held')
    await act(async () => reread.release())
    const manage = await screen.findByRole('button', { name: 'Manage your plan' })
    await waitFor(() => expect(document.activeElement).toBe(manage))
    expect(within(currentCard()).getByText(ALREADY)).toBeTruthy()
    expect(within(currentCard()).queryByRole('alert')).toBeNull()
    expect(screen.queryAllByRole('alert')).toHaveLength(0)
    expect(describedText(manage)).toBe(ALREADY)
  })

  test('§2 Your plan: the line goes on the next act', async () => {
    const reread = await alreadySubscribed('held')
    await act(async () => reread.release())
    const manage = await screen.findByRole('button', { name: 'Manage your plan' })
    await waitFor(() => expect(document.activeElement).toBe(manage))
    const hold = gate()
    world96.hold.portal = hold
    fireEvent.click(manage)
    await settle()
    expect(screen.queryByText(ALREADY)).toBeNull()
    expect(manage.getAttribute('aria-describedby')).toBeNull()
    await act(async () => hold.release())
  })

  test('§2 Your plan: a failed plan read leaves the line beneath that Upgrade, an alert, focus on it', async () => {
    const reread = await alreadySubscribed('fails')
    await act(async () => reread.release())
    await settle()
    expect(document.activeElement).toBe(upgrade())
    expect(within(upgradeCard()).getByRole('alert').textContent).toBe(ALREADY)
  })

  test.each([
    ['lands', 'lands'],
    ['fails', 'fails'],
  ] as const)('§2 Your plan: a person who moved outside the page keeps their place when the read %s', async (_n, read) => {
    const away = outside()
    const reread = await alreadySubscribed(read, away)
    await act(async () => reread.release())
    await settle(100)
    expect(document.activeElement).toBe(away)
  })

  // -------------------------------------------------------- §3 the co-host line

  test('§3 a standalone gathering, both reads failed: both lines and both Try agains', async () => {
    world96.fail.roster = { status: 500 }
    world96.fail.coHosts = { status: 500 }
    render96('/gatherings/g-1')
    fireEvent.click(await screen.findByRole('button', { name: 'Invite people' }))
    const scope = () => section('Invitations')
    await waitFor(() => expect(within(scope()).getAllByRole('button', { name: 'Try again' })).toHaveLength(2))
    expect(within(scope()).getAllByRole('alert').map((a) => a.textContent)).toEqual([
      "⚠ The invitation list couldn't be loaded just now.",
      "⚠ The co-host list couldn't be loaded just now.",
    ])
  })

  test('§3 the co-host Try again, landing while the roster has failed, puts focus on the section heading', async () => {
    world96.fail.roster = { status: 500 }
    world96.fail.coHosts = { status: 500 }
    render96('/gatherings/g-1')
    fireEvent.click(await screen.findByRole('button', { name: 'Invite people' }))
    const scope = () => section('Invitations')
    await waitFor(() => expect(within(scope()).getAllByRole('button', { name: 'Try again' })).toHaveLength(2))
    await press(within(scope()).getAllByRole('button', { name: 'Try again' })[1], ['coHosts'], false)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Invitations', level: 2 })))
  })

  test('§3 the co-host Try again, failing again while the roster has failed, puts focus on the new co-host Try again', async () => {
    world96.fail.roster = { status: 500 }
    world96.fail.coHosts = { status: 500 }
    render96('/gatherings/g-1')
    fireEvent.click(await screen.findByRole('button', { name: 'Invite people' }))
    const scope = () => section('Invitations')
    await waitFor(() => expect(within(scope()).getAllByRole('button', { name: 'Try again' })).toHaveLength(2))
    await press(within(scope()).getAllByRole('button', { name: 'Try again' })[1], ['coHosts'])
    await waitFor(() => expect(document.activeElement).toBe(within(scope()).getAllByRole('button', { name: 'Try again' })[1]))
  })

  test("§3 a group's gathering, both reads failed: both lines, the co-host Try again landing on Co-hosts", async () => {
    world96.detail['g-2'] = gatheringDetail('g-2')
    world96.fail.roster = { status: 500 }
    world96.fail.coHosts = { status: 500 }
    render96('/gatherings/g-2')
    fireEvent.click(await screen.findByRole('button', { name: 'Show co-hosts' }))
    const scope = () => section('Co-hosts')
    await waitFor(() => expect(within(scope()).getAllByRole('button', { name: 'Try again' })).toHaveLength(2))
    expect(within(scope()).getAllByRole('alert').map((a) => a.textContent)).toEqual([
      "⚠ The list of who's invited couldn't be loaded just now.",
      "⚠ The co-host list couldn't be loaded just now.",
    ])
    await press(within(scope()).getAllByRole('button', { name: 'Try again' })[1], ['coHosts'], false)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Co-hosts', level: 2 })))
  })

  // ------------------------------------------------------------------ §4 You

  async function you() {
    world96.fail.me = { status: 500 }
    render96('/you')
    await screen.findByRole('heading', { level: 1, name: 'You' })
    await screen.findByText("You're signed in, but your profile couldn't be loaded just now.")
    await settled()
  }

  test("§4 You: the profile line has a Try again, described by the line, the line no alert", async () => {
    await you()
    const button = screen.getByRole('button', { name: 'Try again' })
    expect(describedText(button)).toBe("You're signed in, but your profile couldn't be loaded just now.")
    expect(screen.queryAllByRole('alert')).toHaveLength(0)
  })

  test('§4 You: Try again landing puts focus on You, the name and the menu following', async () => {
    await you()
    expect(screen.queryAllByText('Ada Test')).toHaveLength(0)
    const before = world96.log.filter((k) => k === 'me').length
    await press(screen.getByRole('button', { name: 'Try again' }), ['me'], false)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'You' })))
    expect(world96.log.filter((k) => k === 'me').length).toBe(before + 1)
    // You's card and the menu's footer both name the person now.
    expect(screen.getAllByText('Ada Test').length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  test('§4 You: Try again failing again puts focus on the new Try again', async () => {
    await you()
    await press(screen.getByRole('button', { name: 'Try again' }), ['me'])
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Try again' })))
  })

  test.each([
    ['a success', false],
    ['a failure', true],
  ])('§4 You: a person who moved outside the page keeps their place after %s', async (_n, again) => {
    await you()
    const away = outside()
    await press(screen.getByRole('button', { name: 'Try again' }), ['me'], again, away)
    await settle(100)
    expect(document.activeElement).toBe(away)
  })

  // --------------------------------------------------- §5 the invitation pages

  const PAGES = [
    {
      name: 'a group invitation',
      path: '/groups/invitations/accept',
      preview: 'groupInvitationPreview' as Key,
      accept: 'groupInvitationAccept' as Key,
      invited: `You're invited to join ${GROUP.name}`,
      landed: GROUP.name,
    },
    {
      name: 'a gathering invitation',
      path: '/invitations/accept',
      preview: 'invitationPreview' as Key,
      accept: 'invitationAccept' as Key,
      invited: "You're invited",
      landed: 'The Party',
    },
  ]

  async function failedPage(page: (typeof PAGES)[number], signedIn: boolean) {
    window.location.hash = '#token=tok-abc'
    world96.fail[signedIn ? page.accept : page.preview] = { status: 500 }
    render96(page.path, signedIn)
    await screen.findByRole('heading', { level: 1, name: 'Something went wrong' })
    await settled()
  }

  for (const page of PAGES) {
    for (const signedIn of [false, true]) {
      const who = signedIn ? 'signed in' : 'signed out'
      const key = signedIn ? page.accept : page.preview

      test(`§5 ${page.name}, ${who}: the failed screen's line is one sentence, an alert`, async () => {
        await failedPage(page, signedIn)
        const line = screen.getByRole('alert')
        expect(line.textContent).toBe(CHECKED)
        expect(screen.queryByText(/Try the link from your invitation/)).toBeNull()
        expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
      })

      test(`§5 ${page.name}, ${who}: Try again landing ${signedIn ? 'navigates to the page invited to' : "puts focus on the new screen's <h1>"}`, async () => {
        await failedPage(page, signedIn)
        const before = world96.log.filter((k) => k === key).length
        await press(screen.getByRole('button', { name: 'Try again' }), [key], false)
        if (signedIn) {
          await screen.findByRole('heading', { level: 1, name: page.landed })
        } else {
          const h1 = await screen.findByRole('heading', { level: 1, name: page.invited })
          await waitFor(() => expect(document.activeElement).toBe(h1))
        }
        expect(world96.log.filter((k) => k === key).length).toBe(before + 1)
      })

      test(`§5 ${page.name}, ${who}: Try again failing again puts focus on the new Try again`, async () => {
        await failedPage(page, signedIn)
        await press(screen.getByRole('button', { name: 'Try again' }), [key])
        await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Try again' })))
      })
    }

    test.each([
      ['a success', false],
      ['a failure', true],
    ])(`§5 ${page.name}: a person who moved outside the page keeps their place after %s`, async (_n, again) => {
      await failedPage(page, false)
      const away = outside()
      await press(screen.getByRole('button', { name: 'Try again' }), [page.preview], again, away)
      await settle(100)
      expect(document.activeElement).toBe(away)
    })
  }

  // ------------------------------------------------------ §10 a form's first field

  async function gathering() {
    render96('/gatherings/g-1')
    await screen.findByRole('heading', { name: 'The Party', level: 1 })
    await settled()
  }

  test("§10 Edit this date opens its form with focus on Starts, and Cancel puts it back", async () => {
    await gathering()
    const edit = screen.getAllByRole('button', { name: 'Edit this date' })[1]
    edit.focus()
    fireEvent.click(edit)
    const form = screen.getByRole('group', { name: 'Edit this date' }).closest('form') as HTMLElement
    await waitFor(() => expect(document.activeElement).toBe(within(form).getByLabelText('Starts')))
    within(form).getByRole('button', { name: 'Cancel' }).focus()
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(document.activeElement).toBe(screen.getAllByRole('button', { name: 'Edit this date' })[1]))
  })

  test('§10 Add another date opens its form with focus on Starts, and Cancel puts it back', async () => {
    await gathering()
    const add = screen.getByRole('button', { name: 'Add another date' })
    add.focus()
    fireEvent.click(add)
    const form = screen.getByRole('group', { name: 'New date' }).closest('form') as HTMLElement
    await waitFor(() => expect(document.activeElement).toBe(within(form).getByLabelText('Starts')))
    within(form).getByRole('button', { name: 'Cancel' }).focus()
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add another date' })))
  })

  test("§10 (the sweep) Invite people opens its section with focus on the email field", async () => {
    await gathering()
    const invite = screen.getByRole('button', { name: 'Invite people' })
    invite.focus()
    fireEvent.click(invite)
    await waitFor(() => expect(document.activeElement).toBe(within(section('Invitations')).getByLabelText('Email address')))
  })
})

// ===================================================================== photos

describe('on the photos world', () => {
  // The All view's rows: w1, w2 (someone else's, waiting), o1 (your own,
  // waiting), b1 (your own, in your bin); the queue's w1, w2, o1; the Removed
  // view's g1, g2; the grid's p1, p2 (someone else's, published).
  function theWorld() {
    return [
      photo('w1', waiting),
      photo('w2', waiting),
      photo('o1', { ...own, ...waiting, tags: ['dock'] }),
      photo('b1', inOwnBin()),
      photo('g1', inGatheringBin()),
      photo('g2', inGatheringBin()),
      photo('p1'),
      photo('p2'),
    ]
  }

  beforeEach(() => {
    clearCoverPictures()
    localStorage.clear()
    setToken('token-ada')
    resetPhotosWorld(theWorld())
    stubPhotosServer()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} }))
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  async function open() {
    render(
      <MemoryRouter initialEntries={['/gatherings/g-1']}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    )
    await screen.findByRole('heading', { level: 1, name: 'The Party' })
    await settle()
    await settle()
  }

  const block = () => document.querySelector('.media-block') as HTMLElement
  const sectionButton = (label: string | RegExp) => within(block()).getByRole('button', { name: label })
  const inRow = (name: string, label: string | RegExp) => within(rowOf(name)).getByRole('button', { name: label })
  const rows = () => document.querySelectorAll('li.media-item')
  const tiles = () => document.querySelectorAll('.pgrid button')

  // ---------------------------------------------------------- §6 Decline it's wait

  async function declineHeld() {
    await open()
    fireEvent.click(inRow('IMG_w1.jpg', 'Decline'))
    await settle()
    const hold = gate()
    photosWorld.hold.decline = hold
    fireEvent.click(inRow('IMG_w1.jpg', 'Decline it'))
    await settle()
    return hold
  }

  test('§6 the decline step stays open while Decline it waits, Decline it disabled reading Declining…, Leave it waiting disabled', async () => {
    const hold = await declineHeld()
    const step = rowOf('IMG_w1.jpg').querySelector('[role="group"]') as HTMLElement
    expect(step).not.toBeNull()
    const declining = within(step).getByRole('button', { name: 'Declining…' }) as HTMLButtonElement
    expect(declining.disabled).toBe(true)
    expect((within(step).getByRole('button', { name: 'Leave it waiting' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => hold.release())
    await settle()
    await settle()
  })

  test("§6 the decline step closes with the answer, a refusal back on that row's Decline", async () => {
    photosWorld.answer.decline = conflict('not_pending')
    const hold = await declineHeld()
    ;(document.activeElement as HTMLElement).blur()
    await act(async () => hold.release())
    await settle()
    await settle()
    expect(rowOf('IMG_w1.jpg').querySelector('[role="group"]')).toBeNull()
    expect(document.activeElement).toBe(inRow('IMG_w1.jpg', 'Decline'))
  })

  // ------------------------------------------- §7 the Removed view's delete refusal

  test("§7 the Removed view's Delete permanently, refused not_removed, reads the gathering's bin's words", async () => {
    await open()
    fireEvent.click(sectionButton('Removed from this gathering'))
    await settle()
    await settle()
    fireEvent.click(inRow('IMG_g1.jpg', 'Delete permanently'))
    await settle()
    photosWorld.answer.destroy = conflict('not_removed')
    const step = rowOf('IMG_g1.jpg').querySelector('[role="group"]') as HTMLElement
    fireEvent.click(within(step).getByRole('button', { name: 'Delete permanently' }))
    await settle()
    await settle()
    expect(rowOf('IMG_g1.jpg').textContent).toContain(
      "This photo isn't in the gathering's bin any more — refresh the list to see where it is.",
    )
    expect(rowOf('IMG_g1.jpg').textContent).not.toContain("This photo isn't in your bin any more")
  })

  // ------------------------------------------------------------ §8 the view switch

  async function switchHeld(label: string) {
    const button = sectionButton(label)
    const hold = gate()
    photosWorld.hold.list = hold
    button.focus()
    fireEvent.click(button)
    await settle()
    return { hold, button }
  }

  async function release(hold: { release: () => void }) {
    await act(async () => hold.release())
    await settle()
    await settle()
    delete photosWorld.hold.list
  }

  test('§8 All → the queue, its read held: no row, no tile and no empty line; the switch kept, focus on the view pressed', async () => {
    await open()
    expect(rows().length).toBeGreaterThan(0)
    expect(tiles().length).toBeGreaterThan(0)
    const { hold, button } = await switchHeld('Awaiting your review')
    expect(rows()).toHaveLength(0)
    expect(tiles()).toHaveLength(0)
    expect(within(block()).queryByText('Nothing is waiting for your review.')).toBeNull()
    expect(within(block()).queryByText('No photos yet.')).toBeNull()
    expect(sectionButton('All photos')).toBeTruthy()
    expect(sectionButton('Removed from this gathering')).toBeTruthy()
    expect(document.activeElement).toBe(button)
    await release(hold)
    expect([...rows()].map((li) => li.textContent?.includes('IMG_w1.jpg'))).toContain(true)
    expect(rowOf('IMG_w2.jpg')).toBeTruthy()
    expect(document.activeElement).toBe(button)
  })

  test('§8 the queue → Removed → All, each read held: never the last view’s rows under the new view', async () => {
    await open()
    let step = await switchHeld('Awaiting your review')
    await release(step.hold)
    step = await switchHeld('Removed from this gathering')
    expect(rows()).toHaveLength(0)
    await release(step.hold)
    expect(rowOf('IMG_g1.jpg')).toBeTruthy()
    step = await switchHeld('All photos')
    expect(rows()).toHaveLength(0)
    expect(tiles()).toHaveLength(0)
    await release(step.hold)
    expect(rowOf('IMG_b1.jpg')).toBeTruthy()
    expect(tiles().length).toBeGreaterThan(0)
  })

  test('§8 a search within one view keeps its old matches while the new read waits', async () => {
    await open()
    const before = rows().length
    const hold = gate()
    photosWorld.hold.list = hold
    fireEvent.change(screen.getByLabelText('Find a photo'), { target: { value: 'dock' } })
    await settle(600)
    expect(rows().length).toBe(before)
    await release(hold)
    expect(rows()).toHaveLength(1)
  })

  test("§8 (the sweep) moving to another gathering, its read held: none of the last gathering's rows or tiles", async () => {
    resetPhotosWorld(theWorld())
    photosWorld.second = true
    await open()
    expect(rows().length).toBeGreaterThan(0)
    const count = () => [...block().querySelectorAll('.meta')].map((el) => el.textContent).filter((t) => /^\d+ photos?$/.test(t ?? ''))
    expect(count()).toHaveLength(1)
    const hold = gate()
    photosWorld.hold.list = hold
    const link = (await screen.findAllByRole('link', { name: /The Picnic/, hidden: true }))[0]
    fireEvent.click(link)
    await screen.findByRole('heading', { level: 1, name: 'The Picnic' })
    await settle()
    expect(rows()).toHaveLength(0)
    expect(tiles()).toHaveLength(0)
    expect(within(block()).queryByText('No photos yet.')).toBeNull()
    expect(count()).toHaveLength(0)
    await release(hold)
    expect(within(block()).getByText('No photos yet.')).toBeTruthy()
    expect(count()).toHaveLength(0)
  })

  // ----------------------------------------------- §9 no row's Remove from gathering

  test('§9 no row offers Remove from gathering, in any view or during a switch', async () => {
    await open()
    const none = () =>
      [...rows()].every((li) => within(li as HTMLElement).queryByRole('button', { name: 'Remove from gathering' }) === null)
    expect(none()).toBe(true)
    let step = await switchHeld('Awaiting your review')
    expect(none()).toBe(true)
    await release(step.hold)
    expect(none()).toBe(true)
    step = await switchHeld('Removed from this gathering')
    expect(none()).toBe(true)
    await release(step.hold)
    expect(none()).toBe(true)
    step = await switchHeld('All photos')
    expect(none()).toBe(true)
    await release(step.hold)
    expect(none()).toBe(true)
  })

  test("§9 the photo viewer still offers Remove from gathering on someone else's published photo", async () => {
    await open()
    fireEvent.click(tiles()[0] as HTMLElement)
    const viewer = await screen.findByRole('dialog')
    expect(within(viewer).getByRole('button', { name: 'Remove from gathering' })).toBeTruthy()
  })
})
