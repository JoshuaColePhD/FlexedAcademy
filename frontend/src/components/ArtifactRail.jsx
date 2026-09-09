import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  ListChecks,
  Loader2,
  X,
} from 'lucide-react'
import { api } from '../lib/api'
import { qk } from '../lib/queryKeys'
import { unitSuffix } from '../lib/planShape'
import { questionTypesLabel } from '../lib/quizShape'
import { classColor } from '../lib/classColor'
import { shortDateTime } from '../lib/dates'
import { ShareDialog } from './ShareDialog'
import { DocxDownloadButton } from './DocxDownloadButton'

const RailGroup = ({ title, headerTitle = title, isBar, children }) => {
  if (isBar) {
    return <div className="rail-group">{children}</div>
  }
  return (
    <section className="mb-3 overflow-hidden rounded-xl border border-edge bg-paper-raised shadow-sm" aria-label={title}>
      <div className="border-b border-edge bg-transparent px-3 py-2.5">
      <span className="text-sm font-semibold text-ink">{headerTitle}</span>
      </div>
      <div className="rail-group border-none bg-transparent p-1">{children}</div>
    </section>
  )
}
import { useToast } from '../lib/toastContext'



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

/** Secondary source rows appear immediately, without staggered animation. */
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
      <div
        className="rail-row"
        title={title}
      >
        {body}
      </div>
    )
  }
  // Hover used to also carry a framer-motion whileHover (scale/lift/tint) on
  // top of .rail-row.is-interactive's own CSS :hover background — same effect
  // fired twice, fighting each other on every mouseenter and reading as
  // bouncy next to the plan card's plain CSS hover. CSS-only now, everywhere.
  return (
    <button
      type="button"
      className="rail-row is-interactive fa-press"
      title={title}
      onClick={onClick}
    >
      {body}
    </button>
  )
}

/* One built quiz — its own row rather than reusing RailRow, which has no
 * room for a labeled Download pill alongside the label.
 * A quiz with no qti_path (has_qti false — the LLM call succeeded but the
 * local zip write failed) still shows, with Download disabled rather than
 * the whole row vanishing: the questions are safe in the database either
 * way (quiz_json), and the title says so on hover. */
/* Used to also carry a small Remove (X) button beside Download — a quiz has
 * no draft state to discard and no real reason to delete once built, so
 * that second control was a destructive action sitting next to the one a
 * teacher actually came for, answering a question ("why would you want to
 * delete it?") nobody was asking. Download is the row's only action now. */
function QuizRow({ quiz, index = 0, onOpen, color, onShare }) {
  const toast = useToast()
  // Asking for "a new quiz" for a week that already has one doesn't revise
  // the existing row — it inserts a second one (see plans.py's create_quiz),
  // and the model tends to hand both the same title for the same week's
  // content ("Week 05 Quiz — Rhetorical..." twice, word for word). Without
  // something else to go on, two such rows were visually identical: same
  // title, same question-type label, no way to tell which is newer or
  // whether they even differ. Question count and a built timestamp are
  // both already on the record (quiz_json, created_at) — surfacing them
  // costs no backend change and is real information, not decoration: two
  // otherwise-identical cards NOW read "10 questions · Aug 22, 9:41 AM" vs
  // "8 questions · Aug 22, 9:48 AM".
  const count = quiz.quiz_json?.questions?.length
  const built = shortDateTime(quiz.created_at)
  const formats = [quiz.has_docx && 'Word', quiz.has_qti && 'QTI'].filter(Boolean).join(' · ') || 'no exports'
  const missingFormats = [!quiz.has_docx && 'Word', !quiz.has_qti && 'QTI'].filter(Boolean).join(' and ')
  const subLine = (
    <>
      <span className="rail-sub">
        Quiz · {formats} · {questionTypesLabel(quiz.question_types)}
        {count ? ` · ${count} question${count === 1 ? '' : 's'}` : ''}
        {missingFormats ? ` (${missingFormats} export unavailable)` : ''}
      </span>
      {built ? <span className="rail-sub">{built}</span> : null}
    </>
  )

  return (
    <motion.div
      className="rail-card fa-lift"
      onClick={onOpen ? () => onOpen(quiz) : undefined}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.06 }}
    >
      <span className="rail-card-head">
        <span
          className="rail-tile"
          style={{ background: `rgb(${color.rgb} / 0.16)`, color: `rgb(${color.rgb})` }}
        >
          <ListChecks size={15} aria-hidden="true" />
        </span>
        {onOpen ? (
          <button
            type="button"
            className="rail-text rail-open-title"
            aria-label={`${quiz.title} Quiz`}
            title={quiz.title}
            onClick={(e) => {
              e.stopPropagation()
              onOpen(quiz)
            }}
          >
            <span className="rail-title">{compactQuizTitle(quiz.title)}</span>
            {subLine}
          </button>
        ) : (
          <span className="rail-text">
            <span className="rail-title">{compactQuizTitle(quiz.title)}</span>
            {subLine}
          </span>
        )}
      </span>
      <span className="rail-actions flex items-center">
        {quiz.has_qti || quiz.has_docx ? (
          <button
            type="button"
            className="rail-open fa-press"
            onClick={(e) => {
              e.stopPropagation()
              onShare(quiz)
            }}
            aria-label={`Download ${quiz.title}`}
            title="Download or Share"
          >
            <Download size={13} aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            className="rail-open is-disabled"
            aria-disabled="true"
            onClick={(e) => {
              e.stopPropagation()
              toast.apiError('Quiz exports failed to build', new Error('Please ask the AI to generate this quiz again in the chat to rebuild the Word and QTI files.'))
            }}
            title="The quiz exports failed to build — ask again in chat to rebuild them"
          >
            <Download size={13} aria-hidden="true" />
          </button>
        )}
      </span>
    </motion.div>
  )
}


