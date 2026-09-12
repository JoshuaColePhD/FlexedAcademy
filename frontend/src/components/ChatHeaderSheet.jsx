import { useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { X } from 'lucide-react'
import { useExitTransition } from '../hooks/useExitTransition'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { ClassSwitcher } from './ClassSwitcher'
import { WeekPicker } from './WeekPicker'

const POPOVER_WIDTH = 400
const POPOVER_MAX_HEIGHT = 520

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
  variant = 'sheet',
  anchorRef,
}) {
  const { mounted, closing } = useExitTransition(open, 180)
  const sheetRef = useRef(null)
  const [popoverStyle, setPopoverStyle] = useState(null)
  const isPopover = variant === 'popover'
  /* Keyed on `open`, not `mounted`. `mounted` stays true through the 180ms
     exit transition, so trapping on it kept Tab captured inside a sheet that
     was already visually gone — and Escape still bound to a dialog the
     teacher had just dismissed. `open` releases the trap the instant the
     close is requested, which is when the sheet stops being the thing on
     screen; it stays mounted a beat longer purely to play its own exit. */
  useFocusTrap(sheetRef, { active: open, trap: true, initialFocus: sheetRef, onEscape: onClose })

  useLayoutEffect(() => {
    if (!open || !isPopover) {
      setPopoverStyle(null)
      return undefined
    }

    const place = () => {
      const anchor = anchorRef?.current
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      const width = Math.min(POPOVER_WIDTH, window.innerWidth - 24)
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))
      const top = Math.min(rect.bottom + 8, window.innerHeight - 24)
      const maxHeight = Math.min(POPOVER_MAX_HEIGHT, Math.max(280, window.innerHeight - top - 12))
      setPopoverStyle({ top, left, width, maxHeight })
    }

    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, isPopover, anchorRef])

  if (!mounted) return null

  return (
    <div
      className={`dialog-scrim chat-header-scrim${isPopover ? ' chat-header-scrim--popover' : ''}${closing ? ' is-closing' : ''}`}
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
        className={`chat-header-sheet${isPopover ? ' chat-header-sheet--popover' : ''}${closing ? ' is-closing' : ''}`}
        style={isPopover ? popoverStyle || undefined : undefined}
      >
        <div className="chat-header-sheet-heading">
          <div>
            <p className="eyebrow">This conversation</p>
            <h2>Change class or week</h2>
          </div>
          <button type="button" className="btn-icon tap-target" aria-label="Close" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="chat-header-selection">
          <div className="chat-header-selection-split">
            <section className="chat-header-selection-field" aria-labelledby="chat-header-course-label">
              <p id="chat-header-course-label" className="chat-header-selection-label">Course</p>
              <ClassSwitcher
                classes={classes}
                activeClass={activeClass}
                embedded
                onSelect={onClose}
              />
            </section>

            {classId && classId !== 'default' && classes.length > 0 ? (
              <section className="chat-header-selection-field chat-header-week-field" aria-labelledby="chat-header-week-label">
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
                />
              </section>
            ) : null}
          </div>

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
