import { useRef } from 'react'
import { Link } from 'react-router-dom'
import { X } from 'lucide-react'
import { useExitTransition } from '../hooks/useExitTransition'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { ClassSwitcher } from './ClassSwitcher'
import { WeekPicker } from './WeekPicker'

/* Class and week controls shared by the desktop chat header and phone title. */
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
  /* Keyed on `open`, not `mounted`. `mounted` stays true through the 180ms
     exit transition, so trapping on it kept Tab captured inside a sheet that
     was already visually gone — and Escape still bound to a dialog the
     teacher had just dismissed. `open` releases the trap the instant the
     close is requested, which is when the sheet stops being the thing on
     screen; it stays mounted a beat longer purely to play its own exit. */
  useFocusTrap(sheetRef, { active: open, trap: true, initialFocus: sheetRef, onEscape: onClose })

  if (!mounted) return null
  const classPath = `/c/${classId}`

  return (
    <div
      className={`dialog-scrim chat-header-scrim${closing ? ' is-closing' : ''}`}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={sheetRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Class and week"
        className={`chat-header-sheet${closing ? ' is-closing' : ''}`}
      >
        <div className="chat-header-sheet-heading">
          <div>
            <p className="eyebrow">FlexEd Academy</p>
            <h2>Choose your class and week</h2>
            <p className="chat-header-sheet-intro">Set the course context for this conversation.</p>
          </div>
          <button type="button" className="btn-icon tap-target" aria-label="Close" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="chat-header-selection">
          <section className="chat-header-selection-field" aria-labelledby="chat-header-course-label">
            <p id="chat-header-course-label" className="chat-header-selection-label">Course</p>
            <ClassSwitcher classes={classes} activeClass={activeClass} classPath={classPath} fullWidthMenu />
          </section>

          {classId && classId !== 'default' && classes.length > 0 ? (
            <section className="chat-header-selection-field" aria-labelledby="chat-header-week-label">
              <p id="chat-header-week-label" className="chat-header-selection-label">Week</p>
              <WeekPicker
                options={weekOptions}
                value={conversationWeek}
                onChange={(week) => {
                  changeWeek(week)
                  onClose()
                }}
                schoolName={calendar?.school?.name}
                disabled={busy}
                fullWidthMenu
              />
            </section>
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
              <p className="chat-header-sheet-school">{calendar.school.name}</p>
            )
          ) : null}
        </div>
      </div>
    </div>
  )
}
