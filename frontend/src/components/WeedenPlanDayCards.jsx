import { useCallback, useEffect, useRef, useState } from 'react'
import { SHORT_DAY, dayState, initialDayIndex, orderedDays } from '../lib/planShape'
import { SkeletonText } from './Skeleton'

const TODAY_NAME = new Date().toLocaleDateString('en-US', { weekday: 'long' })

// This is the reading order for a phone, not the print-row order. The colors
// and labels keep the school form recognisable while one day remains readable
// without horizontally panning across a six-column table.
const FIELDS = [
  ['Learning Target / Essential Questions', 'learning_targets', '#e69138', '#111827'],
  ['Do Now-Bell Ringer', 'do_now', '#f1c232', '#111827'],
  ['Vocabulary', 'vocabulary', '#3d85c6', '#fff'],
  ['I Do/We Do/You Do', 'during', '#3d85c6', '#fff'],
  ['Exit Ticket', 'assessment', '#ff0000', '#fff'],
  ['Reteach/Small Groups', 'reteach_small_groups', '#8e7cc3', '#fff'],
  ['Cross-Curriculum Connection', 'cross_curricular_connection', '#00ff00', '#111827'],
]

function DayCard({ day, index }) {
  const state = dayState(day)
  if (state !== 'ok') {
    return (
      <article className="weeden-day-card" aria-label={day.name}>
        <header className="weeden-day-card-head"><span>{day.name}</span><span>{index + 1} of 5</span></header>
        <div className="grid flex-1 place-items-center py-10 text-center">
          {state === 'pending' ? <SkeletonText lines={4} /> : <p className="text-sm text-ink-muted">{state === 'no_school' ? 'No School' : 'This day didn’t finish generating.'}</p>}
        </div>
      </article>
    )
  }
  return (
    <article className="weeden-day-card" aria-label={day.name}>
      <header className="weeden-day-card-head"><span>{day.name}</span><span>{index + 1} of 5</span></header>
      {day.standards ? <section className="weeden-day-field weeden-standard"><h3>Standard / DOK</h3><p>{day.standards}</p></section> : null}
      {FIELDS.map(([label, field, color, textColor]) => day[field] ? (
        <section className="weeden-day-field" key={field} style={{ '--weeden-label': color, '--weeden-text': textColor }}>
          <h3>{label}</h3><p>{day[field]}</p>
        </section>
      ) : null)}
    </article>
  )
}

/** The Weeden document, deliberately reshaped for a phone rather than shrunk. */
export function WeedenPlanDayCards({ plan, missingDays }) {
  const days = orderedDays(plan, missingDays)
  const [active, setActive] = useState(() => initialDayIndex(days, TODAY_NAME))
  const scrollerRef = useRef(null)
  const syncing = useRef(false)
  const offsetOf = (el, i) => el.children[i]?.offsetLeft ?? i * el.clientWidth
  const goTo = useCallback((i) => {
    const el = scrollerRef.current
    if (!el) return
    syncing.current = true
    setActive(i)
    el.scrollTo({ left: offsetOf(el, i), behavior: 'smooth' })
    setTimeout(() => { syncing.current = false }, 400)
  }, [])
  useEffect(() => {
    const el = scrollerRef.current
    if (el) el.scrollLeft = offsetOf(el, active)
    // Initial placement only; user navigation controls the state afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const onScroll = () => {
    const el = scrollerRef.current
    if (syncing.current || !el?.clientWidth) return
    let nearest = 0
    let best = Infinity
    for (let i = 0; i < el.children.length; i += 1) {
      const distance = Math.abs((el.children[i].offsetLeft || 0) - el.scrollLeft)
      if (distance < best) { best = distance; nearest = i }
    }
    if (nearest !== active) setActive(nearest)
  }
  return (
    <div className="plan-deck weeden-plan-deck">
      <p className="weeden-week-label">{plan.course} · {plan.week_of}</p>
      <div className="plan-deck-tabs" role="group" aria-label="Jump to a day">
        {days.map((day, i) => <button key={day.name} type="button" aria-current={i === active ? 'true' : undefined} onClick={() => goTo(i)} className={`plan-deck-tab ${i === active ? 'is-active' : ''} ${dayState(day) === 'no_school' ? 'is-closed' : ''}`}>{SHORT_DAY[day.name]}</button>)}
      </div>
      <div className="plan-deck-scroller" ref={scrollerRef} onScroll={onScroll} tabIndex={0} role="region" aria-label="Weeden lesson plan, one day per card — scrolls sideways">
        {days.map((day, i) => <DayCard key={day.name} day={day} index={i} />)}
      </div>
    </div>
  )
}
