import { Link } from 'react-router-dom'
import { SlidersHorizontal } from 'lucide-react'
import { useAsync } from '../hooks/useAsync'
import { api } from '../lib/api'

/* Ways to start, under the composer.
 *
 * Replaces a stack of full-width bordered cards, each with a trailing arrow —
 * the most generic pattern in the old design, and one that pushed the composer
 * off the bottom of the screen. These are pills: they read as options rather
 * than as content, and they wrap.
 *
 * Each starter's supporting sentence leaves the visible surface and becomes the
 * accessible name, so a screen reader still hears what the pill will do.
 */

const DAY_MS = 86_400_000

/** The Monday after this one — what a teacher planning midweek means by "next
 *  week". */
function nextMonday(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const delta = ((8 - d.getDay()) % 7) || 7
  return new Date(d.getTime() + delta * DAY_MS)
}

const MONTH_DAY = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric' })

function starters({ course, pacingNext }) {
  const subject = course?.trim() || 'my class'
  const monday = MONTH_DAY.format(nextMonday())

  const list = [
    {
      title: `Week of ${monday}`,
      detail: 'Picks up from where your last plan left off.',
      prompt: `Plan the week of ${monday} for ${subject}.`,
    },
    {
      title: 'Start a new unit',
      detail: 'Introduce the anchor text, then build toward the first assessment.',
      prompt: `Plan the first week of a new unit for ${subject}. Monday introduces the anchor text and Thursday is a written assessment.`,
    },
    {
      title: 'Review before a test',
      detail: 'Four days of practice, one day of assessment.',
      prompt: `Plan a review week for ${subject} leading up to a unit test on Friday.`,
    },
  ]

  // The genuinely useful one, offered only when a pacing guide is uploaded and
  // actually lines up with a week.
  if (pacingNext?.week_label) {
    list.unshift({
      title: pacingNext.week_label,
      detail: 'The next week in your pacing guide.',
      prompt: `Plan ${pacingNext.week_label} for ${subject}.`,
      fromPacing: true,
    })
  }

  return list.slice(0, 4)
}

const PILL =
  'rounded-full border border-edge px-3.5 py-1.5 text-[0.8125rem] text-ink-soft transition-colors hover:border-edge-strong hover:bg-paper-sunken hover:text-ink'

export function Starters({ settings, onPick }) {
  const subject = settings?.subject

  const progress = useAsync(
    (signal) => (subject ? api.getCurriculumProgress(subject, { signal }) : Promise.resolve(null)),
    [subject]
  )

  const weeks = progress.data?.weeks || []
  const currentIndex = weeks.findIndex((w) => w.status === 'current')
  const pacingNext =
    currentIndex >= 0 ? weeks[currentIndex + 1] : weeks.find((w) => w.status === 'upcoming')

  const cards = starters({ course: settings?.course, pacingNext })

  /* There is no onboarding screen — a teacher can plan on their first visit with
     the defaults. This is the standing invitation to fix the two details that
     would otherwise come out wrong in the .docx header. It disappears the moment
     both are filled in, so it can't become furniture. */
  const needsSetup = settings && !(settings.teacher?.trim() && settings.course?.trim())

  return (
    <div className="mt-4 flex animate-rise-in flex-wrap justify-center gap-2">
      {needsSetup ? (
        <Link to="/my-class" className={`flex items-center gap-1.5 ${PILL}`}>
          <SlidersHorizontal size={13} aria-hidden="true" />
          Add your name and course
        </Link>
      ) : null}

      {cards.map((s) => (
        <button
          key={s.title}
          type="button"
          onClick={() => onPick(s.prompt)}
          aria-label={`${s.title}. ${s.detail}`}
          className={
            /* The one starter that earns colour. --accent-text on --accent-tint
               measures ~5.3:1, so it clears AA — unlike --accent, which would
               not. The tint says "up next" without needing a second badge. */
            s.fromPacing
              ? 'rounded-full border border-accent-text/25 bg-accent-tint px-3.5 py-1.5 text-[0.8125rem] font-medium text-accent-text transition-colors hover:border-accent-text/45'
              : PILL
          }
        >
          {s.title}
        </button>
      ))}
    </div>
  )
}
