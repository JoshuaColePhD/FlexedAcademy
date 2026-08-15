import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Loader2, RotateCcw, Sparkles } from 'lucide-react'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'
import { useActiveClass, useCalendar } from '../hooks/useAppData'
import { qk } from '../lib/queryKeys'
import { todayISO, longDay } from '../lib/dates'

/* The daily habit this app didn't have. Building a week's plan is a once-
 * (or twice-) a week event by design — intent routing is deliberately
 * "no plan yet, build one; plan exists, revise it" (see ChatPage's own
 * docstring), which gives a teacher no reason to open the app the OTHER
 * four mornings. This page is that reason: one glance at today's
 * bell-ringer.
 *
 * Two sources, same one-line answer, never both at once:
 *   - A plan already exists for this week -> read its own `do_now` field
 *     for today (schema.py's DAY_JSON_SCHEMA) straight off the built
 *     plan. Zero extra cost, and it's the SAME bell-ringer the plan
 *     already committed to — this isn't a second, competing answer.
 *   - No plan yet -> a fresh, standalone one generated on the spot
 *     (backend/routes/bell_ringer.py), so a teacher who hasn't planned
 *     that far ahead still gets something to walk into class with today,
 *     not a dead end that only says "come back once you've planned."
 */

function Card({ children }) {
  return (
    <div className="neo-panel mx-auto w-full max-w-xl rounded-2xl bg-paper-raised p-6">
      {children}
    </div>
  )
}

function Eyebrow({ children }) {
  return <p className="eyebrow pb-2 text-ink-muted">{children}</p>
}

export function TodayPage() {
  const toast = useToast()
  const { activeClass } = useActiveClass()
  const { data: calendar, isLoading: calendarLoading } = useCalendar(activeClass?.id)
  const [topic, setTopic] = useState('')
  const [generated, setGenerated] = useState(null)
  const [generating, setGenerating] = useState(false)

  const currentWeek = useMemo(
    () => (calendar?.weeks || []).find((w) => w.week === calendar?.current_week) || null,
    [calendar]
  )
  const today = todayISO()
  const todayIndex = useMemo(
    () => (currentWeek?.days || []).findIndex((d) => d.date === today),
    [currentWeek, today]
  )
  const todayRow = todayIndex >= 0 ? currentWeek.days[todayIndex] : null

  const { data: plan, isLoading: planLoading } = useQuery({
    queryKey: qk.plan(currentWeek?.plan_id),
    queryFn: () => api.getPlan(currentWeek.plan_id),
    enabled: Boolean(currentWeek?.plan_id),
  })
  const planDay = todayIndex >= 0 ? plan?.plan_json?.days?.[todayIndex] : null

  const generate = async () => {
    setGenerating(true)
    try {
      const result = await api.getBellRinger({
        subject: activeClass?.subject || 'English Language Arts',
        grade: activeClass?.grade || '',
        topic,
      })
      setGenerated(result)
    } catch (err) {
      toast.apiError("Couldn't generate a warm-up", err)
    } finally {
      setGenerating(false)
    }
  }

  let body
  if (calendarLoading) {
    body = (
      <Card>
        <p className="text-sm text-ink-muted">Loading today…</p>
      </Card>
    )
  } else if (!currentWeek || !todayRow) {
    // The year hasn't started, has ended, or there's no calendar on file for
    // this school — schoolcal.week_for already covers "past the last week"
    // by returning None, which surfaces here as no current_week at all.
    body = (
      <Card>
        <Eyebrow>Today</Eyebrow>
        <p className="text-sm text-ink-soft">
          No school calendar found for {longDay(today)} yet.
        </p>
      </Card>
    )
  } else if (!todayRow.is_school) {
    body = (
      <Card>
        <Eyebrow>{longDay(today)}</Eyebrow>
        <p className="text-base font-medium text-ink">No school today{todayRow.note ? ` — ${todayRow.note}` : ''}.</p>
      </Card>
    )
  } else if (currentWeek.plan_id) {
    body = (
      <Card>
        <Eyebrow>{longDay(today)}</Eyebrow>
        {planLoading ? (
          <p className="text-sm text-ink-muted">Loading today's plan…</p>
        ) : planDay ? (
          <>
            <p className="text-base font-medium leading-relaxed text-ink">{planDay.do_now}</p>
            {currentWeek.chat_id ? (
              <Link
                to={`/c/${activeClass?.id}/chat/${currentWeek.chat_id}`}
                className="mt-4 inline-block text-xs font-medium text-accent-text hover:underline"
              >
                Open the full week →
              </Link>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-ink-muted">This week's plan doesn't cover today.</p>
        )}
      </Card>
    )
  } else {
    // No plan built for this week yet — the gap a weekly-cadence app
    // otherwise leaves empty most mornings. Same subject/grade every
    // built plan already uses; topic is the one thing only the teacher
    // knows, and optional — see llm.generate_bell_ringer's own fallback.
    body = (
      <Card>
        <Eyebrow>{longDay(today)}</Eyebrow>
        <p className="text-sm text-ink-soft">
          No week planned yet — here's a quick warm-up to walk in with anyway.
        </p>
        <div className="mt-4 flex flex-col gap-3">
          <input
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Today's topic or skill (optional)"
            className="neo-inset w-full rounded-lg bg-paper-sunken px-3 py-2 text-sm text-ink placeholder:text-ink-faint"
          />
          <button
            type="button"
            onClick={generate}
            disabled={generating}
            className="neo-raised tap-target flex min-h-touch items-center justify-center gap-2 self-start rounded-full bg-accent-tint px-5 text-sm font-medium text-accent-text transition-shadow disabled:cursor-not-allowed disabled:opacity-60"
          >
            {generating ? (
              <Loader2 size={15} className="animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles size={15} aria-hidden="true" />
            )}
            {generating ? 'Writing one…' : generated ? 'Give me another' : 'Generate a warm-up'}
          </button>
        </div>
        {generated ? (
          <div className="neo-inset mt-5 rounded-xl bg-paper-sunken p-4">
            <p className="text-base font-medium leading-relaxed text-ink">{generated.prompt}</p>
            <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-faint">
              <RotateCcw size={11} aria-hidden="true" />
              About {generated.minutes} minutes
            </p>
          </div>
        ) : null}
      </Card>
    )
  }

  return (
    <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto px-gutter py-10">
      <div className="w-full">{body}</div>
    </div>
  )
}
