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

function PlanDayCard({ day, index, groundedCodes }) {
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
          <CitedText text={day.standards} groundedCodes={groundedCodes} />
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
                    <CitedText text={day[key]} groundedCodes={groundedCodes} />
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

export function PlanDayCards({ plan, groundedCodes, missingDays }) {
  const days = orderedDays(plan, missingDays)
  const [active, setActive] = useState(() => initialDayIndex(days, TODAY_NAME))
  const scrollerRef = useRef(null)
  const syncing = useRef(false)

  const goTo = useCallback((i) => {
    const el = scrollerRef.current
    if (!el) return
    syncing.current = true
    setActive(i)
    el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' })
    // Let the smooth scroll finish before onScroll is allowed to fight it.
    setTimeout(() => {
      syncing.current = false
    }, 400)
  }, [])

  // Open on the right day without animating there from Monday.
  useEffect(() => {
    const el = scrollerRef.current
    if (el) el.scrollLeft = active * el.clientWidth
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onScroll = () => {
    if (syncing.current) return
    const el = scrollerRef.current
    if (!el?.clientWidth) return
    const i = Math.round(el.scrollLeft / el.clientWidth)
    if (i !== active) setActive(i)
  }

  return (
    <div className="plan-deck">
      <div className="plan-deck-tabs" role="tablist" aria-label="Days this week">
        {days.map((d, i) => {
          const state = dayState(d)
          return (
            <button
              key={d.name}
              type="button"
              role="tab"
              aria-selected={i === active}
              aria-label={d.name}
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

      <div className="plan-deck-scroller" ref={scrollerRef} onScroll={onScroll}>
        {days.map((d, i) => (
          <PlanDayCard key={d.name} day={d} index={i} groundedCodes={groundedCodes} />
        ))}
      </div>
    </div>
  )
}
