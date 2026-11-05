import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { PRODUCT_NAME } from '../brand'
import { SECTIONS, sectionOf } from '../lib/frame'
import { QuailHead } from './AuthArt'
import { Icon } from './Icons'
import { Menu } from './Menu'
import { PagePlaceContext } from './pagePlace'
import { useKeepPlace } from './useKeepPlace'

// The frame around every signed-in page (CK-82; the design handoff §3, the
// mockup's screens 01, 02, 05 and 13). App.tsx renders it once, as the
// element of the ONE layout route the signed-in routes sit under, inside
// RequireAuth; the page renders through the <Outlet /> and keeps its own
// <main> — the frame adds navigation around it, never a second main.
//
// - Phones, the window narrower than 900px: a sticky top bar (the menu
//   button, the quail's head and the product name), the bottom bar's tabs
//   (Groups, Gatherings, You — Calendar joins at CK-91), and the menu as a
//   drawer from the left over a scrim.
// - From 900px: the menu as a column beside the page, no top or bottom bar,
//   and the frame pinned to the window's height so the menu and the page
//   scroll separately.
//
// The breakpoint measures the WINDOW (the mockup measures its own width,
// because it previews itself inside a phone frame; the handoff leaves this
// to the builder), read with matchMedia so the bars are not merely hidden on
// a wide screen but absent — and the drawer's dialog semantics apply only
// where there is a drawer.
//
// The drawer is a dialog: role="dialog", aria-modal and a label while open;
// focus moves into it on opening and stays in it (Tab wraps, and the page
// behind is inert); Escape, a tap on the scrim and any navigation close it,
// and focus returns to the menu button; the page behind does not scroll.
// Closed, it is inert and hidden from assistive technology, waiting off the
// screen's edge so it can slide in (.26s, stilled under reduced motion).
//
// A page keeps its place (CK-88.2): useKeepPlace owns every navigation's scroll,
// on whichever of the two scrollers is active, and its context adds no element,
// so the page stays the column's own child (.frame-col > .auth-screen).

const WIDE = '(min-width: 900px)'
const MENU_ID = 'frame-menu'
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'

function matchesWide(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(WIDE).matches
}

function useWideScreen(): boolean {
  const [wide, setWide] = useState(matchesWide)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(WIDE)
    const onChange = () => setWide(query.matches)
    onChange()
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return wide
}

export function Frame() {
  const wide = useWideScreen()
  const location = useLocation()
  const current = sectionOf(location.pathname)
  const [open, setOpen] = useState(false)
  // Any navigation closes the drawer — tracked during render, React's way of
  // adjusting state to a changed input, so no frame paints it open on the
  // new page. A wide screen has no drawer, so it closes there too.
  const [seenKey, setSeenKey] = useState(location.key)
  if (seenKey !== location.key) {
    setSeenKey(location.key)
    if (open) setOpen(false)
  }
  if (wide && open) setOpen(false)
  const drawerOpen = open && !wide

  const menuButton = useRef<HTMLButtonElement>(null)
  const side = useRef<HTMLDivElement>(null)
  const column = useRef<HTMLDivElement>(null)
  const wasOpen = useRef(false)
  const place = useKeepPlace(column, wide)

  // Focus into the drawer on opening; back to the menu button on closing.
  useEffect(() => {
    if (drawerOpen) {
      wasOpen.current = true
      side.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus()
      return
    }
    if (wasOpen.current) {
      wasOpen.current = false
      menuButton.current?.focus()
    }
  }, [drawerOpen])

  // Escape closes it, and the page behind does not scroll while it is open.
  useEffect(() => {
    if (!drawerOpen) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    document.body.classList.add('menu-open')
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.classList.remove('menu-open')
    }
  }, [drawerOpen])

  // Tab and Shift+Tab wrap inside the open drawer.
  function keepFocusIn(event: ReactKeyboardEvent) {
    if (event.key !== 'Tab' || !side.current) return
    const focusable = Array.from(side.current.querySelectorAll<HTMLElement>(FOCUSABLE))
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const drawerClosed = !wide && !drawerOpen

  return (
    <div className={wide ? 'frame frame-wide' : 'frame'}>
      <div
        ref={side}
        id={MENU_ID}
        className={drawerOpen ? 'frame-side is-open' : 'frame-side'}
        role={drawerOpen ? 'dialog' : undefined}
        aria-modal={drawerOpen ? true : undefined}
        aria-label={drawerOpen ? 'Menu' : undefined}
        aria-hidden={drawerClosed ? true : undefined}
        inert={drawerClosed}
        onKeyDown={drawerOpen ? keepFocusIn : undefined}
      >
        <Menu />
      </div>
      {drawerOpen && <div className="frame-scrim" aria-hidden="true" onClick={() => setOpen(false)} />}
      <div ref={column} className="frame-col" inert={drawerOpen}>
        {!wide && (
          <header className="topbar">
            <button
              ref={menuButton}
              type="button"
              className="iconbtn"
              aria-label="Open menu"
              aria-expanded={drawerOpen}
              aria-controls={MENU_ID}
              onClick={() => setOpen(true)}
            >
              <Icon name="menu" />
            </button>
            <Link className="brand" to="/groups">
              <QuailHead />
              {PRODUCT_NAME}
            </Link>
          </header>
        )}
        <PagePlaceContext.Provider value={place}>
          <Outlet />
        </PagePlaceContext.Provider>
        {!wide && (
          <nav className="tabbar" aria-label="Sections">
            {SECTIONS.map((section) => (
              <Link
                key={section.id}
                className="tab"
                to={section.to}
                aria-current={current === section.id ? 'page' : undefined}
              >
                <span className="pill">
                  <Icon name={section.icon} />
                </span>
                {section.label}
              </Link>
            ))}
          </nav>
        )}
      </div>
    </div>
  )
}
