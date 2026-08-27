import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  AlertTriangle,
  BookOpen,
  Calendar,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  ListChecks,
  Loader2,
} from 'lucide-react'
import { api } from '../lib/api'
import { qk } from '../lib/queryKeys'
import { scanGrounding } from '../lib/grounding'
import { orderedDays, unitSuffix } from '../lib/planShape'
import { questionTypesLabel } from '../lib/quizShape'
import { classColor } from '../lib/classColor'
import { shortDateTime } from '../lib/dates'
import { AccordionPanel } from './AccordionPanel'
import { ShareDialog } from './ShareDialog'

const RailGroup = ({ title, defaultOpen, forceOpen, isBar, children }) => {
  if (isBar) {
    return <div className="rail-group">{children}</div>
  }
  return (
    <AccordionPanel title={title} defaultOpen={defaultOpen} forceOpen={forceOpen}>
      <div className="rail-group border-none bg-transparent m-0 p-0">{children}</div>
    </AccordionPanel>
  )
}
import { WeekStrip } from './WeekStrip'
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

/** The one row shape the rail's secondary lines share.
 *  `index` drives a staggered entrance — "Built from" fills in one line at a
 *  time rather than appearing as a block, which is the one place this rail
 *  can honestly gesture at the living-document framing: the calendar, the
 *  documents and the standards really did resolve in roughly that order, even
 *  though the stagger itself is a fixed 60ms, not a trace of real timing. */
