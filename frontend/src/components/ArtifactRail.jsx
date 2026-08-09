import { useQuery } from '@tanstack/react-query'
import { BookOpen, Calendar, Download, Eye, FileText, Loader2 } from 'lucide-react'
import { api } from '../lib/api'
import { qk } from '../lib/queryKeys'
import { scanGrounding } from '../lib/grounding'
import { orderedDays } from '../lib/planShape'
import { classColor } from '../lib/classColor'

/* A quiet line-art sketch for the one moment the rail has nothing to show —
   an open notebook, not a stock "empty box" glyph. Authored, not a Unicode
   glyph standing in for an icon (craft-floor's own ban); currentColor so it
   themes with whatever wraps it rather than carrying its own hex. */
function EmptyRailArt({ color }) {
  return (
    <svg
      viewBox="0 0 64 48"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="rail-empty-art"
      style={{ color: `rgb(${color})` }}
    >
      <path d="M32 10 C27 6 19 5 10 6 L10 38 C19 37 27 38 32 42 C37 38 45 37 54 38 L54 6 C45 5 37 6 32 10 Z" />
      <path d="M32 10 L32 42" />
      <path d="M15 15 L26 14" opacity="0.55" />
      <path d="M15 21 L25 20" opacity="0.55" />
      <path d="M38 14 L49 15" opacity="0.55" />
      <path d="M39 20 L49 21" opacity="0.55" />
    </svg>
  )
}

/* The artifact rail — the content that fills the drawer once it's open (see
 * ArtifactDrawer at the bottom of this file for the always-mounted shell
 * around it).
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

/** The one row shape the rail's secondary lines share.
 *  `index` drives a staggered entrance — "Built from" fills in one line at a
 *  time rather than appearing as a block, which is the one place this rail
 *  can honestly gesture at the living-document framing: the calendar, the
 *  documents and the standards really did resolve in roughly that order, even
 *  though the stagger itself is a fixed 60ms, not a trace of real timing. */
function RailRow({ icon: Icon, label, sub, flag, onClick, title, index = 0 }) {
  const style = { animationDelay: `${index * 60}ms` }
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
      <div className="rail-row fa-rise" style={style} title={title}>
        {body}
      </div>
    )
  }
  return (
    <button
      type="button"
      className="rail-row is-interactive fa-press fa-rise"
      style={style}
      onClick={onClick}
      title={title}
    >
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
  const color = classColor(classId)

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
              {/* Tinted by the class's own colour (lib/classColor.js) rather
                  than the flat --paper-inset + --accent-text every artifact
                  used to share — a teacher with three preps could not tell
                  which class's rail they were looking at without reading the
                  text. Background at low alpha keeps it a tint, not a fill;
                  the icon carries the full colour. */}
              <span
                className="rail-tile"
                style={{ background: `rgb(${color.rgb} / 0.16)`, color: `rgb(${color.rgb})` }}
              >
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
          <div className="rail-empty">
            {/* No room for it in the one-row phone bar — same reasoning as
                dropping "Built from" a few lines up. */}
            {!isBar ? <EmptyRailArt color={color.rgb} /> : null}
            <p>Nothing built yet. Describe a week in the chat.</p>
          </div>
        )}
      </div>

      {planId && !isBar ? (
        <div className="rail-group">
          <span className="eyebrow">Built from</span>

          <RailRow
            index={0}
            icon={Calendar}
            label="School calendar"
            sub={
              closed.length
                ? `${closed.join(', ')} · no school`
                : `${teachingDays} teaching days`
            }
            title="The plan's no-school days come from the school calendar"
          />

          {documents.map((doc, i) => (
            <RailRow
              key={doc.id}
              index={i + 1}
              icon={FileText}
              label={doc.original_name}
              sub={artifact?.unit || doc.kind?.replace(/_/g, ' ') || 'course document'}
              title={doc.original_name}
            />
          ))}

          <RailRow
            index={documents.length + 1}
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

/* The persistent shell around ArtifactRail — always mounted, always showing
 * at least the coloured handle, whether or not this chat has built anything
 * yet. Kept separate from ArtifactRail itself rather than folded in: the
 * "bar" variant (phone, rendered inline above the composer) never goes
 * through a drawer at all, and mixing that concern into the same component
 * would mean every prop here needing an isBar escape hatch.
 *
 * Auto-opens the moment a build starts or a plan exists (ChatPage owns that
 * effect); afterward it is the teacher's to open or close, and closing it
 * once does not get silently overridden on the next render.
 */
export function ArtifactDrawer({ open, onToggle, hasArtifact, busy, ...railProps }) {
  return (
    <div className={`artifact-drawer${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className={`artifact-drawer-handle tap-target${busy ? ' is-busy' : ''}`}
        onClick={onToggle}
        aria-expanded={open}
        aria-label={open ? 'Collapse the artifacts drawer' : 'Open the artifacts drawer'}
        title={
          open
            ? 'Collapse'
            : hasArtifact || busy
              ? 'See what this week was built from'
              : 'Artifacts will appear here'
        }
      />
      {open ? (
        <div className="artifact-drawer-body">
          <ArtifactRail hasArtifact={hasArtifact} busy={busy} {...railProps} />
        </div>
      ) : null}
    </div>
  )
}
