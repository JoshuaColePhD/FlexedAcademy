import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, Calendar, ChevronLeft, Download, Eye, FileText, ListChecks, Loader2, X } from 'lucide-react'
import { api } from '../lib/api'
import { qk } from '../lib/queryKeys'
import { scanGrounding } from '../lib/grounding'
import { orderedDays, unitSuffix } from '../lib/planShape'
import { questionTypesLabel } from '../lib/quizShape'
import { classColor } from '../lib/classColor'
import { useToast } from '../lib/toastContext'
import { useExitTransition } from '../hooks/useExitTransition'
import { DecisionStack } from './DecisionStack'

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

/* One built quiz — its own row rather than reusing RailRow, which has no
 * room for two independent actions (Download, Delete) alongside the label.
 * A quiz with no qti_path (has_qti false — the LLM call succeeded but the
 * local zip write failed) still shows, with Download disabled rather than
 * the whole row vanishing: the questions are safe in the database either
 * way (quiz_json), and the title says so on hover. */
/* Was a flat .rail-row with an icon-only Download and no visible action at
 * all once has_qti was false (just Remove, sitting alone — a card that
 * looks like the only thing left to do with a failed quiz is delete it).
 * Now the same raised .rail-card treatment the plan itself gets, with the
 * same shape: a labeled Download pill first, Remove second and small. A
 * failed build keeps that same Download slot, just inert (see
 * .rail-download.is-disabled) — reads as "retry by asking again in chat,"
 * not as a control that vanished. */
function QuizRow({ quiz, planId, index = 0, onOpen, color }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [deleting, setDeleting] = useState(false)
  const style = { animationDelay: `${index * 60}ms` }

  const remove = async (e) => {
    e.stopPropagation()
    setDeleting(true)
    try {
      await api.deleteQuiz(planId, quiz.id)
      qc.setQueryData(qk.quizzes(planId), (old) => (old || []).filter((q) => q.id !== quiz.id))
    } catch (err) {
      toast.apiError('Could not remove that quiz', err)
      setDeleting(false)
    }
  }

  return (
    <div
      className="rail-card fa-lift fa-rise"
      style={style}
      onClick={onOpen ? () => onOpen(quiz) : undefined}
    >
      <span className="rail-card-head">
        <span
          className="rail-tile"
          style={{ background: `rgb(${color.rgb} / 0.16)`, color: `rgb(${color.rgb})` }}
        >
          {deleting ? (
            <Loader2 size={15} className="animate-spin" aria-hidden="true" />
          ) : (
            <ListChecks size={15} aria-hidden="true" />
          )}
        </span>
        {onOpen ? (
          <button
            type="button"
            className="rail-text rail-open-title"
            onClick={(e) => {
              e.stopPropagation()
              onOpen(quiz)
            }}
          >
            <span className="rail-title">{quiz.title}</span>
            <span className="rail-sub">
              {questionTypesLabel(quiz.question_types)}
              {quiz.has_qti ? '' : ' · file failed, ask again'}
            </span>
          </button>
        ) : (
          <span className="rail-text">
            <span className="rail-title">{quiz.title}</span>
            <span className="rail-sub">
              {questionTypesLabel(quiz.question_types)}
              {quiz.has_qti ? '' : ' · file failed, ask again'}
            </span>
          </span>
        )}
      </span>
      <span className="rail-actions">
        {quiz.has_qti ? (
          <a
            className="rail-download fa-press"
            href={api.quizDownloadUrl(planId, quiz.id)}
            download
            onClick={(e) => e.stopPropagation()}
            aria-label={`Download ${quiz.title} as a QTI zip`}
            title="Download as a QTI zip — imports into Canvas as a Classic Quiz"
          >
            <Download size={11} aria-hidden="true" /> Download
          </a>
        ) : (
          <span
            className="rail-download is-disabled"
            aria-disabled="true"
            title="The file failed to build — ask again in chat to rebuild it"
          >
            <Download size={11} aria-hidden="true" /> Download
          </span>
        )}
        <button
          type="button"
          className="rail-open fa-press"
          onClick={remove}
          disabled={deleting}
          aria-label={`Remove ${quiz.title}`}
          title="Remove this quiz"
        >
          <X size={12} aria-hidden="true" />
        </button>
      </span>
    </div>
  )
}