function RailRow({ icon: Icon, label, sub, flag, onClick, title, index = 0 }) {
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
      <motion.div
        className="rail-row"
        title={title}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: index * 0.06 }}
      >
        {body}
      </motion.div>
    )
  }
  // Hover used to also carry a framer-motion whileHover (scale/lift/tint) on
  // top of .rail-row.is-interactive's own CSS :hover background — same effect
  // fired twice, fighting each other on every mouseenter and reading as
  // bouncy next to the plan card's plain CSS hover. CSS-only now, everywhere.
  return (
    <motion.button
      type="button"
      className="rail-row is-interactive fa-press"
      title={title}
      onClick={onClick}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.06 }}
    >
      {body}
    </motion.button>
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
  const subLine = (
    <>
      <span className="rail-sub">
        Quiz · QTI · {questionTypesLabel(quiz.question_types)}
        {count ? ` · ${count} question${count === 1 ? '' : 's'}` : ''}
        {quiz.has_qti ? '' : ' (failed to build, ask again)'}
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
            onClick={(e) => {
              e.stopPropagation()
              onOpen(quiz)
            }}
          >
            <span className="rail-title">{quiz.title}</span>
            {subLine}
          </button>
        ) : (
          <span className="rail-text">
            <span className="rail-title">{quiz.title}</span>
            {subLine}
          </span>
        )}
      </span>
      <span className="rail-actions flex items-center">
        {quiz.has_qti ? (
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
              toast.apiError('Quiz file failed to build', new Error('Please ask the AI to generate this quiz again in the chat to rebuild the Canvas QTI file.'))
            }}
            title="The file failed to build — ask again in chat to rebuild it"
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
  // Opens the same embossed panel the plan card does (see onExpand above),
  // just pointed at a different kind of content — ArtifactDetailPanel in
  // ChatPage.jsx switches on what each of these was given. Not gated behind
  // isBar: the phone bar never renders the rows these belong to at all, so
  // there's nothing there to wire up.
  onOpenQuiz,
  onOpenStandards,
  onOpenCalendar,
  onOpenDocument,
  // Drops a starter prompt into the composer — see AccordionSkeleton, the
  // empty-rail state before any plan exists for this chat. Optional: when
  // omitted the skeleton falls back to its old inert-preview rendering.
  onSuggestPrompt,
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
    <aside className={`artifact-rail${isBar ? ' is-bar' : ' p-3'}`} aria-label="Materials">
      {planId || busy || artifactLoadError ? (
        <RailGroup title="Materials" defaultOpen={true} isBar={isBar}>
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
                  Document · DOCX{unitSuffix(artifact?.unit, ' · ')}
                </span>
              </button>
            </span>
            <span className="rail-actions flex items-center">
              <button
                type="button"
                className="rail-open fa-press"
                onClick={(e) => {
                  e.stopPropagation()
                  setShareTarget({ type: 'plan' })
                }}
                aria-label="Download or Share"
                title="Download or Share"
              >
                <Download size={13} aria-hidden="true" />
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
      ) : (
        <AccordionSkeleton color={color} onSuggestPrompt={onSuggestPrompt} />
      )}

      {/* Quizzes over this plan — right under My Plans, ahead of Built From:
          a quiz is a second artifact this conversation produced, the same
          rank as the plan itself, not a citation the plan rests on. Reachable
          in the phone bar too, unlike Built From below — a built quiz is a
          real deliverable a teacher would want off their phone, not a
          citation the plan rests on. Shown whenever there's something to
          show (a build in progress, or an already-built quiz), not gated
          behind planId the same strict way Built From is — quizBuilding can
          be true for one render right after the request lands, before the
          query below has anything cached yet. */}
      {quizBuilding || quizzes.length > 0 ? (
        <RailGroup title="Quizzes" defaultOpen={false} isBar={isBar}>
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
      ) : null}

      {planId && !isBar ? (
        <RailGroup title="Built from" defaultOpen={false} isBar={isBar}>

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
            // Capped rather than the full list: a plan citing a few dozen
            // standards turned this into one giant, unwrapped tooltip line.
            // Click-through to the Standards row itself is still the real
            // answer for "show me all of them."
            title={
              checking
                ? grounded.length > 8
                  ? `${grounded.slice(0, 8).join(', ')}, and ${grounded.length - 8} more`
                  : grounded.join(', ')
                : undefined
            }
            onClick={onOpenStandards}
          />
        </RailGroup>
      ) : null}

      {/* The day-by-day breakdown — used to live in the chat message itself
          (see Message.jsx and ChatPage's own writing-progress block, both of
          which now skip it on desktop). Under everything else: "My plans"
          and "Built from" are both about what the plan IS, this is about
          what's actually written in it, the last thing worth checking once
          the rest is settled. Not in the phone bar: there's no room for a
          five-row list in a one-row bar, so phone keeps its copy inline in
          chat instead — see the isPhone check at both those call sites. */}
      {!isBar && (planId ? plan?.days?.length : busy) ? (
        // forceOpen while a week is actually being written — a teacher
        // shouldn't have to know to go click this open to watch Mon–Fri
        // check off as they land; see AccordionPanel's own comment for why
        // this is forceOpen and not just defaultOpen={busy}.
        <RailGroup title="This week" defaultOpen={false} forceOpen={busy && !planId} isBar={isBar}>
          <WeekStrip days={plan?.days} writing={!planId} loose />
        </RailGroup>
      ) : null}

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
 * A bare conditional {open ? <div>…</div> : null} — same as the nav rail's
 * own collapse on the other side of the screen (AppShell.jsx), which only
 * ever animates its own width and lets the content just be there or not.
 * This used to also keep the body mounted for an extra tick to play its own
 * mirrored slide-and-fade on top of that width change, on the theory that a
 * plain unmount read as unpolished. In practice the two competing motions —
 * the container's width easing open while the content separately slides in
 * from its own offset — read as the panel glitching or shrinking rather
 * than opening cleanly, which is exactly what the nav rail's plainer version
 * doesn't do. One motion, not two: the width transition below is the whole
 * animation now.
 */
