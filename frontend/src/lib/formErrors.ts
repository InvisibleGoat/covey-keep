// One code path from a failed API response to rendered errors (CK-17) — used
// by every form from this phase on. The backend returns FastAPI 422 bodies
// (`detail` as an array of {loc, msg}) for both Pydantic validation and the
// app-layer checks that need DB state (gatherings.py wears the same shape
// deliberately), so one mapper covers them all.
//
// The contract, binding on callers:
// - A field error lands on its field: keys are the `loc` path minus its
//   leading source segment ("body"/"path"/"query"), joined with "." —
//   "title", "memorial_decedent_name", "occurrences.0.starts_at".
// - Errors that cannot land on a field the form renders are NEVER swallowed —
//   they surface in `form`. A form that silently does nothing on submit is
//   the worst outcome here.
// - Backend messages render as sent (the season-cap message names the span —
//   the backend owns that arithmetic; nothing here restates it). The only
//   dressing is presentation: Pydantic's "Value error, " prefix stripped and
//   the first letter capitalized.
// - Non-422 failures get a distinct, non-field message — a server error is
//   never presented as a validation error.

export interface FormErrors {
  // field key (see above) → the message to render inline against that field
  fields: Record<string, string>
  // everything that has no visible field to land on
  form: string[]
}

export function noErrors(): FormErrors {
  return { fields: {}, form: [] }
}

export function hasErrors(errors: FormErrors): boolean {
  return errors.form.length > 0 || Object.keys(errors.fields).length > 0
}

// For the catch around a fetch: the request never reached the server, which
// is not a validation outcome.
export function networkErrors(): FormErrors {
  return { fields: {}, form: ["Couldn't reach the server. Check your connection and try again."] }
}

// The id the inline error element carries and the input's aria-describedby
// points at: "error-<field>", with an optional scope prefix
// ("error-<scope>-<field>") for pages that render the same field key in more
// than one form at once (the /gatherings/:id occurrence editors, CK-18) —
// ids must stay unique per page for the aria wiring to resolve.
export function errorId(field: string, scope?: string): string {
  return scope ? `error-${scope}-${field}` : `error-${field}`
}

// What an input's aria-describedby should be: the inline error's id while
// that field has an error, undefined otherwise.
export function describedBy(
  errors: FormErrors,
  field: string,
  scope?: string,
): string | undefined {
  return errors.fields[field] ? errorId(field, scope) : undefined
}

interface ValidationItem {
  loc?: (string | number)[]
  msg?: string
}

// "Value error, a memorial requires the decedent's name"
//   → "A memorial requires the decedent's name"
function humanize(msg: string): string {
  const stripped = msg.replace(/^Value error,\s*/, '')
  return stripped.charAt(0).toUpperCase() + stripped.slice(1)
}

function fieldKey(loc: (string | number)[]): string {
  // Drop the leading source segment ("body", "path", "query"); what remains
  // names the field, with array indices kept ("occurrences.0.starts_at").
  return loc.slice(1).map(String).join('.')
}

// Maps any failed Response to FormErrors. `visibleFields` names the field
// keys the caller renders inline; anything else lands in `form` (with its
// path, so an unexpected error still says where it pointed).
export async function errorsFromResponse(
  response: Response,
  visibleFields: Iterable<string>,
): Promise<FormErrors> {
  const errors = noErrors()
  if (response.status !== 422) {
    errors.form.push('Something went wrong. Nothing was saved — try again.')
    return errors
  }

  let detail: unknown
  try {
    detail = ((await response.json()) as { detail?: unknown }).detail
  } catch {
    detail = undefined
  }

  if (typeof detail === 'string') {
    errors.form.push(detail)
    return errors
  }
  if (!Array.isArray(detail)) {
    errors.form.push("The server couldn't accept that. Check the form and try again.")
    return errors
  }

  const visible = new Set(visibleFields)
  for (const item of detail as ValidationItem[]) {
    if (!item.msg) continue
    const key = item.loc && item.loc.length > 1 ? fieldKey(item.loc) : ''
    const message = humanize(item.msg)
    if (key && visible.has(key)) {
      // First message per field wins — one inline line per input.
      if (!(key in errors.fields)) errors.fields[key] = message
    } else {
      errors.form.push(key ? `${message} (${key})` : message)
    }
  }
  if (!hasErrors(errors)) {
    // A 422 whose detail carried nothing usable still must not be silent.
    errors.form.push("The server couldn't accept that. Check the form and try again.")
  }
  return errors
}
