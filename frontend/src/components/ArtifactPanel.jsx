import { useRef, useState } from 'react'
import { ChevronsRight, Download, Loader2, RefreshCw } from 'lucide-react'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { PANEL_OVERLAY, useMediaQuery } from '../hooks/useMediaQuery'
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

  const isOverlay = useMediaQuery(PANEL_OVERLAY)

  /* Fit-width is right when the document has a column of its own — it is what
     stops a fixed page clipping its own title. It is WRONG in the 480px overlay
     drawer, where fitting five district columns into it gives one word per line.
     So the default follows the canvas, and the toggle stays available either
     way. Initial state only: a teacher who has picked a width keeps it. */
  const [fitWidth, setFitWidth] = useState(!isOverlay)
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
            {planId && onReviseDay ? ' · click any cell to tweak' : ''}
          </span>
        </span>

        <span className="flex-1" />

        {/* A real toggle, not a label. Fit-width is the default because the
            document has to survive a narrow canvas; the district's own 860px
            column is one click away for anyone checking it against the .docx. */}
        <button
          type="button"
          className="doc-fit"
          aria-pressed={fitWidth}
          onClick={() => setFitWidth((v) => !v)}
          title={fitWidth ? 'Show the document at its printed width' : 'Fit the document to this column'}
        >
          {fitWidth ? 'Fit width' : 'Printed width'}
        </button>

        {planId ? (
          <>
            <button
              type="button"
              className="btn-icon"
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
              fitWidth={fitWidth}
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
