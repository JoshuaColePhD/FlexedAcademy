import { useCallback, useEffect, useRef, useState } from 'react'
import { SHORT_DAY, dayState, initialDayIndex, orderedDays } from '../lib/planShape'
import { SkeletonText } from './Skeleton'
import { cellKit } from './cellTweakKit'


const FIELDS = [
  ['Learning Target / Essential Questions', 'learning_targets', '#e69138', '#111827'],
  ['Do Now-Bell Ringer', 'do_now', '#f1c232', '#111827'],
  ['Vocabulary', 'vocabulary', '#3d85c6', '#fff'],
  ['I Do/We Do/You Do', 'during', '#3d85c6', '#fff'],
  ['Exit Ticket', 'assessment', '#ff0000', '#fff'],
  ['Reteach/Small Groups', 'reteach_small_groups', '#8e7cc3', '#fff'],
  ['Cross-Curriculum Connection', 'cross_curricular_connection', '#00ff00', '#111827'],
]

function Field({ label, field, dayName, dayIndex, kit, color, textColor, children }) {
  const isEditing = kit?.isOpen(dayIndex, field)
  const editableProps = kit ? kit.editableProps(dayIndex, field) : { className: undefined }
  return (
    <section className="weeden-day-field" style={{ '--weeden-label': color, '--weeden-text': textColor }}>
      <h3>{label}</h3>
      <div {...(isEditing ? {} : editableProps)} className={editableProps.className}>
        {isEditing ? kit.tweakBody(dayIndex, field, dayName) : (
          <>
            {kit.workingLabel?.(dayIndex, field)}
            {children}
          </>
        )}
      </div>
    </section>
  )
}

function DayCard({ day, index, kit }) {
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
      {day.standards || kit ? (
        <Field label="Standard / DOK" field="standards" dayName={day.name} dayIndex={index} kit={kit} color="#e06666" textColor="#fff">
          <p>{day.standards || 'Tap to add'}</p>
        </Field>
      ) : null}
      {FIELDS.map(([label, field, color, textColor]) => (
        day[field] || kit ? (
          <Field key={field} label={label} field={field} dayName={day.name} dayIndex={index} kit={kit} color={color} textColor={textColor}>
            <p>{day[field] || 'Tap to add'}</p>
          </Field>
        ) : null
      ))}
    </article>
  )
}

/** The Weeden document, deliberately reshaped for a phone rather than shrunk. */
export function WeedenPlanDayCards({
  plan,
  missingDays,
  onReviseDay,
  onEditDay,
  busy,
  flashCells,
  workingCells,
  openTweak,
  setOpenTweak,
}) {
  const days = orderedDays(plan, missingDays)
  const [draft, setDraft] = useState('')
  const canTweak = Boolean(onEditDay || onReviseDay)
  const openCell = (dayIndex, field) => {
    if (!canTweak) return
    const current = days[dayIndex]?.[field]
    setDraft(Array.isArray(current) ? current.join('\n') : String(current || ''))
    setOpenTweak?.({ dayIndex, field })
  }
  const applyEdit = (nextContent = draft) => {
    const content = String(nextContent || '').trim()
    if (!content || !openTweak) return
    const { dayIndex, field } = openTweak
    if (onEditDay) onEditDay(dayIndex, days[dayIndex], field, content)
    else onReviseDay?.(dayIndex, days[dayIndex], content, field)
    setDraft('')
    setOpenTweak?.(null)
  }
  const kit = canTweak ? cellKit({
    flashCells,
    workingCells,
    canTweak: canTweak && !busy,
    openTweak,
    openCell,
    applyTweak: applyEdit,
    draft,
  }) : null
  const [active, setActive] = useState(() => initialDayIndex(days, plan.week_of))
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
    <div className="plan-deck">
      <p className="weeden-week-label">{plan.course} · {plan.week_of}</p>
      <div className="plan-deck-tabs" role="group" aria-label="Jump to a day">
        {days.map((day, i) => <button key={day.name} type="button" aria-current={i === active ? 'true' : undefined} onClick={() => goTo(i)} className={`plan-deck-tab ${i === active ? 'is-active' : ''} ${dayState(day) === 'no_school' ? 'is-closed' : ''}`}>{SHORT_DAY[day.name]}</button>)}
      </div>
      <div className="plan-deck-scroller" ref={scrollerRef} onScroll={onScroll} tabIndex={0} role="region" aria-label="Weeden lesson plan, one day per card — scrolls sideways">
        {days.map((day, i) => <DayCard key={day.name} day={day} index={i} kit={kit} />)}
      </div>
    </div>
  )
}