export function ArtifactRail({
  artifact,
  classId,
  onExpand,
  busy,
  decisions = [],
  variant = 'rail',
  // Whether a quiz is being generated right now for THIS plan — ChatPage's
  // own state, passed down rather than inferred here, since the request
  // that triggers it (a chat message) and the card that shows its progress
  // live in different components.
  quizBuilding = false,
  // Opens the same embossed panel the plan card does (see onExpand above),
  // just pointed at a different kind of content — ArtifactDetailPanel in
  // ChatPage.jsx switches on what each of these was given. Not gated behind
  // isBar: the phone bar never renders the rows these belong to at all, so
  // there's nothing there to wire up.
  onOpenQuiz,
  onOpenStandards,
  onOpenCalendar,
  onOpenDocument,
}) {
  const plan = artifact?.plan
  const planId = artifact?.planId
  /* Every quiz already built for this plan (backend db.py migration 26) —
     fetched here rather than passed down, same call ChatPage would
     otherwise have to make and hand through as one more prop. Invalidated
     by ChatPage the moment a new one finishes building (qk.quizzes(planId)),
     so this list picks it up without polling. */
  const { data: quizzes = [] } = useQuery({
    queryKey: qk.quizzes(planId),
    queryFn: () => api.listQuizzes(planId),
    enabled: Boolean(planId),
    retry: false,
    staleTime: 30_000,
  })
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
    <aside className={`artifact-rail${isBar ? ' is-bar' : ''}`} aria-label="My plans">
      <div className="rail-group">
        {isBar ? null : <span className="eyebrow">My plans</span>}

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
                  .docx{unitSuffix(artifact?.unit, ' · ')}
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
        ) : !isBar && decisions.length ? (
          /* Before a plan exists, this is where "the plan so far" lives —
             voice mode's own deck (see DecisionStack), shown here now too so
             a teacher typing can see what's already been settled without
             opening voice mode at all. Replaces the bare empty state the
             moment there's anything to show; reverts to it if the chat
             restarts with nothing decided yet. */
          <DecisionStack decisions={decisions} fill={false} />
        ) : (
          <div className="rail-empty">
            {/* No room for it in the one-row phone bar — same reasoning as
                dropping "Built from" a few lines up. */}
            {!isBar ? <EmptyRailArt color={color.rgb} /> : null}
            <p>Nothing built yet. Describe a week in the chat.</p>
          </div>
        )}
      </div>

      {/* Quizzes over this plan — right under My Plans, ahead of Built From:
          a quiz is a second artifact this conversation produced, the same
          rank as the plan itself, not a citation the plan rests on. Only in
          the full rail, same reasoning as Built From below: the phone bar's
          whole point is "the file and its Download, nothing else." Shown
          whenever there's something to show (a build in progress, or an
          already-built quiz), not gated behind planId the same strict way
          Built From is — quizBuilding can be true for one render right
          after the request lands, before the query below has anything
          cached yet. */}
      {!isBar && (quizBuilding || quizzes.length > 0) ? (
        <div className="rail-group">
          <span className="eyebrow">Quizzes</span>
          {quizBuilding ? (
            <div className="rail-row fa-rise">
              <span className="rail-row-tile">
                <Loader2 size={13} className="animate-spin" aria-hidden="true" />
              </span>
              <span className="rail-text">
                <span className="rail-row-label">Building quiz…</span>
                <span className="rail-sub">grounded in this week's own plan</span>
              </span>
            </div>
          ) : null}
          {quizzes.map((quiz, i) => (
            <QuizRow key={quiz.id} quiz={quiz} planId={planId} index={i} onOpen={onOpenQuiz} color={color} />
          ))}
        </div>
      ) : null}

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
            onClick={onOpenCalendar}
          />

          {documents.map((doc, i) => (
            <RailRow
              key={doc.id}
              index={i + 1}
              icon={FileText}
              label={doc.original_name}
              sub={artifact?.unit || doc.kind?.replace(/_/g, ' ') || 'course document'}
              title={doc.original_name}
              onClick={onOpenDocument ? () => onOpenDocument(doc) : undefined}
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
            onClick={onOpenStandards}
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
 *
 * The body used to be a bare conditional {open ? <div>…</div> : null} —
 * appearing already full-width the instant `open` flipped, and vanishing
 * with no exit animation at all, unlike every other drawer in this app
 * (the phone nav rail, the document overlay, every dialog/toast) which
 * plays a mirrored close via useExitTransition. `mounted` keeps the node
 * around for one more tick so the CSS exit animation below has something
 * to play on; `open` itself still drives the outer width immediately, so
 * the handle springs open at once and the content eases in behind it.
 */
export function ArtifactDrawer({ open, onToggle, hasArtifact, busy, ...railProps }) {
  const { mounted, closing } = useExitTransition(open, 130)
  return (
    <div className={`artifact-drawer${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className={`artifact-drawer-handle tap-target${busy ? ' is-busy' : ''}`}
        onClick={onToggle}
        aria-expanded={open}
        aria-label={open ? 'Collapse my plans' : 'Open my plans'}
        title={
          open
            ? 'Collapse'
            : hasArtifact || busy
              ? 'See what this week was built from'
              : 'Your plan will appear here'
        }
      >
        {/* Left, not right — it points the way the drawer itself moves:
            open pulls this edge OUT into a panel that grows leftward. Only
            drawn while closed; once open, the panel itself is the answer to
            "does this open." */}
        {!open ? <ChevronLeft className="artifact-drawer-arrow" aria-hidden="true" /> : null}
      </button>
      {mounted ? (
        <div className={`artifact-drawer-body${closing ? ' is-closing' : ''}`}>
          <ArtifactRail hasArtifact={hasArtifact} busy={busy} {...railProps} />
        </div>
      ) : null}
    </div>
  )
}
