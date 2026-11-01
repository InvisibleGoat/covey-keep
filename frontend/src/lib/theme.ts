// The theme, chosen on You and stored on this device (CK-82;
// decisions/2026-10-31-the-design-and-how-it-is-merged.md §1.4).
//
// THE ONE MODULE THAT READS OR WRITES IT. Two places touch the stored choice
// or the `data-theme` attribute, and only two: this module, and the small
// inline script in index.html's <head> that applies a stored `dark` before
// the first paint, so a person who chose dark never sees a flash of light.
// Nothing else names the key or the attribute (pinned in
// styles/look.test.tsx).
//
// Light is the default. The key holds `light` or `dark`; anything else, a
// missing key, or storage that throws reads as light. There is no "match my
// device" (the record §1.4): no stylesheet asks the device which scheme it
// prefers, and nothing here does either. The choice is a preference, nothing
// personal, and it never leaves the device.

export const THEME_KEY = 'covey-keep:theme'

export type Theme = 'light' | 'dark'

function applied(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

// The stored choice: exactly `dark` is dark, and everything else is light.
// Where storage throws, the theme this page load is showing — which is
// light at load (index.html paints it), or what was chosen since.
export function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return applied()
  }
}

// Applies the choice at once and stores it. A storage failure still applies
// it for this page load; the next load paints light.
export function chooseTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    // Applied for this page load; nothing else to do.
  }
}
