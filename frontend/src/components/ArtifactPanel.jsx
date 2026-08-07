import { useRef, useState } from 'react'
import { ChevronsRight, Download, Loader2, RefreshCw } from 'lucide-react'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { PANEL_OVERLAY, useLayoutMode, useMediaQuery } from '../hooks/useMediaQuery'
import { LessonPlanTable } from './LessonPlanTable'
import { Marginalia } from './Marginalia'

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
 *
 * The page fits the container and is never a fixed 900px sheet: a fixed page in
 * a narrow canvas clips its own title, which is the defect this replaces.
 */
const VIEWS = [
  { id: 'days', label: 'Days', hint: 'One card per day' },
  { id: 'fit', label: 'Fit', hint: 'Fitted to this width' },
  { id: 'print', label: 'Print', hint: 'The district table at its printed width' },
]

export function ArtifactPanel({
  artifact,
  onCollapse,
  onReviseDay,
  onPlanRevised,
  busy,
  streamingText,
  missingDays,
  flashCells,
  openTweak,
  setOpenTweak,
}) {
  const [rebuilding, setRebuilding] = useState(false)
  const toast = useToast()
  const panelRef = useRef(null)
  const titleRef = useRef(null)

  /* Two questions, two answers. `isOverlay` decides whether the document
     COVERS the chat or docks beside it. `isPhone` decides what SHAPE the
     document takes. They used to be the same flag, which is how the 480px
     drawer ended up holding an 860px table. */
  const isOverlay = useMediaQuery(PANEL_OVERLAY)
  const isPhone = useLayoutMode() === 'phone'

  /* One control, three views — see VIEWS below. Derived until the teacher
     picks, then sticky. `useState(!isOverlay)` never re-evaluated, so a wrong
     answer at mount time was permanent. */
  const [chosen, setChosen] = useState(null)
  const view = chosen ?? (isPhone ? 'days' : 'fit')
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
      <div className="doc-head">
        <button
          type="button"
          className="doc-collapse fa-press"
          onClick={onCollapse}
          aria-label="Back to artifacts"
          title="Back to artifacts"
        >
          <ChevronsRight size={15} aria-hidden="true" />
        </button>

        <span className="doc-titles" ref={titleRef} tabIndex={-1}>
          <strong className="doc-title">{plan?.week_of || 'Lesson plan'}</strong>
          <span className="doc-sub">
            {planId ? 'Saved' : busy ? 'Drafting…' : 'Preview'}
            {artifact?.unit ? ` · ${artifact.unit}` : ''}
            {planId && onReviseDay && view !== 'days' ? ' · click any cell to tweak' : ''}
          </span>
        </span>

        <span className="flex-1" />

        {/* One control where there were two — a `Fit width` button up here and
            a `View as the district table` button down in the table, which
            could contradict each other and which left the deck unreachable
            above 1024px. */}
        <div className="doc-views" role="group" aria-label="How to show the plan">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              className="doc-view"
              aria-pressed={view === v.id}
              onClick={() => setChosen(v.id)}
              title={v.hint}
            >
              {v.label}
            </button>
          ))}
        </div>

        {planId ? (
          <>
            {/* Not on a phone: collapse + the view control + Download already
                fill 375px, and Rebuild is a power action where Download is the
                reason the app exists. */}
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
          <div className="flex min-h-[300px] flex-col items-center justify-center gap-4 text-center">
            <Loader2 size={22} className="animate-spin text-ink-muted" aria-hidden="true" />
            <p className="note">Retrieving standards, then writing Monday…</p>
          </div>
        )}
      </div>
    </section>
  )
}
