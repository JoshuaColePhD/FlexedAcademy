import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Download, Loader2, RefreshCw, Sparkles } from 'lucide-react'
import { api } from '../lib/api'
import { qk } from '../lib/queryKeys'
import { shortRange } from '../lib/dates'
import { useToast } from '../lib/toastContext'
import { useConfirm } from '../lib/confirmContext'
import { useLessonStream } from '../hooks/useLessonStream'
import { useLayoutMode } from '../hooks/useMediaQuery'
import { useActiveClass, useInvalidateCalendar, useWeek } from '../hooks/useAppData'
import { findFramework } from '../lib/frameworks'
import { LessonPlanTable } from '../components/LessonPlanTable'
import { GroundingStrip, Marginalia } from '../components/Marginalia'
import { WeekStrip } from '../components/WeekStrip'
import { SkeletonText } from '../components/Skeleton'
import { useDocumentTitle } from '../hooks/useDocumentTitle'

/* One week, full screen, at its own address.
 *
 * This is the page that could not exist before. A plan lived inside a chat, and
 * a chat did not change the URL — openChat() set state and navigate('/') — so
 * `shell.onOpenPlan` was never even implementable and the "Open" button on a
 * planned week was a silent no-op. /c/:classId/week/12 is refreshable,
 * bookmarkable, shareable and back-button-able, and the no-op is now
 * structurally impossible rather than merely fixed.
 *
 * There is no chat transcript here. Generation happens against a WEEK the
 * teacher picked, not against a conversation that happens to mention one.
 */