// Two is the common real case — a first attempt and a revision — and stays
// readable with no disclosure at all. Past that, a plan that's accumulated
// several "make me a new quiz" requests over a semester would otherwise turn
// the rail into a long scroll of quiz cards before a teacher ever reaches
// "Built from" or "This week" below. Collapsing anything past the two most
// recent behind a tap keeps the common case exactly as it was.
const VISIBLE_QUIZZES = 2

function compactQuizTitle(title) {
  const value = String(title || '').trim()
  if (!value) return 'Quiz'
  return value
    .replace(/^Week\s+\d+\s*/i, '')
    .replace(/\s+—\s+/g, ' · ')
}

export function ArtifactRail({
  artifact,
  classId,
  onExpand,
  busy,
  variant = 'rail',
  // Whether a quiz is being generated right now for THIS plan — ChatPage's
  // own state, passed down rather than inferred here, since the request
  // that triggers it (a chat message) and the card that shows its progress
  // live in different components.
  quizBuilding = false,
  updating = false,
  // Opens the same embossed panel the plan card does (see onExpand above),
  // just pointed at a different kind of content — ArtifactDetailPanel in
  // ChatPage.jsx switches on what each of these was given. Not gated behind
  // isBar: the phone bar never renders the rows these belong to at all, so
  // there's nothing there to wire up.
  onOpenQuiz,
  // True only when a plan is KNOWN to exist for this chat (a message or
  // the plans table named its id) and fetching it failed — see ChatPage's
  // own reload effect. Distinct from "nothing built yet," the plain
  // rail-empty state below: conflating the two would show a stale rail
  // standing in for a real plan that just failed to load.
  artifactLoadError = false,
  // Re-runs just the failed plan fetch — see ChatPage's retryArtifactLoad.
  // Falls back to a full reload only if a caller genuinely has nothing
  // better to offer, so this never regresses to a hard crash on a stray
  // render that forgot to pass it.
  onRetryArtifact = () => window.location.reload(),
}) {
  const [shareTarget, setShareTarget] = useState(null)
  // One-way: once a teacher taps through to see the older attempts, there's
  // no reason to hide them again for the rest of this rail's life, so this
  // is a reveal, not a toggle with its own collapsed-again affordance.
  const [quizzesExpanded, setQuizzesExpanded] = useState(false)
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

  return (
    <aside className={`artifact-rail${isBar ? ' is-bar' : ' p-3'}`} aria-label="Outputs">
      <div className={isBar ? 'artifact-rail-bar-content' : 'artifact-rail-scroll'}>
      {planId || busy || artifactLoadError ? (
        <RailGroup title="Lesson plans" isBar={isBar}>
          {planId ? (
          /* Reading is the primary action. The full content area is one real
             button, while download remains its separate, unambiguous sibling
             so a phone tap never has to guess between opening and exporting. */
          <div className="rail-card fa-lift">
            <button
              type="button"
              id="rail-open-title"
              className="rail-card-reader"
              onClick={onExpand}
              aria-label={`Open ${plan?.week_of || 'weekly lesson plan'}`}
            >
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
              <span className="rail-text rail-open-title">
                <span className="rail-title">{plan?.week_of || 'Weekly lesson plan'}</span>
                <span className="rail-sub">
                  {updating ? (
                    <>
                      <Loader2 size={12} className="inline animate-spin" aria-hidden="true" /> Updating the week
                    </>
                  ) : (
                    <>View lesson plan{unitSuffix(artifact?.unit, ' · ')}</>
                  )}
                </span>
              </span>
              </span>
              <ChevronRight className="rail-reader-chevron" size={16} aria-hidden="true" />
            </button>
            <span className="rail-actions flex items-center">
              <DocxDownloadButton
                planId={planId}
                className="rail-open fa-press"
                aria-label="Download as DOCX"
                title="Download as DOCX"
              >
                <Download size={13} aria-hidden="true" />
              </DocxDownloadButton>
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
        ) : artifactLoadError ? (
          /* A real plan exists for this chat (a message or the plans table
             named its id) and fetching it just failed — NOT the same as
             "nothing built yet," the plain rail-empty state below. Checked
             first, so a failed load never falls through to that empty
             state — reading as "nothing was built" when the opposite is
             true. */
          <div className="rail-empty">
            <AlertTriangle size={20} aria-hidden="true" className="text-mark" />
            <p>Couldn’t load this week’s plan.</p>
            <button type="button" className="btn text-xs" onClick={onRetryArtifact}>
              Reload
            </button>
          </div>
        ) : null}
        </RailGroup>
      ) : null}
      {quizBuilding || quizzes.length > 0 ? (
        <RailGroup title="Assessments" isBar={isBar}>
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
          {(quizzesExpanded ? quizzes : quizzes.slice(0, VISIBLE_QUIZZES)).map((quiz, i) => (
            <QuizRow key={quiz.id} quiz={quiz} index={i} onOpen={onOpenQuiz} color={color} onShare={(quiz) => setShareTarget({ type: 'quiz', quiz })} />
          ))}
          {!quizzesExpanded && quizzes.length > VISIBLE_QUIZZES ? (
            <RailRow
              index={VISIBLE_QUIZZES}
              icon={ChevronDown}
              label={`${quizzes.length - VISIBLE_QUIZZES} earlier attempt${
                quizzes.length - VISIBLE_QUIZZES === 1 ? '' : 's'
              }`}
              sub="Tap to show"
              onClick={() => setQuizzesExpanded(true)}
            />
          ) : null}
        </RailGroup>
      ) : (
        !planId && !busy && !artifactLoadError ? (
          <p className="rail-empty px-2 py-3 text-sm text-ink-muted">Outputs from this chat will appear here.</p>
        ) : null
      )}

      </div>

      <ShareDialog
        open={!!shareTarget}
        onClose={() => setShareTarget(null)}
        planId={planId}
        isQuiz={shareTarget?.type === 'quiz'}
        quizId={shareTarget?.quiz?.id}
        documentName={shareTarget?.type === 'quiz' ? shareTarget.quiz.title : plan?.week_of}
      />
    </aside>
  )
}

