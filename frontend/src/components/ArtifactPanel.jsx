import { useEffect, useMemo, useRef, useState } from 'react'
import * as Sentry from '@sentry/react'
import { useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { qk } from '../lib/queryKeys'
import { Tooltip } from './Tooltip'
import { Download, Loader2, TriangleAlert, X, Maximize2, Minimize2, Cloud } from 'lucide-react'
import { api } from '../lib/api'
import { useClasses } from '../hooks/useAppData'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useLayoutMode } from '../hooks/useMediaQuery'
import { classColor } from '../lib/classColor'
import { unitSuffix } from '../lib/planShape'
import { LessonPlanTable } from './LessonPlanTable'
import { WeedenLessonPlanTable } from './WeedenLessonPlanTable'
import { WeedenPlanDayCards } from './WeedenPlanDayCards'
import { ShareDialog } from './ShareDialog'
import { DocxDownloadButton } from './DocxDownloadButton'
import { Skeleton, SkeletonText, SkeletonRows } from './Skeleton'

/* The artifact, expanded into a working document.
 *
 * What used to live here and no longer does:
 *
 *  - WeekStrip and GroundingStrip. They moved into the chat message, which is
 *    what lets the document stay closed by default — see Message.jsx.
 *  - Present. Nobody projects a lesson plan.
 *  - Edit. An edit mode is a second writer of the same artifact and would drift
 *    against chat-driven revision. Every revision goes through the composer or a
 *    cell tweak, so there is exactly one path a change can take.
 *  - A Days/Fit/Print toggle. Three ways to read one week was two more
 *    decisions than a teacher opening this panel actually has: what a plan
 *    "really" looks like is the district table it prints to, so that is the
 *    only shape a non-phone screen ever shows now — see PRINT below. Fit's
 *    own compact grid is gone with it, not just hidden, since nothing can
 *    reach it anymore.
 *
 * The page fits the container and is never a fixed 900px sheet: a fixed page in
 * a narrow canvas clips its own title, which is the defect this replaces.
 */
function PlanSkeleton() {
  return (
    <div className="doc-sheet overflow-hidden">
      <div className="mb-8 border-b border-paper-sunken pb-6">
        <Skeleton width="40%" height="2rem" className="mb-4" static />
        <SkeletonText lines={2} width="80%" static />
      </div>

      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="mb-6 rounded-lg border border-paper-sunken p-5">
          <div className="mb-4 flex items-center justify-between">
            <Skeleton width="15%" height="1.5rem" static />
            <Skeleton width="20%" height="1.25rem" static />
          </div>
          <SkeletonRows rows={2} static />
        </div>
      ))}
    </div>
  )
}

