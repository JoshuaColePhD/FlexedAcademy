import { ArrowRight, Loader2 } from 'lucide-react'

/* One plain-language action row per step.
 *
 * Back, Skip, and Continue are semantic buttons so keyboard, disabled, and
 * focus behaviour remain honest. They intentionally do not LOOK like boxed
 * buttons: the journey should finish as part of the question, not at a docked
 * control bar. Continue is the single forward phrase, with its arrow as the
 * directional cue rather than an enclosing pill.
 *
 * No .neo-raised: elevation belongs to surfaces, not a sentence that moves a
 * teacher to the next question. The arrow's small transform-only hover is
 * already covered by the blanket prefers-reduced-motion rule in base.css.
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
  hideBack = false,
  hideSkip = false,
  children,
}) {
  return (
    <div className="onboarding-actions">
      {/* In onboarding, Back moves to the top bar so the lower action zone
          carries only the forward decision. Other callers may still render it
          here. Continue stays the submit target for Enter. */}
      {onBack && !hideBack ? (
        <button type="button" className="onboarding-quiet" onClick={onBack}>
          {backLabel}
        </button>
      ) : null}
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
      {onSkip && !hideSkip ? (
        <button type="button" className="onboarding-quiet onboarding-skip" onClick={onSkip}>
          {skipLabel}
        </button>
      ) : null}
      {children}
    </div>
  )
}