export function WeekPage() {
  const { classId, weekNo } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const mode = useLayoutMode()
  const { activeClass } = useActiveClass()
  const invalidateCalendar = useInvalidateCalendar(classId)
  const { week, prev, next, isLoading } = useWeek(classId, weekNo)
  const { data: frameworks = [] } = useQuery({
    queryKey: qk.frameworks,
    queryFn: () => api.getFrameworks(),
    staleTime: Infinity,
  })

  useDocumentTitle(
    week ? `Week ${String(week.week).padStart(2, '0')} · ${activeClass?.name || ''}`.trim() : null
  )

  const [artifact, setArtifact] = useState(null)
  const [loadingPlan, setLoadingPlan] = useState(false)
  const [rebuilding, setRebuilding] = useState(false)
  const [note, setNote] = useState('')

  /* onDone/onError are hook options, not arguments to start() — the hook keeps
     them in refs so `start` stays referentially stable. */
  const stream = useLessonStream({
    onDone: (done) => {
      setArtifact({
        planId: done.plan_id,
        plan: done.plan,
        warnings: done.warnings,
        retrievedIds: done.retrieved_ids ?? done.grounding?.codes,
        unit: done.unit,
      })
      // The calendar behind this page still says "Not planned" for a week that
      // now is. One invalidation and every surface reading the board corrects
      // itself — this is the job the old refreshChats callback was doing by
      // hand, badly.
      invalidateCalendar()
      toast.success('Week built', 'The .docx is ready to download.')
    },
    onError: (err) => toast.apiError("Couldn't build that week", err),
  })
  const streamRef = useRef(stream)
  streamRef.current = stream

  /* Load whatever is saved for this week. Keyed on the week, so ←/→ swaps the
     plan rather than accumulating them. */
  useEffect(() => {
    let cancelled = false
    setArtifact(null)
    streamRef.current.reset?.()
    if (!week?.plan_id) return undefined
    setLoadingPlan(true)
    api
      .getPlan(week.plan_id)
      .then((row) => {
        if (cancelled) return
        setArtifact({
          planId: row.id,
          plan: row.plan_json,
          warnings: row.warnings,
          retrievedIds: row.retrieved_ids,
          unit: row.unit,
        })
      })
      .catch(() => {
        if (!cancelled) toast.error("Couldn't open that plan", 'It may have been deleted.')
      })
      .finally(() => !cancelled && setLoadingPlan(false))
    return () => {
      cancelled = true
    }
  }, [week?.plan_id, toast])

  /* ← / → move between weeks. No-school weeks are NOT skipped: a closed week is
     information, and silently jumping over it would hide the reason the year
     has a gap in it. */
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return
      if (e.key === 'ArrowLeft' && prev) navigate(`/c/${classId}/week/${prev.week}`)
      if (e.key === 'ArrowRight' && next) navigate(`/c/${classId}/week/${next.week}`)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prev, next, classId, navigate])

  const generate = useCallback(
    (extra) => {
      if (!week) return
      const label = `Week ${String(week.week).padStart(2, '0')} — ${shortRange(week.start, week.end)}`
      const ask = [
        `Plan ${label}.`,
        week.notes ? `Calendar note: ${week.notes}.` : '',
        extra?.trim() || '',
      ]
        .filter(Boolean)
        .join(' ')

      setNote('')
      // Errors are surfaced by the hook's onError; swallow the rethrow so an
      // unhandled rejection doesn't reach the console on top of the toast.
      stream.start(ask).catch(() => {})
    },
    [week, stream]
  )

  const regenerate = useCallback(async () => {
    const ok = await confirm({
      title: 'Rebuild this week from scratch?',
      body: 'The current plan and its .docx are replaced. Any day-by-day revisions are lost.',
      confirmLabel: 'Rebuild',
      tone: 'danger',
    })
    if (ok) generate()
  }, [confirm, generate])

  const reviseDay = useCallback(
    async (dayIndex, day, feedback) => {
      if (!artifact?.planId) return
      try {
        const row = await api.reviseDay({ plan_id: artifact.planId, day_index: dayIndex, feedback })
        setArtifact((a) => ({
          ...a,
          plan: row.plan_json,
          warnings: row.warnings,
          retrievedIds: row.retrieved_ids,
        }))
        qc.setQueryData(qk.plan(row.id), row)
        toast.success(`${day.name} revised`, 'The .docx has been rebuilt to match.')
      } catch (err) {
        toast.apiError(`Could not revise ${day.name}`, err)
      }
    },
    [artifact, qc, toast]
  )

  const onPlanRevised = useCallback(
    (row) => {
      if (!row) return
      setArtifact((a) => ({
        ...a,
        plan: row.plan_json,
        warnings: row.warnings,
        retrievedIds: row.retrieved_ids,
      }))
      invalidateCalendar()
    },
    [invalidateCalendar]
  )

  const rebuildDocx = useCallback(async () => {
    if (!artifact?.planId) return
    setRebuilding(true)
    try {
      await api.rebuildPlan(artifact.planId)
      toast.success('Document rebuilt')
    } catch (err) {
      toast.apiError("Couldn't rebuild the document", err)
    } finally {
      setRebuilding(false)
    }
  }, [artifact, toast])

  if (isLoading) {
    return (
      <div className="page">
        <div className="mx-auto w-full max-w-measure">
          <SkeletonText lines={8} />
        </div>
      </div>
    )
  }

  if (!week) {
    return (
      <div className="page">
        <div className="empty-state">
          <h1>No such week</h1>
          <p>This class’s year doesn’t have a week {weekNo}.</p>
          <Link to={`/c/${classId}/calendar`} className="btn btn-primary">
            Back to the year
          </Link>
        </div>
      </div>
    )
  }

  const livePlan = artifact?.plan || stream.preview
  const grounded = new Set(artifact?.retrievedIds || stream.grounding?.codes || [])
  const canAuthor = mode === 'desktop'
  /* The human name of the framework, not the slug. activeClass.subject is an id
     like "AP_Lang"; the seal is a claim a teacher reads, so it needs the label
     the picker showed them. */
  const frameworkLabel =
    findFramework(frameworks, activeClass?.subject)?.label || livePlan?.course

  return (
    <div className="column">
      {/* ── the week header, with its arrows ─────────────────────────────── */}
      <header className="flex shrink-0 items-center gap-1 border-b border-edge px-2 py-2 sm:px-3">
        <Link
          to={prev ? `/c/${classId}/week/${prev.week}` : '#'}
          aria-disabled={!prev}
          aria-label="Previous week"
          className={`btn-icon ${prev ? '' : 'pointer-events-none opacity-30'}`}
        >
          <ChevronLeft size={17} aria-hidden="true" />
        </Link>

        <div className="min-w-0 flex-1 text-center">
          <h1 className="truncate text-sm font-semibold text-ink">
            <span className="font-mono tabular-nums text-ink-muted">
              WK {String(week.week).padStart(2, '0')}
            </span>{' '}
            · {shortRange(week.start, week.end)}
          </h1>
          <p className="truncate text-2xs text-ink-muted">
            {week.no_school
              ? week.notes || 'No school'
              : artifact?.unit || week.unit || activeClass?.name || ''}
          </p>
        </div>

        <Link
          to={next ? `/c/${classId}/week/${next.week}` : '#'}
          aria-disabled={!next}
          aria-label="Next week"
          className={`btn-icon ${next ? '' : 'pointer-events-none opacity-30'}`}
        >
          <ChevronRight size={17} aria-hidden="true" />
        </Link>
      </header>

      <div className="page scroll-y">
        <div className="mx-auto flex w-full max-w-measure-wide flex-col gap-5">
          {week.no_school ? (
            <div className="empty-state">
              <h1>School is closed this week</h1>
              <p>{week.notes || 'No school'}</p>
            </div>
          ) : livePlan?.days?.length ? (
            <>
              {/* Not compact: on this page the strip is the week at a glance,
                  so it carries each day's learning target. Compact is for the
                  streaming indicator, where there is nothing to show yet.

                  Hidden on a phone unless a stream is running: the card deck
                  below has its own day tabs, and two day-selectors stacked on a
                  375px screen is one too many. */}
              {mode === 'desktop' || stream.isStreaming ? (
                <WeekStrip days={livePlan.days} writing={stream.isStreaming} />
              ) : null}
              {artifact?.retrievedIds || stream.grounding ? (
                <GroundingStrip
                  grounding={stream.grounding || { codes: artifact?.retrievedIds || [] }}
                  framework={frameworkLabel}
                />
              ) : null}

              <LessonPlanTable
                plan={livePlan}
                planId={artifact?.planId}
                groundedCodes={grounded}
                onReviseDay={canAuthor && artifact?.planId ? reviseDay : undefined}
                onPlanRevised={onPlanRevised}
                busy={stream.isStreaming}
                missingDays={
                  stream.isStreaming ? 'pending' : artifact?.planId ? 'no_school' : 'incomplete'
                }
              />

              <Marginalia warnings={artifact?.warnings} />
            </>
          ) : loadingPlan || stream.isStreaming ? (
            <div className="flex flex-col gap-4 py-6">
              <p className="eyebrow">
                {stream.isStreaming
                  ? livePlan?.days?.length
                    ? 'Writing the week'
                    : 'Retrieving standards'
                  : 'Opening the plan'}
              </p>
              <SkeletonText lines={8} />
            </div>
          ) : (
            /* Unplanned. The one action on this screen. */
            <div className="empty-state">
              <h1>Week {week.week} isn’t planned yet</h1>
              <p>
                {shortRange(week.start, week.end)}
                {week.notes ? ` · ${week.notes}` : ''} · {week.teaching_days} teaching day
                {week.teaching_days === 1 ? '' : 's'}
              </p>
              {canAuthor ? (
                <div className="mt-2 flex w-full max-w-measure-form flex-col gap-2">
                  <label className="visually-hidden" htmlFor="week-note">
                    Anything this week should cover
                  </label>
                  <input
                    id="week-note"
                    className="input"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && generate(note)}
                    placeholder="Anything it should cover? (optional) — e.g. finish The Crucible Act III"
                  />
                  <button
                    type="button"
                    className="btn btn-primary min-h-touch-lg justify-center"
                    onClick={() => generate(note)}
                  >
                    <Sparkles size={15} aria-hidden="true" /> Build this week
                  </button>
                </div>
              ) : (
                <p className="mt-2 rounded-lg bg-paper-sunken px-4 py-3 text-sm text-ink-muted">
                  Plans are built on a computer. Open this on your laptop to generate one.
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── the action bar ───────────────────────────────────────────────
          Download is the mobile primary action and gets real size, not just a
          44px hit area — it is the reason a teacher opens this on a phone. */}
      {artifact?.planId ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-edge px-gutter py-2.5">
          <a
            href={api.planDownloadUrl(artifact.planId)}
            className="btn btn-primary min-h-touch-lg flex-1 justify-center sm:flex-none"
          >
            <Download size={15} aria-hidden="true" /> Download .docx
          </a>
          {canAuthor ? (
            <>
              <button
                type="button"
                className="btn"
                onClick={rebuildDocx}
                disabled={rebuilding}
                title="Re-emit the .docx from the saved plan"
              >
                {rebuilding ? (
                  <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw size={14} aria-hidden="true" />
                )}
                Rebuild file
              </button>
              {/* Regeneration is not revision, so it does not wear a retry icon
                  and it asks first. The old message-level Retry silently
                  discarded a saved plan. */}
              <button type="button" className="btn" onClick={regenerate}>
                Start over
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
