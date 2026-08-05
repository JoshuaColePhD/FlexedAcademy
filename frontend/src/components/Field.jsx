/* Form primitives.
 *
 * Label above the control, hint below it — one column, generous spacing.
 *
 * The input keeps its border where cards lost theirs: on a text field the
 * outline IS the affordance, and there is nothing else to say "you can type
 * here". Sections separate with space rather than a rule. */

export const inputClass =
  'w-full rounded-lg border border-edge bg-paper-raised px-3 py-2.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-ink-faint'

export function Field({ label, hint, htmlFor, children }) {
  return (
    <div className="py-3">
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-ink">
        {label}
      </label>
      {children}
      {hint ? <p className="mt-1.5 text-xs text-ink-muted">{hint}</p> : null}
    </div>
  )
}

/** A section break: a heading and one line of orientation. Sections are ordered
 *  by what a teacher needs first, not by what the backend stores together. */
export function Section({ label, children, className = '' }) {
  return (
    <div className={`pb-1 pt-8 ${className}`}>
      <h2 className="text-sm font-semibold text-ink">{label}</h2>
      {children ? <p className="mt-1 text-sm text-ink-muted">{children}</p> : null}
    </div>
  )
}
