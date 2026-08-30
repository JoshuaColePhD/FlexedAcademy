import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, ChevronDown, ChevronUp, FileText, Loader2 } from 'lucide-react'
import { DAYS, SHORT_DAY, dayTitle } from '../lib/planShape'

/* The generation status belongs above the composer because the composer is
 * the one surface that remains reachable while the transcript grows, the
 * document opens, or the teacher scrolls. It is deliberately a vertical list
 * at every breakpoint: the list grows upward from the input, and the active
 * row can advance without changing the page's overall layout. */
export function LessonPlanProgressTray({ days, onStop }) {
  const [collapsed, setCollapsed] = useState(false)
  const byName = new Map((days || []).map((day) => [day.name, day]))
  const writtenCount = DAYS.filter((name) => byName.has(name)).length
  const nextName = DAYS.find((name) => !byName.has(name))
  const complete = writtenCount === DAYS.length
  const status = complete
    ? 'Formatting and saving…'
    : nextName
      ? `Writing ${nextName}`
      : 'Getting your week ready…'
  const countLabel = `${writtenCount} of ${DAYS.length} days complete`

  return (
    <div className="lesson-plan-progress-tray">
      <p className="visually-hidden" role="status" aria-live="polite">
        {status}. {countLabel}.
      </p>
      <AnimatePresence initial={false} mode="wait">
        {collapsed ? (
          <motion.button
            key="collapsed"
            type="button"
            className="lesson-plan-progress-collapsed fa-press"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            onClick={() => setCollapsed(false)}
            aria-label={`Expand lesson plan progress: ${status}`}
          >
            <span className="lesson-plan-progress-pulse" aria-hidden="true"><Loader2 size={14} /></span>
            <span className="min-w-0 flex-1 truncate text-left">{status}</span>
            <span className="shrink-0 text-ink-faint">{writtenCount}/{DAYS.length}</span>
            <ChevronUp size={15} aria-hidden="true" />
          </motion.button>
        ) : (
          <motion.section
            key="expanded"
            className="lesson-plan-progress-expanded"
            initial={{ opacity: 0, height: 0, y: 12 }}
            animate={{ opacity: 1, height: 'auto', y: 0 }}
            exit={{ opacity: 0, height: 0, y: 12 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            aria-label="Lesson plan generation progress"
            aria-busy="true"
          >
            <div className="lesson-plan-progress-header">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="lesson-plan-progress-icon" aria-hidden="true">
                  <FileText size={15} />
                </span>
                <div className="min-w-0">
                  <p className="m-0 truncate text-sm font-semibold text-ink">Building your lesson plan</p>
                  <p className="m-0 truncate text-xs text-ink-muted">{status}</p>
                </div>
              </div>
              <button
                type="button"
                className="btn-icon shrink-0"
                onClick={() => setCollapsed(true)}
                aria-label="Minimize lesson plan progress"
                title="Minimize progress"
              >
                <ChevronDown size={16} aria-hidden="true" />
              </button>
            </div>

            <motion.ul layout className="lesson-plan-progress-list" aria-label={`${status}. ${countLabel}`}>
              <AnimatePresence initial={false}>
                {DAYS.map((name) => {
                  const day = byName.get(name)
                  const isWriting = !day && name === nextName && !complete
                  const state = day ? 'complete' : isWriting ? 'writing' : 'pending'
                  const title = dayTitle(day)
                  return (
                    <motion.li
                      layout
                      key={`${name}-${state}`}
                      className={`lesson-plan-progress-row is-${state}`}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                    >
                      <span className={`lesson-plan-progress-status${state === 'writing' ? ' fa-progress-sweep' : ''}`} aria-hidden="true">
                        {state === 'complete' ? <Check size={14} className="fa-pop" /> : null}
                        {state === 'writing' ? <Loader2 size={14} className="animate-spin" /> : null}
                        {state === 'pending' ? SHORT_DAY[name].slice(0, 2).toUpperCase() : null}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
                      <span className="min-w-0 truncate text-xs">
                        {state === 'complete' ? (day?.no_school ? 'No school' : title || 'Complete') : null}
                        {state === 'writing' ? 'Writing now…' : null}
                        {state === 'pending' ? 'Waiting' : null}
                      </span>
                    </motion.li>
                  )
                })}
              </AnimatePresence>
            </motion.ul>

            <div className="lesson-plan-progress-footer">
              <span>{countLabel}</span>
              {onStop ? (
                <button type="button" className="lesson-plan-progress-stop fa-press" onClick={onStop}>
                  <span className="lesson-plan-progress-stop-icon" aria-hidden="true"><span /></span>
                  Stop
                </button>
              ) : null}
            </div>
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  )
}
