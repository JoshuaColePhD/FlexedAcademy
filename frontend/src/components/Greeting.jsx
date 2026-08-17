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

export function Greeting({ onOpenVoice, onWarmVoice, className: courseName, week }) {
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
      <div className="w-full max-w-measure flex flex-col items-center justify-center text-center fa-rise">
        
        <div className="mb-8 rounded-3xl bg-gradient-to-br from-primary/10 to-primary/5 p-6 ring-1 ring-inset ring-ink/5 shadow-sm">
          <svg className="h-10 w-10 text-primary opacity-80" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
          </svg>
        </div>

        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-ink mb-4">
          {hourGreeting()}
          {firstName ? `, ${firstName}` : ''}
        </h1>
        
        <p className="max-w-xl text-base sm:text-lg text-ink-muted leading-relaxed">
          Say what you need and I’ll build{' '}
          {weekLabel ? (
            <span className="whitespace-nowrap font-medium text-ink bg-paper-sunken px-2 py-0.5 rounded-md border border-ink/5 shadow-sm">
              {weekLabel}
            </span>
          ) : (
            'the week'
          )}
          {courseName ? ` for ${courseName}` : ''}. Standards are quoted straight from the source,
          formatted directly into your district template.
        </p>

        {onOpenVoice ? (
          <button
            type="button"
            onClick={onOpenVoice}
            onPointerDown={onWarmVoice}
            className="neo-world neo-raised mx-auto mt-8 flex min-h-touch w-2/3 max-w-[240px] items-center justify-center gap-2.5 rounded-full px-8 py-3 text-sm font-medium text-accent-text md:hidden"
          >
            <AudioLines size={18} aria-hidden="true" />
            Voice Mode
          </button>
        ) : null}
      </div>
    </div>
  )
}
