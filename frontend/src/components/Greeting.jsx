import { useQuery } from '@tanstack/react-query'
import { AudioLines } from 'lucide-react'
import { api } from '../lib/api'
import { qk } from '../lib/queryKeys'
import { shortRange } from '../lib/dates'

/* The empty state. A greeting and a place to start — the shape everyone
 * already knows. It used to also carry three clickable suggestions (a
 * calendar-aware "Plan Week N", plus two pulled from the pacing guide or a
 * generic fallback pair) — removed because the teacher didn't want a new chat
 * opening with a wall of pre-filled options; it should just be an empty
 * screen waiting for whatever they type. That still stands: nothing here is
 * clickable or pre-filled.
 *
 * What removing them cost, and what `week` below puts back: this screen said
 * "I'll build THE week" without ever saying which one, while ChatPage had
 * already silently resolved it (effectiveWeek — the next unplanned week,
 * unless a ?week= param overrode it). The teacher found that out from the
 * finished document, thirty seconds later. Naming it in the sentence that
 * was already there is not a suggestion — it's the existing copy being
 * honest about what is about to happen.
 */

function hourGreeting() {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

export function Greeting({ onOpenVoice, className: courseName, week }) {
  const { data: me } = useQuery({ queryKey: qk.me, queryFn: () => api.me() })
  const firstName = (me?.name || '').trim().split(/\s+/)[0]

  // Padded to match how every other surface writes a week ("Week 03", see
  // ClassPage's own board). Falls back to the original vague "the week"
  // whenever the calendar hasn't loaded or has nothing left to plan —
  // naming a week this can't actually be sure of would be worse than the
  // vagueness it replaces.
  const range = week ? shortRange(week.start, week.end) : ''
  const weekLabel = week
    ? `Week ${String(week.week).padStart(2, '0')}${range ? ` (${range})` : ''}`
    : null

  return (
    <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto px-gutter py-8">
      <div className="w-full max-w-measure">
        <h1 className="text-2xl font-semibold tracking-display text-ink">
          {hourGreeting()}
          {firstName ? `, ${firstName}` : ''}
        </h1>
        <p className="mt-1.5 text-sm text-ink-muted">
          Say what you need and I’ll build{' '}
          {weekLabel ? <span className="font-medium text-ink">{weekLabel}</span> : 'the week'}
          {courseName ? ` for ${courseName}` : ''}. Standards are quoted straight from the source,
          formatted in the district template.
        </p>

        {/* Phone only — on a desktop the composer's own waveform icon sits
            right there next to Send; on a phone it's a small icon buried at
            the end of the dock, easy to never notice. Opens the same live
            voice conversation (VoiceModePanel) that icon does, just given
            the room to be found.

            neo-world + neo-raised, same as every surface INSIDE the panel
            this opens — the button is the doorway to that world, so it
            should already look like it. Applied to the button itself, not
            a wrapping div: .neo-world sets its own background, so the
            button reads as a floating embossed pill regardless of the
            (unstyled, ordinary) page behind it, with no seam to manage. */}
        {onOpenVoice ? (
          <button
            type="button"
            onClick={onOpenVoice}
            className="neo-world neo-raised mx-auto mt-4 flex min-h-touch w-2/3 items-center justify-center gap-2.5 rounded-full px-8 py-3 text-sm font-medium text-accent-text md:hidden"
          >
            <AudioLines size={18} aria-hidden="true" />
            Chat
          </button>
        ) : null}
      </div>
    </div>
  )
}
