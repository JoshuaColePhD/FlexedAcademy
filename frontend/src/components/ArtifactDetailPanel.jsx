import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronsRight, Download } from 'lucide-react'
import { api } from '../lib/api'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { PANEL_OVERLAY, useMediaQuery } from '../hooks/useMediaQuery'
import { classColor } from '../lib/classColor'
import { unitSuffix } from '../lib/planShape'
import { shortRange } from '../lib/dates'
import { WEEK_STATUS, weekStatus } from '../lib/weekStatus'
import { QUESTION_TYPE_LABELS, questionTypesLabel } from '../lib/quizShape'

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

function QuizQuestionCard({ q, index }) {
  return (
    <div className="detail-card neo-raised">
      <div className="detail-card-head">
        <span className="detail-card-index">Q{index + 1}</span>
        <span className="detail-card-type">{QUESTION_TYPE_LABELS[q.type] || q.type}</span>
        {q.standard_code ? <span className="detail-card-code">{q.standard_code}</span> : null}
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

function QuizBody({ quiz }) {
  const questions = quiz?.quiz_json?.questions || []
  if (!questions.length) {
    return <p className="note">This quiz has no questions to show.</p>
  }
  return (
    <div className="detail-card-stack">
      {questions.map((q, i) => (
        <QuizQuestionCard key={i} q={q} index={i} />
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
function StandardStub({ code, subject, flag, where }) {
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
    <div className={`detail-card neo-raised${flag ? ' is-flag' : ''}`}>
      <div className="detail-card-head">
        <span className="detail-card-code" style={{ marginLeft: 0 }}>
          {code}
        </span>
        {where ? <span className="detail-card-type is-flag">not retrieved — {where}</span> : null}
      </div>
      {record === undefined && !failed ? (
        <p className="detail-card-answer">Looking it up…</p>
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
      {grounded.map((code) => (
        <StandardStub key={code} code={code} subject={subject} />
      ))}
      {ungrounded.map((u) => (
        <StandardStub key={`${u.code}-${u.dayName}`} code={u.code} subject={subject} flag where={u.dayName} />
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
      {weeks.map((w) => {
        const status = weekStatus(w)
        const { dot, label } = WEEK_STATUS[status]
        const isThisPlan = w.week === currentWeek
        const openable = status === 'built' && w.chat_id && !isThisPlan
        const row = (
          <div
            className={`detail-card neo-raised${w.no_school ? ' is-closed' : ''}${
              isThisPlan ? ' is-current' : ''
            }`}
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
            <p className="detail-card-answer">{shortRange(w.start, w.end)}</p>
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
          <span className="detail-card-type">{doc.kind?.replace(/_/g, ' ') || 'Course document'}</span>
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
  doc,
  plan,
  planId,
  grounded = [],
  ungrounded = [],
  weeks = [],
  currentWeek,
}) {
  const panelRef = useRef(null)
  const titleRef = useRef(null)
  const color = classColor(classId)
  const isOverlay = useMediaQuery(PANEL_OVERLAY)

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
          <strong className="doc-title">{title}</strong>
          {sub ? <span className="doc-sub">{sub}</span> : null}
        </span>

        <span className="flex-1" />

        {kind === 'quiz' && quiz?.has_qti && planId ? (
          <a className="doc-download fa-press" href={api.quizDownloadUrl(planId, quiz.id)} download>
            <Download size={14} aria-hidden="true" /> Download
          </a>
        ) : null}
      </div>

      <div className="doc-body" tabIndex={0} role="region" aria-label={title}>
        <div className="doc-sheet doc-sheet-plain">
          {kind === 'quiz' ? <QuizBody quiz={quiz} /> : null}
          {kind === 'standards' ? (
            <StandardsBody grounded={grounded} ungrounded={ungrounded} subject={plan?.course} />
          ) : null}
          {kind === 'calendar' ? (
            <CalendarBody weeks={weeks} currentWeek={currentWeek} classId={classId} />
          ) : null}
          {kind === 'document' ? <DocumentBody doc={doc} /> : null}
        </div>
      </div>
    </section>
  )
}