/* The persistent floating shell around ArtifactRail — mounted as a quiet
 * inspector card once a plan exists. Kept separate from ArtifactRail itself
 * rather than folded in: the "bar" variant (phone, rendered inline above the
 * composer) never goes through a drawer at all, and mixing that concern into
 * the same component would mean every prop here needing an isBar escape hatch.
 *
 * Auto-opens the moment a build starts or a plan exists (ChatPage owns that
 * effect); afterward it is the teacher's to open or close, and closing it
 * once does not get silently overridden on the next render.
 *
 * The side seam no longer carries a second chevron button: the card itself is
 * the affordance, matching the reference inspector. `open` is still owned by
 * ChatPage so the panel can be hidden while a document overlay is active.
 */
export function ArtifactDrawer({ open, onClose, hasArtifact, busy, ...railProps }) {
  if (!open) return null

  return (
    // glass-panel + rounded-2xl, same treatment as the left nav rail's own
    // outer wrapper (AppShell.jsx's .app-rail) and the chat pane itself.
    <div id="artifacts-panel" className={`artifact-drawer glass-panel rounded-2xl shadow-sm overflow-hidden${open ? ' is-open' : ''}`}>
      <div className="artifact-drawer-heading">
        <span>Outputs</span>
        <button type="button" className="btn-icon" onClick={onClose} aria-label="Close workspace" title="Close workspace"><X size={18} aria-hidden="true" /></button>
      </div>
      <div className="artifact-drawer-body h-full">
        <ArtifactRail hasArtifact={hasArtifact} busy={busy} {...railProps} />
      </div>
    </div>
  )
}
