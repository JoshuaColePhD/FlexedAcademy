import { useQuery } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { AudioLines } from 'lucide-react'
import { api } from '../lib/api'
import { qk } from '../lib/queryKeys'
import { useActiveClass, useCalendar } from '../hooks/useAppData'
import { shortRange } from '../lib/dates'
import { firstUnplanned } from '../lib/queue'

/* The empty state. A greeting and a place to start — the shape everyone already
 * knows — with the flare coming from what this app knows that a chat client
 * doesn't.
 *
 * The first suggestion is calendar-aware: it names the next week that actually
 * needs planning, with its real dates, straight from school_calendar.md. That
 * is not a calendar screen, it is the calendar doing its job invisibly — the
 * one click that covers the most common thing a teacher opens this to do.
 *
 * The other two used to be fixed text — "a week on rhetorical analysis",
 * "build around a text" — regardless of anything the teacher had told the app
 * about their own course. If a pacing guide is on file, /api/curriculum_progress
 * already carries a real, LLM-parsed answer to "what's next": the unit, the
 * week label, and whatever texts or milestones the guide named for it (that
 * whole pipeline existed and had zero callers). So when one is on file, these
 * two point at the two nearest weeks the guide says aren't planned yet, instead
 * of at generic filler. No map on file, nothing parsed yet, or nothing left
 * unplanned: falls back to the original generic pair exactly as before — this
 * is additive, not a replacement for the case where there's nothing to add.
 */

function pacingSuggestion(row) {
  const label = row.unit ? `Continue ${row.unit}` : `Continue ${row.week_label}`
  const detail = [row.week_label, row.notes].filter(Boolean).join(' · ') || 'From your pacing guide'
  const prompt =
    `Plan ${row.week_label}${row.unit ? ` — ${row.unit}` : ''}. ` +
    `Follow my pacing guide's sequencing for this week` +
    (row.notes ? `: ${row.notes}.` : '.')
  return { label, detail, prompt }
}

function hourGreeting() {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

export function Greeting({ onPick, onDraft, onOpenVoice, className: courseName }) {
  const { classId } = useParams()
  const { activeClass } = useActiveClass()
  const { data: me } = useQuery({ queryKey: qk.me, queryFn: () => api.me() })
  const { data: calendar } = useCalendar(classId)
  const subject = activeClass?.subject
  const { data: progress } = useQuery({
    queryKey: ['curriculumProgress', subject],
    queryFn: () => api.getCurriculumProgress(subject),
    enabled: !!subject,
    // A pacing guide is uploaded once and read for a semester — no reason to
    // refetch it every time a teacher lands back on an empty chat.
    staleTime: 5 * 60_000,
  })

  const next = firstUnplanned(calendar?.weeks)
  const firstName = (me?.name || '').trim().split(/\s+/)[0]

  // Ordered by sort_order already (db.list_curriculum_progress) — the first
  // two not-yet-planned rows are "what's next" and "what's after that".
  const upcoming = (progress?.weeks ?? []).filter((w) => !w.has_plan)
  const fromGuide = upcoming.slice(0, 2).map(pacingSuggestion)
  // A unit commonly spans more than one week, so both suggestions can read
  // "Continue Unit 2" with nothing but a much smaller detail line telling them
  // apart — reads as a duplicated/broken row. Disambiguate the second by its
  // own week label when that happens.
  if (fromGuide.length === 2 && fromGuide[0].label === fromGuide[1].label) {
    fromGuide[1] = { ...fromGuide[1], label: `${fromGuide[1].label} (${upcoming[1].week_label})` }
  }

  const GENERIC = [
    {
      label: 'A week on rhetorical analysis',
      detail: 'Five days, built around one skill',
      prompt: 'Plan a week on rhetorical analysis — five days building toward a timed write.',
    },
    {
      label: 'Build around a text',
      detail: 'Name the book and it plans the week on it',
      prompt: 'Plan a week around a text — I\'ll name it: ',
      /* The prompt is deliberately unfinished, so it goes into the composer for
         the teacher to complete rather than straight to the model. It used to
         submit on click: a suggestion whose own detail line says "Name the
         book" started a 30-second generation with no book named. */
      draft: true,
    },
  ]

  const suggestions = [
    next && {
      label: `Plan Week ${next.week}`,
      detail: `${shortRange(next.start, next.end)}${next.notes ? ` · ${next.notes}` : ''}`,
      prompt: `Plan Week ${String(next.week).padStart(2, '0')} — ${shortRange(next.start, next.end)}.${
        next.notes ? ` Calendar note: ${next.notes}.` : ''
      }`,
    },
    // Pad back up to two with the generic pair if the guide has fewer than two
    // unplanned weeks left (or there's no guide at all) — three suggestions
    // either way, never a shorter list because a teacher is nearly done.
    ...[...fromGuide, ...GENERIC].slice(0, 2),
  ].filter(Boolean)

  return (
    <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto px-gutter py-8">
      <div className="w-full max-w-measure">
        <h1 className="text-2xl font-semibold tracking-display text-ink">
          {hourGreeting()}
          {firstName ? `, ${firstName}` : ''}
        </h1>
        <p className="mt-1.5 text-sm text-ink-muted">
          Say what you need and I’ll build the week
          {courseName ? ` for ${courseName}` : ''} — standards quoted from the source, in the
          district template.
        </p>

        <ul className="mt-6 flex flex-col gap-1.5">
          {suggestions.map((s, i) => (
            // Index, not s.label: two pacing-guide suggestions can still land
            // on the same unit name even after the disambiguation above (e.g.
            // no week_label at all), and a duplicate key is a React error, not
            // just a cosmetic one.
            <li key={i}>
              <button
                type="button"
                onClick={() => (s.draft && onDraft ? onDraft(s.prompt) : onPick(s.prompt))}
                className="group flex min-h-touch w-full items-baseline gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-paper-sunken"
              >
                <span className="text-sm font-medium text-ink">{s.label}</span>
                {/* --ink-muted, not --ink-faint: this is the week's actual dates
                    or a real pacing-guide note, not decoration — --ink-faint
                    reads under 3:1 against --paper in light mode, well short of
                    the 4.5:1 small text needs. */}
                <span className="min-w-0 flex-1 truncate font-mono text-2xs tabular-nums text-ink-muted">
                  {s.detail}
                </span>
                <span
                  aria-hidden="true"
                  className="shrink-0 text-xs text-ink-faint opacity-0 transition-opacity group-hover:opacity-100"
                >
                  ↵
                </span>
              </button>
            </li>
          ))}
        </ul>

        {/* Phone only — on a desktop the composer's own waveform icon sits
            right there next to Send; on a phone it's a small icon buried at
            the end of the dock, easy to never notice. Opens the same live
            voice conversation (VoiceModePanel) that icon does, just given
            the room to be found.

            voice-neo + neo-raised, same as every surface INSIDE the panel
            this opens — the button is the doorway to that world, so it
            should already look like it. Applied to the button itself, not
            a wrapping div: .voice-neo sets its own background, so the
            button reads as a floating embossed pill regardless of the
            (unstyled, ordinary) page behind it, with no seam to manage. */}
        {onOpenVoice ? (
          <button
            type="button"
            onClick={onOpenVoice}
            className="voice-neo neo-raised mx-auto mt-4 flex min-h-touch w-2/3 items-center justify-center gap-2.5 rounded-full px-8 py-3 text-sm font-medium text-accent-text md:hidden"
          >
            <AudioLines size={18} aria-hidden="true" />
            Chat
          </button>
        ) : null}
      </div>
    </div>
  )
}
