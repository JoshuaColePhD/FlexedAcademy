import { useQuery } from '@tanstack/react-query'
import { BookOpen, Calendar, Download, Eye, FileText, Loader2 } from 'lucide-react'
import { api } from '../lib/api'
import { qk } from '../lib/queryKeys'
import { scanGrounding } from '../lib/grounding'
import { orderedDays } from '../lib/planShape'

/* The artifact rail — 240px, and the default.
 *
 * A lesson plan is not a thing you read on a screen. It is a thing you
 * download, print and hand in. So the always-open document viewer that used to
 * share width with the chat is gone: the chat gets a real reading column, and
 * the artifact goes back to being what it actually is — a file, with a Download
 * button and a note of what it was built from.
 *
 * The honest cost is that you can no longer see whether Thursday is right
 * without opening it. That is paid for in the chat message, not here: see
 * Message.jsx, which carries the week strip and the grounding line so a bad
 * week is catchable with the document closed.
 *
 * Every row below is derived from something real. There is deliberately no
 * "prior versions" group: a plan row is updated in place (backend/db.py has no
 * revision table), so a v1/v2 list would be an invention, and an invented
 * version history in a compliance document is the worst kind of decoration.
 */

/** The one row shape the rail's secondary lines share. */
function RailRow({ icon: Icon, label, sub, flag, onClick, title }) {
  const body = (
    <>
      <span className="rail-row-tile">
        <Icon size={13} aria-hidden="true" />
      </span>
      <span className="rail-text">
        <span className="rail-row-label">{label}</span>
        <span className={`rail-sub${flag ? ' is-flag' : ''}`}>{sub}</span>
      </span>
    </>
  )
  if (!onClick) {
    return (
      <div className="rail-row" title={title}>
        {body}
      </div>
    )
  }
  return (
    <button type="button" className="rail-row is-interactive fa-press" onClick={onClick} title={title}>
      {body}
    </button>
  )
}

export function ArtifactRail({ artifact, classId, onExpand, busy, variant = 'rail' }) {
  const plan = artifact?.plan
  const planId = artifact?.planId
  /* On a phone there is no room for a 240px column, so the same component
     becomes a one-row bar above the composer: the file and its Download, and
     nothing else. "Built from" is dropped rather than squeezed — it already
     travels in the message as the week strip and the grounding line. */
  const isBar = variant === 'bar'

  /* Already fetched by ClassPage under the same key, so opening a chat after
     visiting My Classes costs nothing. Best-effort: a class with no uploaded
     documents is the common case, not an error. */
  const { data: documents = [] } = useQuery({
    queryKey: qk.classDocuments(classId),
    queryFn: () => api.listClassDocuments(classId),
    // The bar does not render this group, so it does not fetch it.
    enabled: Boolean(classId) && !isBar,
    retry: false,
    staleTime: 5 * 60_000,
  })

  const retrieved = artifact?.grounding?.codes || artifact?.retrievedIds || []
  const { grounded, ungrounded, checking } = scanGrounding(plan, retrieved)

  /* The calendar's contribution to this week, read off the plan the calendar
     shaped — backend/schoolcal.py is what put the no_school flags there. */
  const closed = plan?.days?.length
    ? orderedDays(plan, 'no_school')
        .filter((d) => d.no_school)
        .map((d) => d.name)
    : []
  const teachingDays = 5 - closed.length

  return (
    <aside className={`artifact-rail${isBar ? ' is-bar' : ''}`} aria-label="Artifacts">
      <div className="rail-group">
        {isBar ? null : <span className="eyebrow">Artifacts</span>}

        {planId ? (
          /* The whole card expands the panel. Download stops the event: the one
             button a teacher came for must not also open a viewer they didn't
             ask for. */
          /* NOT a role="button" wrapping a link and a button.
             That is an ARIA structural violation, and it broke the keyboard
             outright: the card's onKeyDown fired on Enter bubbling up from the
             Download link and called preventDefault(), so tabbing to Download
             and pressing Enter opened the document and downloaded nothing —
             exactly the confusion the mouse handlers stopPropagation to avoid.
             The card is a plain container; the title is the button. */
          <div className="rail-card fa-lift" onClick={onExpand}>
            <span className="rail-card-head">
              <span className="rail-tile">
                <FileText size={15} aria-hidden="true" />
              </span>
              <button
                type="button"
                /* Stable id so ChatPage can put focus back here when the
                   document closes — see the restore effect there. */
                id="rail-open-title"
                className="rail-text rail-open-title"
                onClick={(e) => {
                  e.stopPropagation()
                  onExpand()
                }}
              >
                <span className="rail-title">{plan?.week_of || 'Weekly lesson plan'}</span>
                <span className="rail-sub">
                  .docx{artifact?.unit ? ` · ${artifact.unit}` : ''}
                </span>
              </button>
            </span>
            <span className="rail-actions">
              <a
                className="rail-download fa-press"
                href={api.planDownloadUrl(planId)}
                download
                onClick={(e) => e.stopPropagation()}
              >
                <Download size={11} aria-hidden="true" /> Download
              </a>
              <button
                type="button"
                className="rail-open fa-press"
                onClick={(e) => {
                  e.stopPropagation()
                  onExpand()
                }}
                aria-label="Open the document"
                title="Open the document"
              >
                <Eye size={12} aria-hidden="true" />
              </button>
            </span>
          </div>
        ) : busy ? (
          <div className="rail-row">
            <span className="rail-row-tile">
              <Loader2 size={13} className="animate-spin" aria-hidden="true" />
            </span>
            <span className="rail-text">
              <span className="rail-row-label">Writing the week</span>
              <span className="rail-sub">the .docx follows</span>
            </span>
          </div>
        ) : (
          <p className="rail-empty">Nothing built yet. Describe a week in the chat.</p>
        )}
      </div>

      {planId && !isBar ? (
        <div className="rail-group">
          <span className="eyebrow">Built from</span>

          <RailRow
            icon={Calendar}
            label="School calendar"
            sub={
              closed.length
                ? `${closed.join(', ')} · no school`
                : `${teachingDays} teaching days`
            }
            title="The plan's no-school days come from the school calendar"
          />

          {documents.map((doc) => (
            <RailRow
              key={doc.id}
              icon={FileText}
              label={doc.original_name}
              sub={artifact?.unit || doc.kind?.replace(/_/g, ' ') || 'course document'}
              title={doc.original_name}
            />
          ))}

          <RailRow
            icon={BookOpen}
            label={
              checking
                ? `${grounded.length} standard${grounded.length === 1 ? '' : 's'}`
                : 'Standards'
            }
            sub={
              !checking
                ? 'grounding not recorded'
                : ungrounded.length
                  ? `${ungrounded.length} not retrieved`
                  : 'all retrieved'
            }
            flag={checking && ungrounded.length > 0}
            title={checking ? grounded.join(', ') : undefined}
          />
        </div>
      ) : null}
    </aside>
  )
}
