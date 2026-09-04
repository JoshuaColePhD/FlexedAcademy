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

import { useLayoutEffect, useRef, useState } from 'react'

export function OnboardingStepRail({ steps, activeKey, onGoTo }) {
  const activeIndex = steps.findIndex((step) => step.key === activeKey)

  /* One marker that SLIDES between steps, rather than each dot changing
   * colour where it stands. Same pattern as AppShell's own sliding indicator,
   * and the same reason: a marker that travels reads as progress along a
   * route, where a colour swap reads as two separate states.
   *
   * Measured from the live <li> rather than computed from a row height and a
   * gap. The arithmetic version is a trap — a label that wraps, a longer step
   * name, or a different font size all silently desynchronise it from the dots
   * it is supposed to sit on.
   */
  const listRef = useRef(null)
  const [markerY, setMarkerY] = useState(null)

  useLayoutEffect(() => {
    const item = listRef.current?.children?.[activeIndex]
    if (!item) return undefined
    const place = () => setMarkerY(item.offsetTop + item.offsetHeight / 2)
    place()
    /* The rail's own height can change without the step changing — a label
     * rewrapping when the pane resizes — and the marker has to follow. */
    const ro = new ResizeObserver(place)
    ro.observe(listRef.current)
    return () => ro.disconnect()
  }, [activeIndex, steps.length])

  /* The closing screen sits outside the numbered sequence, and a one-step plan
     has no progress worth drawing. Render the slot either way so the card's
     two-column grid doesn't reflow as the rail comes and goes. */
  if (activeIndex < 0 || steps.length < 2) return <div className="onboarding-rail-slot" />

  return (
    <div className="onboarding-rail-slot">
      <nav aria-label="Setup progress">
        {/* The marker is a SIBLING of the <ol>, not a child of it. An <ol> may
            only contain <li> (plus script-supporting elements), and putting a
            <span> in there also shifted every :first-child match by one — so
            the first step stopped being :first-child and grew a connector
            segment above it, pointing at nothing. */}
        <div className="onboarding-rail-track">
          {/* Decorative: the <li>s carry the real state, including
              aria-current, so this is the visual half only. Held back until it
              has been measured, so it cannot flash at the top on first paint. */}
          {markerY === null ? null : (
            <span
              className="onboarding-rail-marker"
              aria-hidden="true"
              /* Position set inline, EASED IN CSS. Deliberately not a framer
                 animate: the rest of this rail is CSS for exactly one reason —
                 base.css's blanket prefers-reduced-motion block collapses
                 every transition to 0.01ms, so anything expressed as a CSS
                 transition honours that setting without a MotionConfig in the
                 loop. The travel is the whole point of this element, so it is
                 the last thing that should need a second mechanism to respect
                 someone's motion preference. */
              style={{ transform: `translateY(${markerY}px)` }}
            />
          )}
          <ol className="onboarding-rail" ref={listRef}>
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
        </div>
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
