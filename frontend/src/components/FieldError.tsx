import { errorId, type FormErrors } from '../lib/formErrors'

// The rendering half of the form-error contract (components.md): the inline
// message carries the id its input's aria-describedby points at — and, since
// CK-18, the error affordance itself: role="alert" so a message is announced
// when it appears, and a visible mark so it reads as an error rather than
// body text. Every form on lib/formErrors.ts renders through these.

export function FieldError({
  errors,
  field,
  scope,
}: {
  errors: FormErrors
  field: string
  scope?: string
}) {
  const message = errors.fields[field]
  if (!message) return null
  return (
    <p className="form-error" id={errorId(field, scope)} role="alert">
      <span aria-hidden="true">⚠ </span>
      {message}
    </p>
  )
}

// The messages that have no visible field to land on — never swallowed.
export function FormLevelErrors({ errors }: { errors: FormErrors }) {
  if (errors.form.length === 0) return null
  return (
    <>
      {errors.form.map((message, index) => (
        <p key={index} className="form-error" role="alert">
          <span aria-hidden="true">⚠ </span>
          {message}
        </p>
      ))}
    </>
  )
}
