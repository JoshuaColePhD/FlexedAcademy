import { useRef, useState } from 'react'
import { Download, Loader2, RefreshCw, X } from 'lucide-react'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { PANEL_OVERLAY, useMediaQuery } from '../hooks/useMediaQuery'
import { LessonPlanTable } from './LessonPlanTable'
import { GroundingStrip, Marginalia } from './Marginalia'
import { WeekStrip } from './WeekStrip'

export function ArtifactPanel({
  artifact,
  onClose,
  onReviseDay,
  onPlanRevised,
  busy,
  streamingText,
  missingDays,
  framework,
}) {
  const [rebuilding, setRebuilding] = useState(false)
  const toast = useToast()
  const panelRef = useRef(null)
  const titleRef = useRef(null)

  const isOverlay = useMediaQuery(PANEL_OVERLAY)
  useFocusTrap(panelRef, {
    active: true,
    trap: isOverlay,
    initialFocus: titleRef,
    onEscape: onClose,
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
    <aside
      className="flex h-full w-full flex-col overflow-hidden bg-paper-raised outline-none"
      aria-label="Generated lesson plan"
      ref={panelRef}
      tabIndex={-1}
      role={isOverlay ? 'dialog' : undefined}
      aria-modal={isOverlay ? 'true' : undefined}
    >
      <div className="flex h-14 shrink-0 items-center bg-paper-raised px-4">
        <span className="flex min-w-0 flex-1 flex-col" ref={titleRef} tabIndex={-1}>
          <strong className="truncate text-sm font-semibold text-ink">
            {plan?.week_of || 'Lesson plan'}
          </strong>
          <small className="truncate text-xs text-ink-muted">
            {planId ? 'Saved · Florence City Schools template' : busy ? 'Drafting…' : 'Preview'}
            {artifact?.unit ? ` · ${artifact.unit}` : ''}
          </small>
        </span>

        <div className="ml-4 flex shrink-0 items-center gap-2">
          {planId ? (
            <>
              <button
                type="button"
                className="rounded-lg p-1.5 text-ink-muted transition-colors hover:bg-paper-sunken hover:text-ink"
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
                  button on the panel. */}
              <a
                className="flex items-center gap-2 rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-ink-inverse transition-colors hover:bg-ink-soft"
                href={api.planDownloadUrl(planId)}
                download
              >
                <Download size={14} aria-hidden="true" /> Download
              </a>
            </>
          ) : (
            <span className="flex cursor-not-allowed items-center gap-2 rounded-lg bg-paper-sunken px-3 py-1.5 text-sm font-medium text-ink-faint">
              <Download size={14} aria-hidden="true" /> Download
            </span>
          )}

          <div className="mx-1 h-4 w-px bg-edge" />

          <button
            type="button"
            className="rounded-lg p-1.5 text-ink-muted transition-colors hover:bg-paper-sunken hover:text-ink"
            onClick={onClose}
            aria-label="Close panel"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto bg-paper p-4 sm:p-6 lg:p-8">
        <div className="mx-auto w-full max-w-4xl">
          {plan?.days?.length ? (
            <div className="flex flex-col gap-6">
              {/* The week at a glance, before the detail. */}
              <WeekStrip days={plan.days} writing={busy} compact />
              {artifact?.grounding ? <GroundingStrip grounding={artifact.grounding} framework={framework} /> : null}
              {/* planId is the DB row id and lives on the artifact — NOT on
                  plan.id. LessonPlanTable used to read plan.id, but `plan` here
                  is plan_json, which has no id, so its whole revise/feedback
                  toolbar was gated on a value that is always undefined and had
                  almost certainly never rendered for anyone. */}
              <LessonPlanTable
                plan={plan}
                planId={planId}
                groundedCodes={grounded}
                onReviseDay={planId ? onReviseDay : undefined}
                onPlanRevised={onPlanRevised}
                busy={busy}
                missingDays={missingDays}
              />
              <Marginalia warnings={artifact?.warnings} />
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
      </div>
    </aside>
  )
}
