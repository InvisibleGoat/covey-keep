import { useEffect, useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { MAKER_LINE } from '../brand'
import { Icon } from '../components/Icons'
import { planLine, readBilling, type Billing } from '../lib/billing'
import { initials } from '../lib/groups'
import { chooseMenuLayout, useMenuLayout, type MenuLayout } from '../lib/menuLayout'
import { chooseTheme, readTheme, type Theme } from '../lib/theme'

// /you — You (CK-82; decisions/2026-10-31-the-design-and-how-it-is-merged.md
// §1.4; the mockup's screen 13, with its words, in today's single column).
// The person, with their initials until profile pictures exist; Display →
// Appearance, Light or Dark, stored on this device and applied at once
// (lib/theme.ts); then Settings, Your plan with its line from
// `GET /billing`, and Sign out, which moved here from Home.
//
// Display holds two choices since CK-89: Menu layout first (One list or Rail
// and panel, lib/menuLayout.ts, the menu following at once), then Appearance.
//
// Not here, a later phase: Favorites (favourites are unbuilt, the record §4).

const MENU_LAYOUTS: { layout: MenuLayout; label: string; hint: string }[] = [
  { layout: 'list', label: 'One list', hint: 'Your groups and gatherings together, with a picture beside each name.' },
  { layout: 'rail', label: 'Rail and panel', hint: 'Group pictures down the side, and the group you pick beside them.' },
]

const APPEARANCE: { theme: Theme; label: string; hint: string }[] = [
  { theme: 'light', label: 'Light', hint: 'Paper by day.' },
  { theme: 'dark', label: 'Dark', hint: 'Easier on the eyes at night.' },
]

export function You() {
  const { person, signOut } = useAuth()
  const [theme, setTheme] = useState<Theme>(readTheme)
  const menuLayout = useMenuLayout()
  // Your plan's line, read from GET /billing — the screen keeps no numbers
  // of its own. A failed read shows the row without the line.
  const [billing, setBilling] = useState<Billing | null>(null)
  const ids = useId()

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await readBilling()
      if (!cancelled && result.ok) setBilling(result.billing)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  function choose(next: Theme) {
    chooseTheme(next)
    setTheme(next)
  }

  return (
    <main className="auth-screen you-screen">
      <h1>You</h1>

      <div className="auth-card you-who">
        {person ? (
          <>
            <span className="avatar" aria-hidden="true">
              {initials(person.display_name)}
            </span>
            <div>
              <p className="you-name">{person.display_name}</p>
              <p className="field-hint">Initials until you add a profile picture</p>
            </div>
          </>
        ) : (
          <p>You're signed in, but your profile couldn't be loaded just now.</p>
        )}
      </div>

      <section className="auth-card you-display" aria-labelledby={`${ids}-display`}>
        <h2 id={`${ids}-display`}>Display</h2>
        <fieldset className="you-choice">
          <legend>Menu layout</legend>
          <div className="opts">
            {MENU_LAYOUTS.map((option) => (
              <label key={option.layout} className="opt">
                <input
                  type="radio"
                  name="menu-layout"
                  value={option.layout}
                  checked={menuLayout === option.layout}
                  onChange={() => chooseMenuLayout(option.layout)}
                  aria-labelledby={`${ids}-ml-${option.layout}`}
                  aria-describedby={`${ids}-ml-${option.layout}-hint`}
                />
                <span>
                  <b id={`${ids}-ml-${option.layout}`}>{option.label}</b>
                  <span id={`${ids}-ml-${option.layout}-hint`}>{option.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="you-choice">
          <legend>Appearance</legend>
          <div className="opts">
            {APPEARANCE.map((option) => (
              <label key={option.theme} className="opt">
                <input
                  type="radio"
                  name="theme"
                  value={option.theme}
                  checked={theme === option.theme}
                  onChange={() => choose(option.theme)}
                  aria-labelledby={`${ids}-${option.theme}`}
                  aria-describedby={`${ids}-${option.theme}-hint`}
                />
                <span>
                  <b id={`${ids}-${option.theme}`}>{option.label}</b>
                  <span id={`${ids}-${option.theme}-hint`}>{option.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      </section>

      <div className="auth-card you-rows">
        <ul className="rows">
          <li>
            <Link className="nrow" to="/settings">
              <Icon name="gear" />
              <span className="t">
                <b>Settings</b>
              </span>
              <Icon name="chevron" className="chev" />
            </Link>
          </li>
          <li>
            <Link className="nrow" to="/plan">
              <Icon name="plan" />
              <span className="t">
                <b>Your plan</b>
                {billing && <span>{planLine(billing)}</span>}
              </span>
              <Icon name="chevron" className="chev" />
            </Link>
          </li>
          <li>
            {/* Signs out exactly as Home's button did: the session ends, and
                the guard sends the page to sign-in. */}
            <button type="button" className="nrow" onClick={() => void signOut()}>
              <Icon name="signOut" />
              <span className="t">
                <b>Sign out</b>
              </span>
            </button>
          </li>
        </ul>
      </div>

      <p className="badge">{MAKER_LINE}</p>
    </main>
  )
}
