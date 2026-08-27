// The one home for URL-scheme guarding at render sites (CK-21). A
// user-controlled value reaching href (or any navigation sink) is script
// execution when its scheme is javascript: — XSS with no HTML injection
// anywhere, which is why grepping for innerHTML never finds it. The backend
// allowlists the scheme on the way in (gatherings.py::_clean_map_url); this
// guard is the render half of belt and braces, neutralising anything already
// stored or arriving by a path that skips validation.
//
// target="_blank" is NOT a security control. Observed on the deployed app
// (2026-08-27): Chrome refuses javascript: URLs in a newly opened tab, so a
// stored javascript:alert(1) link produced about:blank instead of executing.
// That mitigation is incidental, browser-dependent, and one same-tab
// refactor away from vanishing — it must never be cited as the reason a
// sink is safe. The allowlist and this guard are the reason.

/**
 * Returns the value when it parses as an absolute http(s) URL, else null.
 * The URL parser applies the same tab/newline stripping browsers do, so the
 * obfuscated "java\tscript:" cases resolve to their real scheme before the
 * check. A null means: render the stored text as text — visible (a silently
 * vanished field is its own bug), never navigable.
 */
export function safeHttpUrl(value: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    // Unparseable without a base — relative paths and scheme-relative
    // //host values included. A map link is an absolute URL or nothing.
    return null
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? value : null
}