export function ArtifactPanel({
  artifact,
  classId,
  subject,
  state,
  onCollapse,
  onReviseDay,
  onReviseDays,
  onEditDay,
  onPickStandard,
  onPlanRevised,
  onFullscreenChange,
  busy,
  preparing,
  planSaveState = 'idle',
  streamingText,
  missingDays,
  flashCells,
  openTweak,
  setOpenTweak,
  mobileReader = false,
  readerMode = false,
}) {
  const [shareOpen, setShareOpen] = useState(false)
  const [completionPulse, setCompletionPulse] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  // .artifact-overlay (ChatPage.jsx) is the box that actually needs to grow —
  // see this effect's twin in ArtifactDetailPanel.jsx for why. Fires on both
  // ways isFullscreen can change (the button below, and the Escape handler
  // just past it), so the parent never has to know about either path itself.
  useEffect(() => {
    onFullscreenChange?.(isFullscreen)
    return () => onFullscreenChange?.(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFullscreen])
    const { data: schools = [] } = useQuery({ queryKey: qk.schools, queryFn: api.listSchools })
  const { data: classes = [] } = useClasses()
  
  const cls = classes.find(c => c.id === classId)
  const school = schools.find(s => s.id === cls?.school)
  const isPendingTemplate = ['pending', 'in_progress', 'blocked'].includes(school?.builder_readiness)
const location = useLocation()
  const panelRef = useRef(null)
  const titleRef = useRef(null)
  const color = classColor(classId)

  // Pulse the shadow when a generation finishes (busy transitions true -> false while we have a plan)
  const previousBusy = useRef(busy)

  useEffect(() => {
    let timer
    if (previousBusy.current && !busy && artifact?.planId) {
      setCompletionPulse(true)
      timer = setTimeout(() => setCompletionPulse(false), 420)
    }
    previousBusy.current = busy
    return () => clearTimeout(timer)
  }, [busy, artifact?.planId])

  // Docked documents are non-modal; fullscreen owns focus until dismissed.
  // Phone plans are rendered as a destination in the app, rather than a
  // dialog layered over chat. That keeps the reader's semantics and scroll
  // behavior honest without changing the desktop document surface.
  const isOverlay = !mobileReader && (!readerMode || isFullscreen)
  const isPhone = useLayoutMode() === 'phone'

  // Days is the phone shape — the district table has a min-width and a
  // teacher on a phone reads one day at a time anyway. Everyone else gets
  // Print, the actual district table: no picking required, because there is
  // nothing left to pick between.
  // Desktop inspectors keep the complete district table in view so standards
  // and lesson fields can be compared across the week without horizontal day
  // paging. Only the phone reader uses the compact swipeable day cards.
  const view = isPhone ? 'days' : 'print'
  /* Escape peels one layer at a time, innermost first: an open cell tweak, then
     the document. It has to be decided HERE rather than in the tweak input,
     because useFocusTrap binds a native listener on this container — which runs
     before React's delegated handlers at the root, so an e.stopPropagation()
     down in the input is already too late. Cancelling a two-word tweak used to
     throw away the whole document you were working in. */
  useFocusTrap(panelRef, {
    active: isOverlay,
    trap: isOverlay,
    initialFocus: titleRef,
    onEscape: () => {
      if (isFullscreen) {
        setIsFullscreen(false)
      } else {
        if (openTweak) setOpenTweak(null); else onCollapse();
      }
    },
  })

  const plan = artifact?.plan
  const planId = artifact?.planId
  const documentJob = useQuery({
    queryKey: ['document-status', planId],
    queryFn: () => api.getDocumentStatus(planId),
    enabled: Boolean(planId),
    refetchInterval: (query) => ['queued', 'building'].includes(query.state.data?.status) ? 1500 : false,
  })
  const documentStatus = documentJob.data?.status || (planId ? 'queued' : 'ready')
  const downloadReady = documentStatus === 'ready'
  const reportedDocumentStatus = useRef(null)
  useEffect(() => {
    if (!planId || reportedDocumentStatus.current === documentStatus) return
    reportedDocumentStatus.current = documentStatus
    Sentry.addBreadcrumb({
      category: 'document.build',
      message: `Document ${documentStatus}`,
      level: documentStatus === 'failed' ? 'error' : 'info',
      // Status-only: telemetry must never receive a plan identifier, lesson
      // content, or server error text.
      data: { attempts: documentJob.data?.attempts },
    })
    if (documentStatus === 'failed') {
      Sentry.captureMessage('Document build failed', {
        level: 'error',
      })
    }
  }, [documentStatus, documentJob.data?.attempts, documentJob.data?.error_message, planId])
  const grounded = useMemo(
    () => new Set(artifact?.grounding?.codes || artifact?.retrievedIds || []),
    [artifact?.grounding?.codes, artifact?.retrievedIds],
  )

  return (
    <section
      className={`doc-shell${completionPulse ? ' fa-shadow-lift' : ''}${isFullscreen ? ' is-fullscreen' : ''}${mobileReader ? ' is-mobile-reader' : ''}${readerMode ? ' is-tablet-reader' : ''}`}
      aria-label="Generated lesson plan"
      ref={panelRef}
      tabIndex={-1}
      role={isOverlay ? 'dialog' : undefined}
      aria-modal={isOverlay ? 'true' : undefined}
    >
      <div className="doc-head" style={{ '--doc-head-accent': `rgb(${color.rgb})` }}>
        <span className="doc-titles" ref={titleRef} tabIndex={-1}>
          <strong className="doc-title">{plan?.week_of || 'Lesson plan'}</strong>
          <span className="doc-sub">
            {planId && planSaveState === 'saving'
              ? 'Saving…'
              : planId && planSaveState === 'error'
                ? 'Save failed'
                : planId
                  ? 'Saved'
                  : busy
                    ? 'Drafting…'
                    : 'Preview'}
            {unitSuffix(artifact?.unit, ' · ')}
            {planId && onReviseDay ? (view === 'days' ? ' · tap any field to edit' : ' · click any cell to edit') : ''}
          </span>
        </span>

        <span className="flex-1" />

        <div className="flex items-center gap-2">
          {planId ? (
            <>
              {/* The one "more options" entry now — share link and Drive
                  both moved into the dialog THIS opens (Josh's own ask:
                  "the share link and drive should be in the cloud
                  button"). The dropdown chevron that used to sit beside
                  Download is gone; it had nothing left to do once Download
                  became a direct link and Share/Drive moved here. */}
              <button
                type="button"
                className="btn-icon fa-press"
                aria-label="Share or save to Google Drive"
                title="Share or save to Google Drive"
                onClick={() => setShareOpen(true)}
              >
                <Cloud size={16} className="text-ink-muted" />
              </button>

              {/* .doc-download, not .doc-download-group/-main — that pairing
                  only makes sense with the dropdown it used to sit beside
                  (one half-rounded pill needs its other half); a single
                  control gets the plain, fully-rounded pill the failed-
                  build state already uses (ArtifactDetailPanel.jsx). */}
              {downloadReady ? <DocxDownloadButton
                key="document-ready"
                planId={planId}
                className="doc-download fa-press fa-context-pop flex items-center gap-1.5"
                aria-label="Download as DOCX"
                title="Download as DOCX"
              >
                {isPendingTemplate ? (
                  <Tooltip content="Your district form is still awaiting verification. This plan downloads in a clearly labeled neutral format, never another district's template." position="bottom-right">
                    <TriangleAlert size={14} className="text-amber-500" aria-hidden="true" />
                  </Tooltip>
                ) : null}
                <Download size={14} aria-hidden="true" className="text-ink-muted" />
                <span className="font-medium">{readerMode && !isFullscreen ? 'DOCX' : 'Download as DOCX'}</span>
              </DocxDownloadButton> : (
                <button
                  key={`document-${documentStatus}`}
                  type="button"
                  className="doc-download fa-press fa-context-pop flex items-center gap-1.5"
                  disabled={documentStatus !== 'failed'}
                  onClick={async () => {
                    if (documentStatus === 'failed') {
                      await api.rebuildPlan(planId)
                      documentJob.refetch()
                    }
                  }}
                >
                  {documentStatus === 'failed' ? 'Rebuild document' : documentStatus === 'building' ? 'Preparing document…' : 'Document queued…'}
                </button>
              )}
            </>
          ) : (
            <span className="doc-download opacity-45 flex items-center gap-1.5" aria-disabled="true">
              <Download size={14} aria-hidden="true" className="text-ink-muted" />
              <span className="font-medium">Download as DOCX</span>
            </span>
          )}

          {!mobileReader ? (
            <button
              type="button"
              className="btn-icon fa-press ml-1"
              onClick={() => setIsFullscreen(!isFullscreen)}
              aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            >
              {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
          ) : null}

          <button
            type="button"
            className="btn-icon fa-press"
            onClick={onCollapse}
            aria-label="Close document"
            title="Close document"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* tabIndex + role + label are not polish: a scroll region that only
          responds to pointer drag is a keyboard-access failure (WCAG 2.1.1). */}
      <div className="doc-body" tabIndex={0} role="region" aria-label="The lesson plan document">
        {plan?.days?.length ? (
          <div className="doc-sheet">
            {cls?.school === 'weeden-elementary-school' ? (
              view === 'days' ? <WeedenPlanDayCards plan={plan} missingDays={missingDays} /> : <WeedenLessonPlanTable plan={plan} />
            ) : <LessonPlanTable
              plan={plan}
              planId={planId}
              subject={subject}
              state={state}
              groundedCodes={grounded}
              onReviseDay={planId ? onReviseDay : undefined}
              onReviseDays={planId ? onReviseDays : undefined}
              onEditDay={planId ? onEditDay : undefined}
              onPickStandard={planId ? onPickStandard : undefined}
              onPlanRevised={onPlanRevised}
              busy={busy}
              missingDays={missingDays}
              view={view}
              flashCells={flashCells}
              openTweak={openTweak}
              setOpenTweak={setOpenTweak}
            />}
          </div>
        ) : streamingText ? (
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-paper-sunken p-4 font-mono text-sm text-ink-soft">
            {streamingText}
          </pre>
        ) : (
          preparing ? <PlanSkeleton /> : (
            <div className="flex min-h-[300px] flex-col items-center justify-center gap-4 text-center">
              <Loader2 size={22} className="animate-spin text-ink-muted" aria-hidden="true" />
              <p className="note">Waiting for generation to begin...</p>
            </div>
          )
        )}
      </div>

      <ShareDialog
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        planId={planId}
        // ShareDialog reads this prop as `documentName` — it was named
        // `weekLabel` here, a prop the dialog never declared, so it read as
        // undefined and every share opened from this viewer fell back to a
        // generic "Export this file" / "The plan is now in your Google Drive"
        // instead of naming the week, unlike the same dialog opened from
        // ArtifactRail.
        documentName={plan?.week_of}
        returnTo={`${location.pathname}${location.search}`}
      />
    </section>
  )
}
