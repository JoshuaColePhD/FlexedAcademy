import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronsRight, Download, Loader2, Edit2, Save, X } from 'lucide-react'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { PANEL_OVERLAY, useMediaQuery } from '../hooks/useMediaQuery'
import { classColor } from '../lib/classColor'
import { unitSuffix } from '../lib/planShape'
import { shortRange } from '../lib/dates'
import { WEEK_STATUS, weekStatus } from '../lib/weekStatus'
import { QUESTION_TYPE_LABELS, questionTypesLabel } from '../lib/quizShape'
import { Skeleton, SkeletonText } from './Skeleton'
import { ShareDialog } from './ShareDialog'

/* The same embossed shell ArtifactPanel uses for the lesson plan itself
 * (.doc-shell/.doc-head/.doc-body — see that component's own header
 * comment), reused here for everything else the rail lists as clickable:
 * a built quiz, the standards a week actually cited, the school calendar
 * behind it, and an uploaded document. One shell, four bodies, rather than
 * four bespoke panels that would each have to re-solve "how does this open
 * and close" on its own.
 *
 * Read-only by design, same reasoning ArtifactPanel gives for dropping Edit:
 * a quiz is revised by asking in chat, not by a second writer of the same
 * artifact.
 */

function QuizQuestionCard({ q, index, onUpdate }) {
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState(q)

  // Reset draft if prop changes while not editing
  useEffect(() => {
    if (!isEditing) setDraft(q)
  }, [q, isEditing])

  const handleSave = () => {
    onUpdate(draft)
    setIsEditing(false)
  }

  const handleCancel = () => {
    setDraft(q)
    setIsEditing(false)
  }

  if (isEditing) {
    return (
      <div className="detail-card neo-raised fa-rise" style={{ animationDelay: `${index * 60}ms` }}>
        <div className="detail-card-head mb-2">
          <span className="detail-card-index">Q{index + 1} Edit</span>
          <span className="detail-card-type">{QUESTION_TYPE_LABELS[q.type] || q.type}</span>
          <div className="ml-auto flex items-center gap-2">
            <button type="button" className="p-1 text-ink-muted hover:text-ink transition-colors" onClick={handleCancel} title="Cancel">
              <X size={14} />
            </button>
            <button type="button" className="p-1 text-primary hover:text-primary-dark transition-colors" onClick={handleSave} title="Save">
              <Save size={14} />
            </button>
          </div>
        </div>
        <textarea
          className="input w-full text-sm mb-3 resize-y min-h-[60px]"
          value={draft.prompt}
          onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
        />

        {q.type === 'multiple_choice' ? (
          <ul className="flex flex-col gap-2">
            {(draft.choices || []).map((choice, i) => (
              <li key={i} className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`q${index}-correct`}
                  checked={i === draft.correct_index}
                  onChange={() => setDraft({ ...draft, correct_index: i })}
                  className="shrink-0"
                />
                <input
                  className="input w-full text-sm py-1 px-2"
                  value={choice}
                  onChange={(e) => {
                    const newChoices = [...draft.choices]
                    newChoices[i] = e.target.value
                    setDraft({ ...draft, choices: newChoices })
                  }}
                />
              </li>
            ))}
          </ul>
        ) : null}

        {q.type === 'true_false' ? (
          <div className="flex gap-4">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="radio" name={`q${index}-tf`} checked={draft.correct_bool === true} onChange={() => setDraft({ ...draft, correct_bool: true })} /> True
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="radio" name={`q${index}-tf`} checked={draft.correct_bool === false} onChange={() => setDraft({ ...draft, correct_bool: false })} /> False
            </label>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="detail-card neo-raised fa-rise group" style={{ animationDelay: `${index * 60}ms` }}>
      <div className="detail-card-head">
        <span className="detail-card-index">Q{index + 1}</span>
        <span className="detail-card-type">{QUESTION_TYPE_LABELS[q.type] || q.type}</span>
        {q.standard_code ? <span className="detail-card-code">{q.standard_code}</span> : null}
        <button 
          type="button" 
          className="ml-auto p-1 text-ink-faint hover:text-ink transition-colors opacity-0 group-hover:opacity-100" 
          onClick={() => setIsEditing(true)}
          title="Edit Question"
        >
          <Edit2 size={12} />
        </button>
      </div>
      <p className="detail-card-prompt">{q.prompt}</p>

      {q.type === 'multiple_choice' ? (
        <ul className="detail-choice-list">
          {(q.choices || []).map((choice, i) => (
            <li key={i} className={`detail-choice${i === q.correct_index ? ' is-correct' : ''}`}>
              {choice}
            </li>
          ))}
        </ul>
      ) : null}

      {q.type === 'true_false' ? (
        <ul className="detail-choice-list">
          {['True', 'False'].map((choice, i) => (
            <li
              key={choice}
              className={`detail-choice${(i === 0) === q.correct_bool ? ' is-correct' : ''}`}
            >
              {choice}
            </li>
          ))}
        </ul>
      ) : null}

      {q.type === 'short_answer' ? (
        <p className="detail-card-answer">
          Accepted: {(q.accepted_answers || []).join(', ') || '—'}
        </p>
      ) : null}

      {q.type === 'matching' ? (
        <ul className="detail-pair-list">
          {(q.pairs || []).map((pair, i) => (
            <li key={i}>
              <span>{pair.term}</span>
              <span aria-hidden="true">→</span>
              <span>{pair.match}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function QuizSkeleton() {
  return (
    <div className="detail-card-stack">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="detail-card neo-raised">
          <div className="detail-card-head mb-4">
            <Skeleton width="2rem" height="1.25rem" />
            <Skeleton width="5rem" height="1.25rem" />
          </div>
          <SkeletonText lines={2} />
          <div className="mt-4 flex flex-col gap-2">
            {Array.from({ length: 4 }).map((_, j) => (
              <div key={j} className="flex items-center gap-2">
                <Skeleton width="1rem" height="1rem" radius="var(--r-full)" />
                <Skeleton width={['60%', '40%', '80%', '50%'][j]} height="1rem" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function QuizBody({ quiz }) {
  const [questions, setQuestions] = useState(quiz?.quiz_json?.questions || [])
  const [isSaving, setIsSaving] = useState(false)
  const toast = useToast()

  useEffect(() => {
    setQuestions(quiz?.quiz_json?.questions || [])
  }, [quiz])

  if (!questions.length) {
    return <p className="note">This quiz has no questions to show.</p>
  }

  const handleUpdate = async (index, newQuestion) => {
    const newQuestions = [...questions]
    newQuestions[index] = newQuestion
    setQuestions(newQuestions)
    setIsSaving(true)
    try {
      await api.updateQuiz(quiz.plan_id, quiz.id, { ...quiz.quiz_json, questions: newQuestions })
      toast.success('Quiz Updated', 'Your edits have been saved securely.')
    } catch (err) {
      toast.apiError('Failed to save quiz', err)
      setQuestions(questions) // Revert
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="detail-card-stack relative">
      {isSaving && (
        <div className="absolute top-0 right-0 m-2 flex items-center gap-1.5 text-xs text-ink-muted bg-paper-sunken px-2 py-1 rounded-full shadow-sm z-10">
          <Loader2 size={12} className="animate-spin" /> Saving...
        </div>
      )}
      {questions.map((q, i) => (
        <QuizQuestionCard key={i} q={q} index={i} onUpdate={(updated) => handleUpdate(i, updated)} />
      ))}
    </div>
  )
}

/* A code alone ("1.1.3a") answers nothing a teacher would actually be
 * asking when they click through from the rail — what does it SAY, and
 * what document is it FROM. StandardStub fetches exactly that: the same
 * api.getStandard(code, {subject}) the chat's own inline citations use
 * (see Citation.jsx), scoped to this plan's course so a code that collides
 * across corpora (a real, hit bug: "3.2.3" rendered sourced to an AP
 * Japanese Language and Culture PDF inside a Pre-AP Algebra 2 plan) resolves
 * to THIS course's own text, not whichever course the corpus-wide lookup
 * happened to keep. */
function StandardStub({ code, subject, flag, where, index = 0 }) {
  const [record, setRecord] = useState(undefined)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setRecord(undefined)
    setFailed(false)
    const controller = new AbortController()
    api
      .getStandard(code, { subject, signal: controller.signal })
      .then(setRecord)
      .catch((e) => {
        if (e?.name !== 'AbortError') setFailed(true)
      })
    return () => controller.abort()
  }, [code, subject])

  return (
    <div
      className={`detail-card neo-raised fa-rise${flag ? ' is-flag' : ''}`}
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <div className="detail-card-head">
        <span className="detail-card-code" style={{ marginLeft: 0 }}>
          {code}
        </span>
        {where ? <span className="detail-card-type is-flag">not retrieved — {where}</span> : null}
      </div>
      {record === undefined && !failed ? (
        <div className="flex animate-pulse flex-col gap-2 mt-2">
          <div className="h-3.5 w-full rounded bg-paper-inset" />
          <div className="h-3.5 w-4/5 rounded bg-paper-inset" />
          <div className="mt-1 h-3 w-1/3 rounded bg-paper-inset" />
        </div>
      ) : failed || !record ? (
        <p className="detail-card-answer">
          Not in the standards corpus — no source document we hold defines this code.
        </p>
      ) : (
        <>
          <p className="detail-card-prompt">{record.description}</p>
          {record.parent_text ? (
            <p className="detail-card-answer">
              Part of {record.parent_code}: {record.parent_text}
            </p>
          ) : null}
          <p className="detail-card-answer">
            {record.source_document}
            {record.source_page_or_section ? ` · ${record.source_page_or_section}` : ''}
            {record.verbatim_ok ? ' · verified verbatim' : ''}
          </p>
        </>
      )}
    </div>
  )
}

function StandardsBody({ grounded = [], ungrounded = [], subject }) {
  if (!grounded.length && !ungrounded.length) {
    return <p className="note">No grounding was recorded for this plan.</p>
  }
  return (
    <div className="detail-card-stack">
      {grounded.map((code, i) => (
        <StandardStub key={code} code={code} subject={subject} index={i} />
      ))}
      {ungrounded.map((u, i) => (
        <StandardStub
          key={`${u.code}-${u.dayName}`}
          code={u.code}
          subject={subject}
          flag
          where={u.dayName}
          index={grounded.length + i}
        />
      ))}
    </div>
  )
}

/* Was five rows repeating "Monday: Teaching day" — this week's own no-school
 * flags, which the chat message already carries as the week strip (see
 * Message.jsx). "Actually open up a calendar table that shows you what's
 * going on" meant the school's calendar, not a second copy of the plan:
 * every week the school board already has (same query key ClassPage's own
 * Weeks panel and ArtifactRail's "Other weeks" use, so this costs nothing
 * extra to fetch), classified with the same WEEK_STATUS every other calendar
 * surface in the app uses, with the week this plan is actually FOR pinned
 * open at the top so it doesn't get lost scrolling a 36-week list. */
function CalendarBody({ weeks = [], currentWeek, classId }) {
  const currentRef = useRef(null)
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'center' })
  }, [weeks.length])

  if (!weeks.length) {
    return <p className="note">No school calendar is on file for this class.</p>
  }

  return (
    <div className="detail-card-stack">
      {weeks.map((w, i) => {
        const status = weekStatus(w)
        const { dot, label } = WEEK_STATUS[status]
        const isThisPlan = w.week === currentWeek
        const openable = status === 'built' && w.chat_id && !isThisPlan
        // Capped, not a flat i * 60ms: a school year is ~36 rows, and the
        // stagger's job is to read as "settling into place," not to make a
        // teacher wait over two seconds for Week 30 to appear. Flattens
        // after the first 9 rows rather than climbing the whole list.
        const style = { animationDelay: `${Math.min(i * 40, 360)}ms` }
        const row = (
          <div
            className={`detail-card neo-raised fa-rise${w.no_school ? ' is-closed' : ''}${isThisPlan ? ' is-current' : ''
              }`}
            style={style}
          >
            <div className="detail-card-head">
              <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
              <span className="detail-card-type">
                Week {String(w.week).padStart(2, '0')}
                {unitSuffix(w.unit)}
                {isThisPlan ? ' — this plan' : ''}
              </span>
              <span className="detail-card-code">{label}</span>
            </div>
            {/* Blank for a school with no real calendar on file yet
                (schoolcal.py's NO_CALENDAR_SCHOOL_ID) rather than an empty
                paragraph — shortRange itself already returns '' for a
                week with no start/end. */}
            {shortRange(w.start, w.end) ? (
              <p className="detail-card-answer">{shortRange(w.start, w.end)}</p>
            ) : null}
          </div>
        )
        return openable ? (
          <Link key={w.week} to={`/c/${classId}/chat/${w.chat_id}`} className="detail-card-link">
            {row}
          </Link>
        ) : (
          <div key={w.week} ref={isThisPlan ? currentRef : undefined}>
            {row}
          </div>
        )
      })}
    </div>
  )
}

function DocumentBody({ doc }) {
  if (!doc) return <p className="note">This document is no longer attached to the class.</p>
  return (
    <div className="detail-card-stack">
      <div className="detail-card neo-raised">
        <div className="detail-card-head">
          <span className="detail-card-type">{doc.subject === 'GLOBAL' ? 'Global document' : (doc.kind?.replace(/_/g, ' ') || 'Course document')}</span>
        </div>
        <p className="detail-card-prompt">{doc.original_name}</p>
        <p className="detail-card-answer">
          {doc.chars ? `${doc.chars.toLocaleString()} characters` : 'Size unknown'}
          {doc.uploaded_at ? ` · uploaded ${new Date(doc.uploaded_at).toLocaleDateString()}` : ''}
        </p>
        <p className="note" style={{ marginTop: 'var(--sp-2)' }}>
          Used as context when this week was built. The full text isn't shown here —
          re-upload it from the class page to replace it.
        </p>
      </div>
    </div>
  )
}

const TITLES = {
  quiz: (quiz) => quiz?.title || 'Quiz',
  standards: () => 'Standards',
  calendar: () => 'School calendar',
  document: (doc) => doc?.original_name || 'Document',
}

const SUBS = {
  quiz: (quiz) => questionTypesLabel(quiz?.question_types),
  standards: (_d, { grounded = [], ungrounded = [] }) =>
    `${grounded.length} retrieved${ungrounded.length ? ` · ${ungrounded.length} not retrieved` : ''}`,
  calendar: (_d, { weeks = [] }) => `${weeks.length} week${weeks.length === 1 ? '' : 's'} on file`,
  document: (doc) => (doc?.chars ? `${doc.chars.toLocaleString()} characters` : ''),
}

export function ArtifactDetailPanel({
  kind,
  classId,
  onCollapse,
  quiz,
  quizBuilding,
  doc,
  plan,
  planId,
  subject,
  grounded = [],
  ungrounded = [],
  weeks = [],
  currentWeek,
}) {
  const panelRef = useRef(null)
  const titleRef = useRef(null)
  const color = classColor(classId)
  const isOverlay = useMediaQuery(PANEL_OVERLAY)
  // Was rail-card-only — sharing a quiz meant collapsing back out of the
  // very view you were reading it in, unlike the plan viewer (ArtifactPanel),
  // which has always had Share right in its own header. Same ShareDialog
  // ArtifactRail's collapsed card already opens for a quiz, just triggered
  // from here too now.
  const [shareOpen, setShareOpen] = useState(false)

  useFocusTrap(panelRef, {
    active: true,
    trap: isOverlay,
    initialFocus: titleRef,
    onEscape: onCollapse,
  })

  const item = kind === 'quiz' ? quiz : kind === 'document' ? doc : null
  const title = (TITLES[kind] || (() => ''))(item)
  const sub = (SUBS[kind] || (() => ''))(item, { grounded, ungrounded, plan, weeks })

  return (
    <section
      className="doc-shell"
      aria-label={title}
      ref={panelRef}
      tabIndex={-1}
      role={isOverlay ? 'dialog' : undefined}
      aria-modal={isOverlay ? 'true' : undefined}
    >
      {/* doc-head-keep-title: the phone media query that hides .doc-titles
          below 768px was written for ArtifactPanel's own plan view, whose
          sheet restates the week as its own heading right below — nothing
          here does that. Without this override, opening the quiz/standards/
          calendar/document view on a phone showed no title at all: just
          the collapse arrow, Download, and content with no idea what it
          was content OF. */}
      <div
        className="doc-head doc-head-keep-title"
        style={{ '--doc-head-accent': `rgb(${color.rgb})` }}
      >
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
          <strong className="doc-title">{title}</strong>
          {sub ? <span className="doc-sub">{sub}</span> : null}
        </span>

        <span className="flex-1" />

        {/* Quiz download button: always present for UI consistency, but disabled if 
            the file failed to build. */}
        {kind === 'quiz' && planId ? (
          quiz?.has_qti ? (
            <button
              type="button"
              className="doc-download fa-press flex items-center gap-1.5"
              onClick={() => setShareOpen(true)}
              title="Download or Share"
              aria-label="Download or Share this quiz"
            >
              <Download size={14} aria-hidden="true" /> Download
            </button>
          ) : (
            <button
              type="button"
              className="doc-download"
              aria-disabled="true"
              style={{ opacity: 0.45 }}
              onClick={() => toast.apiError('Quiz file failed to build', new Error('Please ask the AI to generate this quiz again in the chat to rebuild the Canvas QTI file.'))}
              title="The file failed to build — ask again in chat to rebuild it"
            >
              <Download size={14} aria-hidden="true" /> Download
            </button>
          )
        ) : null}
      </div>

      <div className="doc-body" tabIndex={0} role="region" aria-label={title}>
        <div className="doc-sheet doc-sheet-plain">
          {kind === 'quiz' ? (
            quizBuilding ? <QuizSkeleton /> : <QuizBody quiz={quiz} />
          ) : null}
          {kind === 'standards' ? (
            <StandardsBody grounded={grounded} ungrounded={ungrounded} subject={subject} />
          ) : null}
          {kind === 'calendar' ? (
            <CalendarBody weeks={weeks} currentWeek={currentWeek} classId={classId} />
          ) : null}
          {kind === 'document' ? <DocumentBody doc={doc} /> : null}
        </div>
      </div>

      <ShareDialog
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        planId={planId}
        isQuiz={kind === 'quiz'}
        quizId={quiz?.id}
        documentName={title}
        downloadUrl={kind === 'quiz' ? api.quizDownloadUrl(planId, quiz?.id) : undefined}
      />
    </section>
  )
}
