import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Download, Loader2, Edit2, Save, X, Maximize2, Minimize2, Cloud, ChevronDown } from 'lucide-react'
import { api } from '../lib/api'
import { fetchStandardsBatch } from '../lib/standardsCache'
import { useToast } from '../lib/toastContext'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { classColor } from '../lib/classColor'
import { longDay, monthKey, monthLabel, parseISO, todayISO } from '../lib/dates'
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

  // An empty prompt or an empty MC choice isn't a smaller question, it's a
  // broken one — the quiz export would ship a blank line to students.
  const isValid =
    draft.prompt?.trim() &&
    (draft.type !== 'multiple_choice' || (draft.choices || []).every((c) => c?.trim()))

  const handleSave = () => {
    if (!isValid) return
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
            <button
              type="button"
              className="p-1 text-primary hover:text-primary-dark transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={handleSave}
              disabled={!isValid}
              title={isValid ? 'Save' : 'A question needs a prompt and every choice filled in'}
            >
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
 * what document is it FROM. `record` is looked up by StandardsBody, not
 * fetched here: this used to be one api.getStandard(code, {subject}) call
 * PER stub (the same lookup the chat's own inline citations use — see
 * Citation.jsx), so a plan citing a dozen codes fired a dozen requests on
 * every open, none of them cached across mounts. StandardsBody now fetches
 * every code in this plan in one request via lib/standardsCache.js, which
 * shares its cache with Citation.jsx's popovers — a code seen once, by
 * either surface, is free everywhere after. `subject` still scopes each
 * lookup to this plan's course, so a code that collides across corpora (a
 * real, hit bug: "3.2.3" rendered sourced to an AP Japanese Language and
 * Culture PDF inside a Pre-AP Algebra 2 plan) resolves to THIS course's own
 * text, not whichever course the corpus-wide lookup happened to keep.
 * `record` is undefined while the batch is in flight, null once fetched and
 * not found. */
