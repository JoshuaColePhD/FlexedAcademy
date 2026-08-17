import { useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { ChevronsRight, Download, Loader2, RefreshCw, Share2 } from 'lucide-react'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { PANEL_OVERLAY, useLayoutMode, useMediaQuery } from '../hooks/useMediaQuery'
import { classColor } from '../lib/classColor'
import { unitSuffix } from '../lib/planShape'
import { LessonPlanTable } from './LessonPlanTable'
import { Marginalia } from './Marginalia'
import { ShareDialog } from './ShareDialog'
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
  onCollapse,
  onReviseDay,
  onPlanRevised,
  busy,
  preparing,
  streamingText,
  missingDays,
  flashCells,
  openTweak,
  setOpenTweak,
}) {
  const [rebuilding, setRebuilding] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const toast = useToast()
  const location = useLocation()
  const panelRef = useRef(null)
  const titleRef = useRef(null)
  const color = classColor(classId)

  /* Two questions, two answers. `isOverlay` decides whether the document
     COVERS the chat or docks beside it. `isPhone` decides what SHAPE the
     document takes. They used to be the same flag, which is how the 480px
     drawer ended up holding an 860px table. */
  const isOverlay = useMediaQuery(PANEL_OVERLAY)
  const isPhone = useLayoutMode() === 'phone'

  // Days is the phone shape — the district table has a min-width and a
  // teacher on a phone reads one day at a time anyway. Everyone else gets
  // Print, the actual district table: no picking required, because there is
  // nothing left to pick between.
  const view = isPhone ? 'days' : 'print'
  /* Escape peels one layer at a time, innermost first: an open cell tweak, then
     the document. It has to be decided HERE rather than in the tweak input,
     because useFocusTrap binds a native listener on this container — which runs
     before React's delegated handlers at the root, so an e.stopPropagation()
     down in the input is already too late. Cancelling a two-word tweak used to
     throw away the whole document you were working in. */
  useFocusTrap(panelRef, {
    active: true,
    trap: isOverlay,
    initialFocus: titleRef,
    onEscape: () => (openTweak ? setOpenTweak(null) : onCollapse()),
  })

  const plan = artifact?.plan
  const planId = artifact?.planId
  const grounded = new Set(artifact?.grounding?.codes || artifact?.retrievedIds || [])

  const rebuild = async () => {
    setRebuilding(true)
    try {
      await api.rebuildPlan(planId)
      toast.success('Document rebuilt', 'The .docx was re-emitted from the saved plan.')
    } catch (err) {
      toast.apiError('Could not rebuild the document', err)
    } finally {
      setRebuilding(false)
    }
  }

  return (
    <section
      className="doc-shell"
      aria-label="Generated lesson plan"
      ref={panelRef}
      tabIndex={-1}
      role={isOverlay ? 'dialog' : undefined}
      aria-modal={isOverlay ? 'true' : undefined}
    >
      <div className="doc-head" style={{ '--doc-head-accent': `rgb(${color.rgb})` }}>
        <button
          type="button"
          className="doc-collapse fa-press"
          onClick={onCollapse}
          aria-label="Back to my plans"
          title="Back to my plans"
        >
          <ChevronsRight size={15} aria-hidden="true" />
        </button>

        <span className="doc-titles" ref={titleRef} tabIndex={-1}>
          <strong className="doc-title">{plan?.week_of || 'Lesson plan'}</strong>
          <span className="doc-sub">
            {planId ? 'Saved' : busy ? 'Drafting…' : 'Preview'}
            {unitSuffix(artifact?.unit, ' · ')}
            {planId && onReviseDay && view !== 'days' ? ' · click any cell to tweak' : ''}
          </span>
        </span>

        <span className="flex-1" />

        {planId ? (
          <>
            {/* Not on a phone: collapse + Download already fill 375px, and
                both Rebuild and Share are power actions where Download is
                the reason the app exists. */}
            <button
              type="button"
              className={`btn-icon${isPhone ? ' hidden' : ''}`}
              onClick={() => setShareOpen(true)}
              aria-label="Share this plan via Google"
              title="Share via Google"
            >
              <Share2 size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`btn-icon${isPhone ? ' hidden' : ''}`}
              onClick={rebuild}
              disabled={rebuilding}
              aria-label="Rebuild the document from the saved plan"
              title="Rebuild the document"
            >
              {rebuilding ? (
                <Loader2 size={16} className="animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw size={16} aria-hidden="true" />
              )}
            </button>
            {/* The reason a teacher opened this app. It is the only filled
                control in the header. */}
            <a className="doc-download fa-press" href={api.planDownloadUrl(planId)} download>
              <Download size={14} aria-hidden="true" /> Download
            </a>
          </>
        ) : (
          <span className="doc-download" aria-disabled="true" style={{ opacity: 0.45 }}>
            <Download size={14} aria-hidden="true" /> Download
          </span>
        )}
      </div>

      {/* tabIndex + role + label are not polish: a scroll region that only
          responds to pointer drag is a keyboard-access failure (WCAG 2.1.1). */}
      <div className="doc-body" tabIndex={0} role="region" aria-label="The lesson plan document">
        {plan?.days?.length ? (
          <div className="doc-sheet">
            <LessonPlanTable
              plan={plan}
              planId={planId}
              subject={subject}
              groundedCodes={grounded}
              onReviseDay={planId ? onReviseDay : undefined}
              onPlanRevised={onPlanRevised}
              busy={busy}
              missingDays={missingDays}
              view={view}
              flashCells={flashCells}
              openTweak={openTweak}
              setOpenTweak={setOpenTweak}
            />
            <Marginalia
              warnings={artifact?.warnings}
              plan={plan}
              retrievedCodes={artifact?.grounding?.codes || artifact?.retrievedIds}
              onFixCitation={onReviseDay ? setOpenTweak : undefined}
            />
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
        weekLabel={plan?.week_of}
        returnTo={`${location.pathname}${location.search}`}
      />
    </section>
  )
}