export function ArtifactDrawer({ open, onToggle, hasArtifact, busy, ...railProps }) {
  return (
    // glass-panel + rounded-2xl, same treatment as the left nav rail's own
    // outer wrapper (AppShell.jsx's .app-rail) and the chat pane itself —
    // this was the one docked panel still opaque (bg-paper-raised) instead
    // of showing the drifting background orbs through it. Applied to the
    // OUTER .artifact-drawer div, not just .artifact-drawer-body, so the
    // collapsed 18px handle strip reads as the same glass panel narrowed,
    // rather than a flat sliver in front of a glass panel that only exists
    // once open.
    <div className={`artifact-drawer glass-panel rounded-2xl shadow-sm overflow-hidden${open ? ' is-open' : ''}`}>
      <button
        type="button"
        /* No .fa-press here — that class's :active state applies
           translateY+scale(0.98), a real shrink-and-drop the instant the
           button is pressed, independent of the open/close width transition
           entirely. The left nav rail's own handle (AppShell.jsx's
           .app-rail-handle) never had it and only ever fades its opacity on
           press — this now matches that. */
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
        {/* Always drawn, not just while closed, so the handle reads as
            clickable in both states — the nav rail's own handle on the
            other side of the screen (AppShell.jsx) does the same. Points
            the way this click will move the drawer: left while closed
            (pulls this edge OUT into a panel that grows leftward), right
            once open (collapses it back). */}
        {open ? (
          <ChevronRight className="artifact-drawer-arrow" aria-hidden="true" />
        ) : (
          <ChevronLeft className="artifact-drawer-arrow" aria-hidden="true" />
        )}
      </button>
      {open ? (
        <div className="artifact-drawer-body h-full">
          <ArtifactRail hasArtifact={hasArtifact} busy={busy} {...railProps} />
        </div>
      ) : null}
    </div>
  )
}


/* Was three inert preview cards ("...will appear here"), permanently
 * opacity-60/pointer-events-none — pure description of what the rail would
 * eventually hold, nothing to act on before that. Now three parallel
 * invitations instead: each drops a starter prompt into the composer (via
 * onSuggestPrompt, ChatPage's setQuery + refocus) so a teacher looking at an
 * empty rail has something to click rather than something to wait out.
 *
 * Deliberately NOT the checklist-with-checkmarks pattern (numbered,
 * sequential, permanently completed) — these three aren't one-time
 * onboarding milestones, they're three concurrent facets of THIS week's
 * plan that get rebuilt every week. A checkmark here would still read
 * "done" next week before anything for that week exists. */
const STARTER_CARDS = [
  {
    icon: Calendar,
    title: 'Week Overview',
    desc: "Core objectives, daily breakdown, and standards for this week.",
    prompt: "Build this week's lesson plan.",
  },
  {
    icon: FileText,
    title: 'Materials & Resources',
    desc: 'Worksheets, reading texts, and slide decks generated for this plan.',
    prompt: 'Generate the worksheets and materials for this week.',
  },
  {
    icon: ListChecks,
    title: 'Assessments',
    desc: "Quizzes, rubrics, and exit tickets tied to this week's instruction.",
    prompt: 'Build a quiz for this week.',
  },
]

function AccordionSkeleton({ color, onSuggestPrompt }) {
  const interactive = Boolean(onSuggestPrompt)
  return (
    <div className="flex flex-col gap-4 p-4 w-full">
      {STARTER_CARDS.map((card, i) => {
        const Icon = card.icon
        const Wrapper = interactive ? motion.button : motion.div
        return (
          <Wrapper
            key={card.title}
            type={interactive ? 'button' : undefined}
            className={`bg-paper-sunken border border-edge rounded-2xl p-5 flex flex-col gap-3 text-left w-full${
              interactive ? ' rail-starter-card fa-press' : ''
            }`}
            onClick={interactive ? () => onSuggestPrompt(card.prompt) : undefined}
            title={interactive ? `Ask: “${card.prompt}”` : undefined}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.06 }}
          >
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <span
                  className="rail-tile"
                  style={{ background: `rgb(${color.rgb} / 0.16)`, color: `rgb(${color.rgb})` }}
                >
                  <Icon size={14} aria-hidden="true" />
                </span>
                <span className="text-[13px] font-semibold text-ink">{card.title}</span>
              </span>
              {interactive ? (
                <ChevronRight size={14} className="text-ink-muted" aria-hidden="true" />
              ) : (
                <ChevronDown size={14} className="text-ink-muted" aria-hidden="true" />
              )}
            </div>
            <p className="text-[12px] text-ink-muted/90 leading-relaxed pr-4">
              {card.desc}
            </p>
          </Wrapper>
        )
      })}
    </div>
  );
}