function StandardStub({ code, record, flag, where, index = 0 }) {
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
      {record === undefined ? (
        <div className="mt-2">
          <SkeletonText lines={3} />
        </div>
      ) : !record ? (
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
  // One request for every code this plan cites, instead of one per stub —
  // see StandardStub's own comment and lib/standardsCache.js. Keyed by
  // subject + the joined code list so re-mounting with the same plan (the
  // panel closes and reopens; the codes don't change) re-renders from the
  // shared cache with no new request, while a genuinely different plan's
  // codes still trigger one.
  const codes = useMemo(
    () => [...grounded, ...ungrounded.map((u) => u.code)],
    [grounded, ungrounded]
  )
  const [records, setRecords] = useState({})

  useEffect(() => {
    if (!codes.length) return undefined
    const controller = new AbortController()
    fetchStandardsBatch(codes, { subject, signal: controller.signal })
      .then(setRecords)
      .catch((e) => {
        // A failed batch leaves every code showing "not in the corpus"
        // rather than an endless skeleton — same fallback StandardStub
        // already renders for a genuinely missing code.
        if (e?.name !== 'AbortError') setRecords(Object.fromEntries(codes.map((c) => [c, null])))
      })
    return () => controller.abort()
  }, [codes, subject])

  if (!grounded.length && !ungrounded.length) {
    return <p className="note">No grounding was recorded for this plan.</p>
  }
  return (
    <div className="detail-card-stack">
      {grounded.map((code, i) => (
        <StandardStub key={code} code={code} record={records[code]} index={i} />
      ))}
      {ungrounded.map((u, i) => (
        <StandardStub
          key={`${u.code}-${u.dayName}`}
          code={u.code}
          record={records[u.code]}
          flag
          where={u.dayName}
          index={grounded.length + i}
        />
      ))}
    </div>
  )
}

const WEEKDAY_LETTERS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

/* Every week's own `days` array (backend/schoolcal.py's week_days, already
 * attached to each /api/weeks row — see db.py's week_board) flattened into
 * one date → info map, then re-grouped into real calendar months. Weekends
 * carry no record at all (the school week is Mon–Fri only) — treated as
 * closed here rather than left blank, since a wall calendar with two
 * unexplained gaps every row would read as missing data, not as Saturday. */
function buildMonths(weeks) {
  const byDate = new Map()
  weeks.forEach((w) => {
    ;(w.days || []).forEach((d) => {
      byDate.set(d.date, {
        isSchool: d.is_school,
        note: d.note,
        week: w.week,
        hasPlan: w.has_plan,
        chatId: w.chat_id,
      })
    })
  })
  const dates = Array.from(byDate.keys()).sort()
  if (!dates.length) return []

  const months = []
  const cursor = parseISO(dates[0])
  cursor.setDate(1)
  const last = parseISO(dates[dates.length - 1])
  while (cursor <= last) {
    const y = cursor.getFullYear()
    const m = cursor.getMonth()
    const daysInMonth = new Date(y, m + 1, 0).getDate()
    const leading = new Date(y, m, 1).getDay()
    const cells = Array.from({ length: leading }, () => null)
    for (let day = 1; day <= daysInMonth; day++) {
      const iso = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      const dow = new Date(y, m, day).getDay()
      const isWeekend = dow === 0 || dow === 6
      const info = byDate.get(iso)
      cells.push({
        iso,
        day,
        isOff: info ? info.isSchool === false : isWeekend,
        note: info?.note,
        week: info?.week,
        hasPlan: info?.hasPlan,
        chatId: info?.chatId,
      })
    }
    months.push({ key: monthKey(`${y}-${String(m + 1).padStart(2, '0')}-01`), label: monthLabel(`${y}-${String(m + 1).padStart(2, '0')}-01`), cells })
    cursor.setMonth(m + 1)
  }
  return months
}

/* A traditional wall calendar — was a flat list of week rows repeating
 * "Monday: Teaching day," which answered "is this week built" but not the
 * thing a teacher actually opens this for: is Thursday a real school day.
 * Every day's own status (backend/schoolcal.py's per-day closures, already
 * on the API response — see buildMonths above) instead of a per-week
 * summary, so a single holiday inside an otherwise-normal week is visible
 * without opening anything further. */
function CalendarBody({ weeks = [], currentWeek, classId }) {
  const months = useMemo(() => buildMonths(weeks), [weeks])
  const today = todayISO()
  const currentRef = useRef(null)
  const hasScrolled = useRef(false)
  useEffect(() => {
    if (hasScrolled.current || !months.length) return
    hasScrolled.current = true
    currentRef.current?.scrollIntoView({ block: 'center' })
  }, [months.length])

  if (!weeks.length) {
    return <p className="note">No school calendar is on file for this class.</p>
  }

  return (
    <div className="cal-months">
      {months.map((month) => (
        <div key={month.key} className="cal-month fa-rise">
          <h3 className="cal-month-label">{month.label}</h3>
          <div className="cal-weekday-row" aria-hidden="true">
            {WEEKDAY_LETTERS.map((d) => (
              <span key={d}>{d}</span>
            ))}
          </div>
          <div className="cal-grid">
            {(() => {
              // Ref goes on the FIRST day of the plan's own week only — every
              // day in that week would otherwise reassign currentRef as the
              // map runs, and scrollIntoView on whichever happened to run
              // last (Friday) centers the same week either way, but only one
              // DOM node should actually own the ref.
              let refAssigned = false
              return month.cells.map((cell, i) => {
                if (!cell) return <span key={`pad-${i}`} className="cal-day is-pad" aria-hidden="true" />
                const isToday = cell.iso === today
                const isThisPlanWeek = cell.week === currentWeek
                const openable = cell.hasPlan && cell.chatId && !isThisPlanWeek && !cell.isOff
                const ref = isThisPlanWeek && !refAssigned ? ((refAssigned = true), currentRef) : undefined
                const cellBody = (
                  <span
                    className={`cal-day${cell.isOff ? ' is-off' : ''}${cell.note ? ' has-note' : ''}${
                      isToday ? ' is-today' : ''
                    }${isThisPlanWeek ? ' is-current-week' : ''}${openable ? ' is-openable' : ''}`}
                    title={`${longDay(cell.iso)}${cell.note ? ` — ${cell.note}` : ''}`}
                  >
                    {cell.day}
                  </span>
                )
                return openable ? (
                  <Link key={cell.iso} to={`/c/${classId}/chat/${cell.chatId}`} className="cal-day-link" ref={ref}>
                    {cellBody}
                  </Link>
                ) : (
                  <span key={cell.iso} ref={ref}>
                    {cellBody}
                  </span>
                )
              })
            })()}
          </div>
        </div>
      ))}
    </div>
  )
}

function DocumentBody({ doc, classId }) {
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
          {classId ? (
            <>
              {' '}
              <Link to={`/c/${classId}/class#class-documents`} className="underline hover:no-underline">
                re-upload it from the class page
              </Link>{' '}
              to replace it.
            </>
          ) : (
            ' re-upload it from the class page to replace it.'
          )}
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
  // The document always covers the chat now (2026-08-27) — there is no more
  // docked-beside-it mode at any width, so this panel is always the overlay
  // dialog. See ArtifactPanel's own comment on the same change.
  const isOverlay = true
  const toast = useToast()
  // Was rail-card-only — sharing a quiz meant collapsing back out of the
  // very view you were reading it in, unlike the plan viewer (ArtifactPanel),
  // which has always had Share right in its own header. Same ShareDialog
  // ArtifactRail's collapsed card already opens for a quiz, just triggered
  // from here too now.
  const [shareOpen, setShareOpen] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)

  useFocusTrap(panelRef, {
    active: true,
    trap: isOverlay,
    initialFocus: titleRef,
    onEscape: () => {
      if (isFullscreen) {
        setIsFullscreen(false)
      } else {
        onCollapse()
      }
    },
  })

  const item = kind === 'quiz' ? quiz : kind === 'document' ? doc : null
  const title = (TITLES[kind] || (() => ''))(item)
  const sub = (SUBS[kind] || (() => ''))(item, { grounded, ungrounded, plan, weeks })

  return (
    <section
      className={`doc-shell${isFullscreen ? ' is-fullscreen' : ''}`}
      aria-label={title}
      ref={panelRef}
      tabIndex={-1}
      role={isOverlay ? 'dialog' : undefined}
      aria-modal={isOverlay ? 'true' : undefined}
    >
      <div
        className="doc-head doc-head-keep-title"
        style={{ '--doc-head-accent': `rgb(${color.rgb})` }}
      >
        <span className="doc-titles" ref={titleRef} tabIndex={-1}>
          <strong className="doc-title">{title}</strong>
          {sub ? <span className="doc-sub">{sub}</span> : null}
        </span>

        <span className="flex-1" />

        <div className="flex items-center gap-2">
          {kind === 'quiz' && planId ? (
            quiz?.has_qti ? (
              <>
                <button
                  type="button"
                  className="btn-icon fa-press"
                  aria-label="Save to Google Drive"
                  title="Save to Google Drive"
                >
                  <Cloud size={16} className="text-ink-muted" />
                </button>

                <div className="doc-download-group flex items-stretch">
                  <button
                    type="button"
                    className="doc-download-main fa-press flex items-center gap-1.5"
                    onClick={() => setShareOpen(true)}
                    aria-label="Download or Share this quiz"
                    title="Download or Share"
                  >
                    <Download size={14} aria-hidden="true" className="text-ink-muted" />
                    <span className="font-medium">Download as DOCX</span>
                  </button>
                  <div className="doc-download-divider" />
                  <button
                    type="button"
                    className="doc-download-drop fa-press flex items-center justify-center"
                    onClick={() => setShareOpen(true)}
                    aria-label="More download options"
                  >
                    <ChevronDown size={14} aria-hidden="true" className="text-ink-muted" />
                  </button>
                </div>
              </>
            ) : (
              <span 
                className="doc-download opacity-45 flex items-center gap-1.5" 
                aria-disabled="true"
                onClick={() => toast.apiError('Quiz file failed to build', new Error('Please ask the AI to generate this quiz again in the chat to rebuild the Canvas QTI file.'))}
                title="The file failed to build — ask again in chat to rebuild it"
              >
                <Download size={14} aria-hidden="true" className="text-ink-muted" />
                <span className="font-medium">Download as DOCX</span>
              </span>
            )
          ) : null}

          <button
            type="button"
            className="btn-icon fa-press ml-1"
            onClick={() => setIsFullscreen(!isFullscreen)}
            aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          >
            {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>

          <button
            type="button"
            className="btn-icon fa-press"
            onClick={onCollapse}
            aria-label="Close document"
            title="Close document"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
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
          {kind === 'document' ? <DocumentBody doc={doc} classId={classId} /> : null}
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
