import { useRef } from 'react'
import { ChevronsRight, Download } from 'lucide-react'
import { api } from '../lib/api'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { PANEL_OVERLAY, useMediaQuery } from '../hooks/useMediaQuery'
import { classColor } from '../lib/classColor'
import { orderedDays } from '../lib/planShape'
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

function StandardsBody({ grounded = [], ungrounded = [] }) {
  if (!grounded.length && !ungrounded.length) {
    return <p className="note">No grounding was recorded for this plan.</p>
  }
  return (
    <div className="detail-card-stack">
      {grounded.length ? (
        <div className="detail-card neo-raised">
          <div className="detail-card-head">
            <span className="detail-card-type">Retrieved &amp; cited</span>
          </div>
          <ul className="detail-code-list">
            {grounded.map((code) => (
              <li key={code} className="detail-code is-grounded">
                {code}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {ungrounded.length ? (
        <div className="detail-card neo-raised">
          <div className="detail-card-head">
            <span className="detail-card-type is-flag">Cited but not retrieved</span>
          </div>
          <ul className="detail-code-list">
            {ungrounded.map((u) => (
              <li key={`${u.code}-${u.dayName}`} className="detail-code is-flag">
                {u.code} <span className="detail-code-where">— {u.dayName}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

function CalendarBody({ plan }) {
  const days = plan?.days?.length ? orderedDays(plan, 'no_school') : []
  if (!days.length) {
    return <p className="note">No calendar information was recorded for this plan.</p>
  }
  return (
    <div className="detail-card-stack">
      {days.map((d) => (
        <div key={d.name} className={`detail-card neo-raised${d.no_school ? ' is-closed' : ''}`}>
          <div className="detail-card-head">
            <span className="detail-card-type">{d.name}</span>
            <span className="detail-card-code">{d.no_school ? 'No school' : 'Teaching day'}</span>
          </div>
          {d.no_school && d.title ? <p className="detail-card-answer">{d.title}</p> : null}
        </div>
      ))}
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
  calendar: (_d, { plan }) => plan?.week_of || '',
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
  const sub = (SUBS[kind] || (() => ''))(item, { grounded, ungrounded, plan })

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
          {kind === 'standards' ? <StandardsBody grounded={grounded} ungrounded={ungrounded} /> : null}
          {kind === 'calendar' ? <CalendarBody plan={plan} /> : null}
          {kind === 'document' ? <DocumentBody doc={doc} /> : null}
        </div>
      </div>
    </section>
  )
}
