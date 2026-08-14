import { useCallback, useEffect, useRef, useState } from 'react'
import { CitedText } from './Citation'
import { SkeletonText } from './Skeleton'
import {
  CARD_SECONDARY,
  LESSON_PARTS,
  SHORT_DAY,
  dayState,
  initialDayIndex,
  orderedDays,
} from '../lib/planShape'

/* The plan, on a phone.
 *
 * The desktop table keeps min-width: 860px and is not touched — that table
 * mirrors the .docx, and compromising it to reach a phone would break the one
 * promise the product makes. This is a second view over the same data, and only
 * ever ONE of them is in the DOM: rendering both and hiding one with CSS makes a
 * screen reader read the whole week twice.
 *
 * One card per screen, driven by CSS scroll-snap. No gesture library and no JS
 * animation — the browser already does this, and the day tabs and the swipe end
 * up controlling the same scrollLeft, so they cannot disagree about which day
 * is showing.
 */

const TODAY_NAME = new Date().toLocaleDateString('en-US', { weekday: 'long' })

function Field({ label, children }) {
  return (
    <div className="plan-field">
      <span className="eyebrow">{label}</span>
      <div className="text-sm leading-relaxed text-ink">{children}</div>
    </div>
  )
}

function PlanDayCard({ day, index, groundedCodes, subject }) {
  const state = dayState(day)

  if (state !== 'ok') {
    return (
      <article className="plan-day-card" aria-label={day.name}>
        <header className="plan-day-card-head">
          <span>{day.name}</span>
          <span className="font-mono text-2xs tabular-nums opacity-80">{index + 1} of 5</span>
        </header>
        <div className="grid flex-1 place-items-center py-10 text-center">
          {state === 'pending' ? (
            <div className="w-full px-2">
              <SkeletonText lines={4} />
            </div>
          ) : (
            <p className="text-sm text-ink-muted">
              {state === 'no_school' ? 'No School' : 'This day didn’t finish generating.'}
            </p>
          )}
        </div>
      </article>
    )
  }

  return (
    <article className="plan-day-card" aria-label={day.name}>
      <header className="plan-day-card-head">
        <span>{day.name}</span>
        <span className="font-mono text-2xs tabular-nums opacity-80">{index + 1} of 5</span>
      </header>

      {day.learning_targets ? (
        <Field label="Learning target">{day.learning_targets}</Field>
      ) : null}

      {/* The lesson leads. The table renders it fifth; that is the document's
          order, not a teacher's. See CARD_SECONDARY in lib/planShape.js. */}
      {LESSON_PARTS.map(([label, key]) =>
        day[key] ? (
          <Field key={key} label={label}>
            {day[key]}
          </Field>
        ) : null
      )}

      {day.standards ? (
        <Field label="Standards">
          <CitedText text={day.standards} groundedCodes={groundedCodes} subject={subject} />
        </Field>
      ) : null}

      {CARD_SECONDARY.some(({ key }) => day[key]) ? (
        <details>
          <summary>ACT alignment &amp; engagement</summary>
          <div className="flex flex-col gap-3 pt-3">
            {CARD_SECONDARY.map(({ label, key, cited }) =>
              day[key] ? (
                <Field key={key} label={label}>
                  {cited ? (
                    <CitedText text={day[key]} groundedCodes={groundedCodes} subject={subject} />
                  ) : (
                    day[key]
                  )}
                </Field>
              ) : null
            )}
          </div>
        </details>
      ) : null}
    </article>
  )
}

export function PlanDayCards({ plan, subject, groundedCodes, missingDays }) {
  const days = orderedDays(plan, missingDays)
  const [active, setActive] = useState(() => initialDayIndex(days, TODAY_NAME))
  const scrollerRef = useRef(null)
  const syncing = useRef(false)

  /* Read the card's ACTUAL offset instead of computing i * clientWidth.
     The scroller is a grid with `gap: var(--sp-3)`, so card i actually starts
     at i * (clientWidth + 12) — the arithmetic version landed 48px short on
     Friday and scroll-snap yanked it into place, which is the visible jump on
     open and the mis-targeted animation when tapping a day. */
  const offsetOf = (el, i) => el.children[i]?.offsetLeft ?? i * el.clientWidth

  const goTo = useCallback((i) => {
    const el = scrollerRef.current
    if (!el) return
    syncing.current = true
    setActive(i)
    el.scrollTo({ left: offsetOf(el, i), behavior: 'smooth' })
    // Let the smooth scroll finish before onScroll is allowed to fight it.
    setTimeout(() => {
      syncing.current = false
    }, 400)
  }, [])

  // Open on the right day without animating there from Monday.
  useEffect(() => {
    const el = scrollerRef.current
    if (el) el.scrollLeft = offsetOf(el, active)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onScroll = () => {
    if (syncing.current) return
    const el = scrollerRef.current
    if (!el?.clientWidth) return
    // Nearest card by real offset, for the same reason as above.
    let nearest = 0
    let best = Infinity
    for (let i = 0; i < el.children.length; i += 1) {
      const d = Math.abs((el.children[i].offsetLeft || 0) - el.scrollLeft)
      if (d < best) {
        best = d
        nearest = i
      }
    }
    if (nearest !== active) setActive(nearest)
  }

  return (
    <div className="plan-deck">
      {/* A GROUP of buttons, not a tablist.
          It declared role="tablist"/role="tab" with no aria-controls, no
          tabpanel, no roving tabIndex and no arrow keys — and all five cards
          are in the accessibility tree at once, so "selected" meant nothing to
          a screen reader: it read the whole week regardless. These scroll a
          scroller, which is what a button does. */}
      <div className="plan-deck-tabs" role="group" aria-label="Jump to a day">
        {days.map((d, i) => {
          const state = dayState(d)
          return (
            <button
              key={d.name}
              type="button"
              aria-current={i === active ? 'true' : undefined}
              // The closed state was carried by a hatch pattern alone.
              aria-label={state === 'no_school' ? `${d.name} — no school` : d.name}
              onClick={() => goTo(i)}
              className={`plan-deck-tab ${i === active ? 'is-active' : ''} ${
                state === 'no_school' ? 'is-closed' : ''
              }`}
            >
              {SHORT_DAY[d.name]}
            </button>
          )
        })}
      </div>

      {/* tabIndex + role + label, as .plan-table-scroll and .doc-body already
          have: a scroll region that only answers to a pointer drag is a
          keyboard-access failure (WCAG 2.1.1). */}
      <div
        className="plan-deck-scroller"
        ref={scrollerRef}
        onScroll={onScroll}
        tabIndex={0}
        role="region"
        aria-label="The week, one day per card — scrolls sideways"
      >
        {days.map((d, i) => (
          <PlanDayCard key={d.name} day={d} index={i} groundedCodes={groundedCodes} subject={subject} />
        ))}
      </div>
    </div>
  )
}
