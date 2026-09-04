/* The wizard's one persistent orientation cue.
 *
 * A real <ol> with aria-current="step", not aria-hidden decoration. Two
 * reasons, both decisive. It replaces BOTH of the flow's old progress
 * indicators — the "Step 3 of 6" line inside each step's header and the
 * .onboarding-progress dot bar under the card, two answers to the same
 * question stacked on one screen — so marking the replacement decorative would
 * take "where am I" away from a screen-reader user entirely. And a completed
 * step is a real button, because going back to change an answer is something
 * teachers do; focusable content inside an aria-hidden container is a bug of
 * its own.
 *
 * Upcoming steps are NOT buttons. You cannot skip ahead — each step saves
 * before it advances — so a control that looks pressable and isn't would be a
 * lie.
 *
 * No measured track, no percentage, no ResizeObserver. The plan is 4-7 steps
 * depending on what this account still has to answer, so each row draws its
 * own connector segment above itself and colours it from its own data-state.
 * Correct for any length, index-free, and nothing to keep in sync.
 */

export function OnboardingStepRail({ steps, activeKey, onGoTo }) {
  const activeIndex = steps.findIndex((step) => step.key === activeKey)

  /* The closing screen sits outside the numbered sequence, and a one-step plan
     has no progress worth drawing. Render the slot either way so the card's
     two-column grid doesn't reflow as the rail comes and goes. */
  if (activeIndex < 0 || steps.length < 2) return <div className="onboarding-rail-slot" />

  return (
    <div className="onboarding-rail-slot">
      <nav aria-label="Setup progress">
        <ol className="onboarding-rail">
          {steps.map((step, index) => {
            const state = index < activeIndex ? 'done' : index === activeIndex ? 'current' : 'upcoming'
            return (
              <li
                key={step.key}
                className="onboarding-rail-step"
                data-state={state}
                aria-current={state === 'current' ? 'step' : undefined}
              >
                <span className="onboarding-rail-dot" aria-hidden="true" />
                {state === 'done' ? (
                  <button type="button" className="onboarding-rail-label" onClick={() => onGoTo(step.key)}>
                    {step.label}
                    <span className="sr-only"> — done, go back and change this</span>
                  </button>
                ) : (
                  <span className="onboarding-rail-label">{step.label}</span>
                )}
              </li>
            )
          })}
        </ol>
      </nav>
      {/* Phone only. The <ol> above stays the accessible source of truth in both
          layouts — below md it collapses to a hairline track with only the
          current label visible, so this count is redundant to a screen reader
          and hidden from it. */}
      <p className="onboarding-rail-count eyebrow" aria-hidden="true">
        Step {activeIndex + 1} of {steps.length}
      </p>
    </div>
  )
}
