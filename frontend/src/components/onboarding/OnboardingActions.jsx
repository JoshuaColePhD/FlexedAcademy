import { ArrowRight, Loader2 } from 'lucide-react'

/* Exactly one filled control per step.
 *
 * The old footers used .dialog-actions with up to THREE .btn siblings — Back,
 * "Skip for now", Continue — two of them competing outline buttons carrying
 * their own neomorphic emboss. Back and Skip are quiet text here; Continue is
 * the only thing on the screen with a fill.
 *
 * Continue is the DARK ink pill, not .btn-primary, which fills with --accent.
 * That split is real and worth keeping: tokens.css rule 4 reserves district
 * blue for what is actionable INSIDE the product, and every linear one-way
 * flow the app has already carries ink instead — /welcome's "Open my year",
 * /signup, /reset. This wizard opens straight off /welcome's own Continue, so
 * the button must not change colour mid-flow.
 *
 * No .neo-raised: rule 2 keeps elevation for floating layers, and /welcome's
 * equivalent doesn't wear one either. .fa-press gives the tactile feedback
 * instead — transform-only, and already gated by the blanket
 * prefers-reduced-motion block in base.css, which is also what replaces the
 * whileHover={{ scale: 1.02 }} props scattered across this flow.
 *
 * `skipLabel` defaults to a bare "Skip for now" but every caller that can
 * should pass the step's own cost instead ("Skip — I'll plan by week number
 * for now"). A skip is only an informed choice if the screen says what it
 * costs, and before this nothing in the product did.
 */
export function OnboardingActions({
  onNext,
  nextLabel = 'Continue',
  busyLabel = 'Saving…',
  busy = false,
  disabled = false,
  onBack,
  backLabel = 'Back',
  onSkip,
  skipLabel = 'Skip for now',
  children,
}) {
  return (
    <div className="onboarding-actions">
      {/* Primary first in the DOM and left-aligned: it matches the reference,
          it makes Continue the focus trap's first stop rather than something
          you tab past two throwaways to reach, and it is the Enter target. */}
      <button
        type="button"
        className="onboarding-continue fa-press"
        onClick={onNext}
        disabled={busy || disabled}
      >
        {busy ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : null}
        {busy ? busyLabel : nextLabel}
        {busy ? null : <ArrowRight size={15} aria-hidden="true" />}
      </button>
      {onBack ? (
        <button type="button" className="onboarding-quiet" onClick={onBack}>
          {backLabel}
        </button>
      ) : null}
      {onSkip ? (
        <button type="button" className="onboarding-quiet onboarding-skip" onClick={onSkip}>
          {skipLabel}
        </button>
      ) : null}
      {children}
    </div>
  )
}
