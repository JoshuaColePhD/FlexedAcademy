import { useRef } from 'react'
import { Link } from 'react-router-dom'
import { X } from 'lucide-react'
import { useExitTransition } from '../hooks/useExitTransition'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { ClassSwitcher } from './ClassSwitcher'
import { WeekPicker } from './WeekPicker'

/* Phone-only. The old header row (ClassSwitcher, a pacing-guide dot, a
 * calendar dot, WeekPicker, all inline) doesn't fit a phone width without
 * everything shrinking to unreadable — this is that same set of controls,
 * given a full-width sheet to breathe in instead, opened by tapping the
 * collapsed title ChatPage now shows on phone in that row's place. Desktop
 * is unchanged; this component isn't rendered there at all.
 */
export function ChatHeaderSheet({
  open,
  onClose,
  classes,
  activeClass,
  classId,
  hasPacingGuide,
  calendar,
  weekOptions,
  conversationWeek,
  changeWeek,
  busy,
}) {
  const { mounted, closing } = useExitTransition(open, 180)
  const sheetRef = useRef(null)
  useFocusTrap(sheetRef, { active: mounted, trap: true, initialFocus: sheetRef, onEscape: onClose })

  if (!mounted) return null
  const classPath = `/c/${classId}`

  return (
    <>
      <button
        type="button"
        className={`panel-scrim${closing ? ' is-closing' : ''}`}
        aria-label="Close"
        onClick={onClose}
      />
      <div
        ref={sheetRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Class and week"
        className={`chat-header-sheet${closing ? ' is-closing' : ''}`}
      >
        <div className="mb-3 flex items-center justify-between">
          <p className="eyebrow">Class &amp; week</p>
          <button type="button" className="btn-icon tap-target" aria-label="Close" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="flex flex-col gap-3">
          <ClassSwitcher classes={classes} activeClass={activeClass} classPath={classPath} />

          {classId && classId !== 'default' && classes.length > 0 ? (
            <WeekPicker
              options={weekOptions}
              value={conversationWeek}
              onChange={(week) => {
                changeWeek(week)
                onClose()
              }}
              schoolName={calendar?.school?.name}
              disabled={busy}
            />
          ) : null}

          {!hasPacingGuide ? (
            <Link
              to={`/c/${classId}/class#section-docs`}
              onClick={onClose}
              className="fa-press text-sm font-medium text-accent-text underline-offset-2 hover:underline"
            >
              No pacing guide on file — tap to upload one
            </Link>
          ) : null}

          {calendar?.school?.name ? (
            !calendar.school.has_calendar ? (
              <Link
                to={`/c/${classId}/settings#section-school-calendar`}
                onClick={onClose}
                className="fa-press text-sm font-medium text-accent-text underline-offset-2 hover:underline"
              >
                No calendar on file for {calendar.school.name} — tap to upload one
              </Link>
            ) : (
              <p className="text-sm text-ink-muted">{calendar.school.name}</p>
            )
          ) : null}
        </div>
      </div>
    </>
  )
}
