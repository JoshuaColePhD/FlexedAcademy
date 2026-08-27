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
 * screen waiting for whatever they type. The text stays un-prefilled — the
 * composer's own ghost text is where a real week/topic suggestion lives now.
 *
 * What removing them cost, and what `week` below puts back: this screen said
 * "I'll build THE week" without ever saying which one, while ChatPage had
 * already silently resolved it (effectiveWeek — the next unplanned week,
 * unless a ?week= param overrode it). The teacher found that out from the
 * finished document, thirty seconds later. Naming it in the sentence that
 * was already there is not a suggestion — it's the existing copy being
 * honest about what is about to happen.
 *
 * `hint` is the one exception to "nothing here is clickable": an
 * action: 'open-settings' suggestion (add-pacing-guide, add-school-calendar)
 * isn't a sentence to type or send, so it has no ghost-text/card form the
 * composer could use — this is its only surface, and only in the empty
 * state this component is already scoped to.
 */

function hourGreeting() {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

export function Greeting({ onOpenVoice, className: courseName, week, hint, onOpenSettings }) {
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
    // Phone got the same vertical centering as desktop, in a column with far
    // less content (no Voice Mode button on desktop) — the result was the
    // greeting and CTA marooned in the middle of a mostly-empty screen,
    // below a header a teacher had to scroll past to reach anything.
    // items-start (not place-items-center) on phone puts it near the top
    // instead; md:items-center restores the original centered layout once
    // there's enough height for it to read as intentional rather than lost.
    <div className="grid min-h-0 flex-1 items-start justify-items-center overflow-y-auto px-gutter pb-4 pt-10 md:items-center md:pt-4">
      <div className="w-full max-w-measure flex flex-col items-center justify-center text-center fa-rise">
        
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-ink mb-2">
          {hourGreeting()}
          {firstName ? `, ${firstName}` : ''}
        </h1>
        
        <p className="max-w-xl text-sm sm:text-base text-ink-muted leading-relaxed">
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

        {/* add-pacing-guide / add-school-calendar — not a chat message, so
         * it never belonged in the composer as ghost text or a card (there's
         * no sentence to type or send for "go upload a file"). Only shown
         * here, in the empty state Greeting itself is scoped to — once a
         * conversation starts, the composer's own suggestions take over. */}
        {hint ? (
          <button
            type="button"
            onClick={() => onOpenSettings?.(hint)}
            className="fa-press mt-3 max-w-xl text-sm font-medium text-accent-text underline-offset-2 hover:underline"
          >
            {hint.label}
            {hint.reason ? ` — ${hint.reason}` : ''}
          </button>
        ) : null}

        {onOpenVoice ? (
          <button
            type="button"
            onClick={onOpenVoice}
            className="neo-world neo-raised bg-paper-raised mx-auto mt-8 flex min-h-touch w-2/3 max-w-[240px] items-center justify-center gap-2.5 rounded-full px-8 py-3 text-sm font-medium text-ink md:hidden"
          >
            <AudioLines size={18} aria-hidden="true" />
            Voice Mode
          </button>
        ) : null}
      </div>
    </div>
  )
}
