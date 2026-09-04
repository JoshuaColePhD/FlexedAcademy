import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Download, Loader2, Edit2, Save, X, Maximize2, Minimize2, Upload, ChevronLeft, ChevronRight, BookOpen, Library, CheckCircle2, Undo2, AlertTriangle } from 'lucide-react'
import { api } from '../lib/api'
import { fetchStandardsBatch } from '../lib/standardsCache'
import { useToast } from '../lib/toastContext'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { classColor } from '../lib/classColor'
import { longDay, monthKey, monthLabel, parseISO, todayISO } from '../lib/dates'
import { BLOOM_LEVELS, DOK_LEVELS, QUESTION_TYPE_LABELS, bloomLabel, questionTypesLabel } from '../lib/quizShape'
import { Skeleton, SkeletonText } from './Skeleton'
import { ShareDialog } from './ShareDialog'
import { DocxDownloadButton } from './DocxDownloadButton'

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

function QuizQuestionCard({ q, index, stagger = index, onUpdate, describedBy }) {
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

  const alignment = draft.alignment || {}
  const cras = alignment.cras || {}

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
      <div className="detail-card neo-raised fa-rise" style={{ animationDelay: `${Math.min(stagger, 6) * 60}ms` }}>
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

        <div className="quiz-alignment-editor">
          <label>
            <span>Bloom</span>
            <select
              className="input text-xs"
              value={alignment.bloom || ''}
              onChange={(e) => setDraft({ ...draft, alignment: { ...alignment, bloom: e.target.value } })}
            >
              <option value="">Select level</option>
              {BLOOM_LEVELS.map((level) => <option key={level} value={level}>{bloomLabel(level)}</option>)}
            </select>
          </label>
          <label>
            <span>DOK</span>
            <select
              className="input text-xs"
              value={alignment.dok || ''}
              onChange={(e) => setDraft({ ...draft, alignment: { ...alignment, dok: Number(e.target.value) || undefined } })}
            >
              <option value="">Select level</option>
              {DOK_LEVELS.map((level) => <option key={level} value={level}>DOK {level}</option>)}
            </select>
          </label>
          <label className="quiz-alignment-wide">
            <span>CRAS rationale</span>
            <textarea
              className="input text-xs resize-y"
              value={cras.rationale || ''}
              onChange={(e) => setDraft({ ...draft, alignment: { ...alignment, cras: { ...cras, rationale: e.target.value } } })}
              placeholder="Why this item fits the selected rigor…"
            />
          </label>
        </div>
      </div>
    )
  }

  return (
    <div
      className="detail-card neo-raised fa-rise group"
      style={{ animationDelay: `${Math.min(stagger, 6) * 60}ms` }}
      aria-describedby={describedBy}
    >
      <div className="detail-card-head">
        <span className="detail-card-index">Q{index + 1}</span>
        <span className="detail-card-type">{QUESTION_TYPE_LABELS[q.type] || q.type}</span>
        {q.standard_code ? <span className="detail-card-code">{q.standard_code}</span> : null}
        {alignment.bloom ? <span className="quiz-alignment-chip">{bloomLabel(alignment.bloom)}</span> : null}
        {alignment.dok ? <span className="quiz-alignment-chip">DOK {alignment.dok}</span> : null}
        <button 
          type="button" 
          className="ml-auto p-1 text-ink-faint hover:text-ink transition-colors opacity-0 group-hover:opacity-100 focus-visible:opacity-100" 
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

/* Q-numbers are GLOBAL — they are the numbers the .docx export prints, in
 * quiz_json.questions order — so grouping by passage below must never
 * renumber. This turns a group's global indexes into the label a teacher can
 * check against the handout: a run reads "Q1–Q3", a lone item reads "Q4", and
 * a scattered set falls back to a count rather than lying about a range. */
function itemRangeLabel(indexes) {
  if (!indexes.length) return 'no items yet'
  if (indexes.length === 1) return `Q${indexes[0] + 1}`
  const contiguous = indexes.every((n, i) => i === 0 || n === indexes[i - 1] + 1)
  if (contiguous) return `Q${indexes[0] + 1}–Q${indexes[indexes.length - 1] + 1}`
  return `${indexes.length} items`
}

const PASSAGE_SOURCE_LABELS = {
  teacher_provided: 'Teacher-provided',
  shared_library: 'Shared library',
  ai_generated: 'AI-generated',
}

/* The left half of a group. Sticky is handled entirely in CSS (see
 * .quiz-passage-pane) against .doc-body's container height — the pane holds
 * position while its OWN questions scroll past, then releases when the next
 * group pushes it up. That only works because each passage is its own grid
 * row; the previous single-well layout made "sticky" meaningless the moment a
 * quiz had two passages. */
function PassagePane({ passage, headingId, cardId, rangeLabel, isEditing, draft, onDraftChange, onEdit, onCancel, onSave }) {
  return (
    <aside className="quiz-passage-pane">
      <div className="quiz-pane-heading">
        <span id={headingId}>
          <BookOpen size={15} aria-hidden="true" /> Passage · {rangeLabel}
        </span>
        {!isEditing ? (
          <button
            type="button"
            className="btn-icon fa-press"
            onClick={onEdit}
            aria-label={`Edit the passage "${passage.title || 'Passage'}"`}
            title="Edit passage"
          >
            <Edit2 size={14} />
          </button>
        ) : null}
      </div>
      <div className="quiz-passage-card" id={cardId}>
        <h3>
          {passage.title || 'Passage'}
          <span className="quiz-passage-source">{PASSAGE_SOURCE_LABELS[passage.source] || 'AI-generated'}</span>
        </h3>
        {isEditing ? (
          <>
            <textarea
              className="input quiz-passage-editor"
              value={draft}
              onChange={(e) => onDraftChange(e.target.value)}
              aria-label={`Passage text for "${passage.title || 'Passage'}"`}
            />
            <div className="quiz-passage-edit-actions">
              <button type="button" className="btn fa-press" onClick={onCancel}>Cancel</button>
              <button type="button" className="btn btn-primary fa-press" onClick={onSave}><Save size={14} /> Save passage</button>
            </div>
          </>
        ) : (
          <p>{passage.text}</p>
        )}
      </div>
    </aside>
  )
}

function QuizBody({ quiz }) {
  const [questions, setQuestions] = useState(quiz?.quiz_json?.questions || [])
  const [passages, setPassages] = useState(quiz?.quiz_json?.passages || [])
  const [isSaving, setIsSaving] = useState(false)
  const [isSavingToLibrary, setIsSavingToLibrary] = useState(false)
  const [libraryItem, setLibraryItem] = useState(null)
  const [permissionConfirmed, setPermissionConfirmed] = useState(false)
  const [suggestions, setSuggestions] = useState([])
  const [selectedLibraryQuestions, setSelectedLibraryQuestions] = useState({})
  const [suggestionsLoading, setSuggestionsLoading] = useState(false)
  /* One id, not a boolean: the old isPassageEditing flipped EVERY passage into
   * a textarea at once, which is not the model QuizQuestionCard uses two
   * columns away. */
  const [editingPassageId, setEditingPassageId] = useState(null)
  const [passageDraft, setPassageDraft] = useState('')
  const toast = useToast()

  useEffect(() => {
    setQuestions(quiz?.quiz_json?.questions || [])
    setPassages(quiz?.quiz_json?.passages || [])
    setLibraryItem(null)
    setPermissionConfirmed(false)
    setEditingPassageId(null)
    setPassageDraft('')
  }, [quiz])

  useEffect(() => {
    if (!quiz?.plan_id) return undefined
    const controller = new AbortController()
    setSuggestionsLoading(true)
    api.quizLibrarySuggestions(quiz.plan_id, { signal: controller.signal })
      .then((items) => setSuggestions(Array.isArray(items) ? items : []))
      .catch((err) => {
        if (err?.name !== 'AbortError') setSuggestions([])
      })
      .finally(() => setSuggestionsLoading(false))
    return () => controller.abort()
  }, [quiz?.plan_id])

  /* The split's whole claim is "these questions go with THAT passage." It used
   * to render two independent stacks side by side and leave the teacher to
   * infer the pairing from a generic "Passage-linked item" line that never said
   * WHICH passage. Grouping makes the claim structural instead. */
  const groups = useMemo(() => {
    const indexed = questions.map((q, i) => ({ q, i }))
    const known = new Set(passages.map((p) => p.id))
    return {
      byPassage: passages.map((passage) => ({
        passage,
        items: indexed.filter(({ q }) => q.passage_id === passage.id),
      })),
      // An unresolvable passage_id (a shared set copied without its passage)
      // lands here rather than vanishing from the panel entirely.
      standalone: indexed.filter(({ q }) => !q.passage_id || !known.has(q.passage_id)),
    }
  }, [questions, passages])

  /* schema.py already warns the BACKEND when a quiz clusters on one Bloom or
   * DOK level (validate_quiz, "fewer than two levels"); the teacher was never
   * shown the distribution that warning is about. */
  const summary = useMemo(() => {
    const bloom = new Map()
    const dok = new Map()
    let linked = 0
    for (const q of questions) {
      if (q.passage_id) linked += 1
      const alignment = q.alignment || {}
      if (alignment.bloom) bloom.set(alignment.bloom, (bloom.get(alignment.bloom) || 0) + 1)
      if (alignment.dok) dok.set(alignment.dok, (dok.get(alignment.dok) || 0) + 1)
    }
    return {
      linked,
      bloom: [...bloom.entries()].sort((a, b) => BLOOM_LEVELS.indexOf(a[0]) - BLOOM_LEVELS.indexOf(b[0])),
      dok: [...dok.entries()].sort((a, b) => a[0] - b[0]),
    }
  }, [questions])

  if (!questions.length) {
    return <p className="note">This quiz has no questions to show.</p>
  }

  const handleUpdate = async (index, newQuestion) => {
    const newQuestions = [...questions]
    newQuestions[index] = newQuestion
    await saveQuiz({ questions: newQuestions, passages })
  }

  const saveQuiz = async ({ questions: nextQuestions = questions, passages: nextPassages = passages }) => {
    const previousQuestions = questions
    const previousPassages = passages
    setQuestions(nextQuestions)
    setPassages(nextPassages)
    setIsSaving(true)
    try {
      await api.updateQuiz(quiz.plan_id, quiz.id, { ...quiz.quiz_json, questions: nextQuestions, passages: nextPassages })
      toast.success('Quiz Updated', 'Your edits have been saved securely.')
    } catch (err) {
      toast.apiError('Failed to save quiz', err)
      setQuestions(previousQuestions)
      setPassages(previousPassages)
    } finally {
      setIsSaving(false)
    }
  }

  const handleSaveToLibrary = async () => {
    setIsSavingToLibrary(true)
    try {
      const item = await api.saveQuizToLibrary(quiz.plan_id, quiz.id)
      setLibraryItem(item)
      setPermissionConfirmed(false)
      toast.success('Saved privately', 'Review this set, then approve it for the shared library.')
    } catch (err) {
      toast.apiError('Could not save to library', err)
    } finally {
      setIsSavingToLibrary(false)
    }
  }

  const handleApprove = async () => {
    if (!libraryItem?.id) return
    try {
      const item = await api.approveQuizLibrarySet(libraryItem.id, { permissionConfirmed })
      setLibraryItem(item)
      toast.success('Shared library approved', 'Other teachers can now find this set in a matching context.')
    } catch (err) {
      toast.apiError('Could not approve library item', err)
    }
  }

  const handleUnpublish = async () => {
    if (!libraryItem?.id) return
    try {
      const item = await api.unpublishQuizLibrarySet(libraryItem.id)
      setLibraryItem(item)
      toast.success('Removed from shared library', 'Your quiz remains unchanged.')
    } catch (err) {
      toast.apiError('Could not remove library item', err)
    }
  }

  const handleUseSuggestion = async (suggestion) => {
    const selectedIndexes = selectedLibraryQuestions[suggestion.id]
    if (!selectedIndexes?.length) return
    try {
      const reusable = await api.useQuizLibrarySet(suggestion.id)
      const allQuestions = reusable.questions || []
      const chosenQuestions = allQuestions.filter((_, index) => selectedIndexes.includes(index))
      const passageIdMap = {}
      const copiedPassages = (reusable.passages || []).map((passage, index) => {
        let nextId = passage.id || `shared_passage_${index + 1}`
        if (passages.some((existing) => existing.id === nextId)) nextId = `${nextId}_copy_${Date.now()}_${index}`
        passageIdMap[passage.id] = nextId
        return { ...passage, id: nextId }
      })
      const remappedQuestions = chosenQuestions.map((question) => ({
        ...question,
        passage_id: passageIdMap[question.passage_id] || question.passage_id || '',
      }))
      await saveQuiz({ questions: [...questions, ...remappedQuestions], passages: [...passages, ...copiedPassages] })
      setSelectedLibraryQuestions((current) => ({ ...current, [suggestion.id]: [] }))
      toast.success('Added shared questions', 'The copied questions are now editable in this quiz.')
    } catch (err) {
      toast.apiError('Could not reuse shared item', err)
    }
  }

  const handleReportSuggestion = async (suggestion) => {
    try {
      await api.reportQuizLibrarySet(suggestion.id, 'Teacher reported this shared set for review.')
      toast.success('Thanks for the report', 'This shared item has been flagged for review.')
    } catch (err) {
      toast.apiError('Could not report shared item', err)
    }
  }

  const toggleLibraryQuestion = (suggestionId, index) => {
    setSelectedLibraryQuestions((current) => {
      const selected = current[suggestionId] || []
      return {
        ...current,
        [suggestionId]: selected.includes(index) ? selected.filter((item) => item !== index) : [...selected, index],
      }
    })
  }

  const startPassageEdit = (passage) => {
    setEditingPassageId(passage.id)
    setPassageDraft(passage.text || '')
  }

  const savePassageEdit = async (passage) => {
    setEditingPassageId(null)
    await saveQuiz({ questions, passages: passages.map((item) => item.id === passage.id ? { ...item, text: passageDraft } : item) })
  }

  const renderQuestions = (items, describedBy) => (
    <div className="detail-card-stack">
      {items.map(({ q, i }, position) => (
        <QuizQuestionCard
          key={i}
          q={q}
          index={i}
          stagger={position}
          describedBy={describedBy}
          onUpdate={(updated) => handleUpdate(i, updated)}
        />
      ))}
    </div>
  )

  return (
    <div className={`quiz-body${passages.length ? ' has-passages' : ''}`}>
      {isSaving && (
        <div className="absolute top-0 right-0 m-2 flex items-center gap-1.5 text-xs text-ink-muted bg-paper-sunken px-2 py-1 rounded-full shadow-sm z-10">
          <Loader2 size={12} className="animate-spin" /> Saving...
        </div>
      )}

      <div className="quiz-summary">
        <strong>{questions.length} item{questions.length === 1 ? '' : 's'}</strong>
        {summary.linked ? <span>{summary.linked} passage-linked</span> : null}
        {summary.bloom.map(([level, count]) => (
          <span key={level} className="quiz-alignment-chip">{bloomLabel(level)} ×{count}</span>
        ))}
        {summary.dok.map(([level, count]) => (
          <span key={level} className="quiz-alignment-chip">DOK {level} ×{count}</span>
        ))}
      </div>

      {passages.length ? (
        <div className="quiz-groups">
          {groups.byPassage.map(({ passage, items }) => {
            const headingId = `passage-heading-${passage.id}`
            const cardId = `passage-card-${passage.id}`
            return (
              <section key={passage.id} className="quiz-passage-group" aria-labelledby={headingId}>
                <PassagePane
                  passage={passage}
                  headingId={headingId}
                  cardId={cardId}
                  rangeLabel={itemRangeLabel(items.map(({ i }) => i))}
                  isEditing={editingPassageId === passage.id}
                  draft={passageDraft}
                  onDraftChange={setPassageDraft}
                  onEdit={() => startPassageEdit(passage)}
                  onCancel={() => setEditingPassageId(null)}
                  onSave={() => savePassageEdit(passage)}
                />
                <div className="quiz-question-pane">
                  {items.length
                    ? renderQuestions(items, cardId)
                    : <p className="note">No questions use this passage yet.</p>}
                </div>
              </section>
            )
          })}

          {groups.standalone.length ? (
            <section className="quiz-passage-group is-standalone" aria-labelledby="quiz-standalone-heading">
              <div className="quiz-pane-heading">
                <span id="quiz-standalone-heading">Independent items</span>
                <span className="quiz-question-count">not tied to a passage</span>
              </div>
              {renderQuestions(groups.standalone)}
            </section>
          ) : null}
        </div>
      ) : (
        renderQuestions(questions.map((q, i) => ({ q, i })))
      )}

      {/* Publishing is a terminal action and used to open the panel, above the
          quiz the teacher came to read. It sits under the work now, and the
          status line + suggestions share its one region rather than stacking
          three separate boxes. */}
      <section className="quiz-library" aria-label="Shared library">
        <div className="quiz-library-toolbar">
          <div>
            <strong>Reusable assessment set</strong>
            <span>Keep this quiz private, or approve a reviewed passage set for other teachers.</span>
          </div>
          {!libraryItem ? (
            <button type="button" className="btn fa-press" onClick={handleSaveToLibrary} disabled={isSavingToLibrary || !passages.length}>
              {isSavingToLibrary ? <Loader2 size={14} className="animate-spin" /> : <Library size={14} />}
              Save to library
            </button>
          ) : libraryItem.approval_status === 'approved' ? (
            <button type="button" className="btn fa-press" onClick={handleUnpublish}><Undo2 size={14} /> Unpublish</button>
          ) : (
            <span className="quiz-approval-controls">
              {libraryItem.passage_source === 'teacher_provided' ? (
                <label><input type="checkbox" checked={permissionConfirmed} onChange={(e) => setPermissionConfirmed(e.target.checked)} /> I have permission to share this passage</label>
              ) : null}
              <button type="button" className="btn btn-primary fa-press" onClick={handleApprove} disabled={libraryItem.passage_source === 'teacher_provided' && !permissionConfirmed}><CheckCircle2 size={14} /> Approve for sharing</button>
            </span>
          )}
        </div>

        {libraryItem ? (
          <div className="quiz-library-status" role="status">
            <Library size={14} aria-hidden="true" />
            {libraryItem.approval_status === 'approved' ? 'Approved and available to teachers in matching contexts.' : 'Saved privately as a draft. Review before sharing.'}
          </div>
        ) : null}

        <div className="quiz-library-suggestions">
          <div className="quiz-pane-heading"><span><Library size={15} aria-hidden="true" /> Matching shared sets</span>{suggestionsLoading ? <Loader2 size={14} className="animate-spin" /> : null}</div>
          {!suggestionsLoading && !suggestions.length ? <p className="note">No approved sets match this plan yet.</p> : null}
          {suggestions.map((suggestion) => {
            const selectedCount = (selectedLibraryQuestions[suggestion.id] || []).length
            return (
              <div key={suggestion.id} className="quiz-library-suggestion">
                <div className="quiz-library-suggestion-main">
                  <strong>{suggestion.title}</strong>
                  <span>{suggestion.provenance_label} · {suggestion.usage_count || 0} reuse{suggestion.usage_count === 1 ? '' : 's'}</span>
                  {suggestion.quiz_json?.questions?.length ? (
                    <div className="quiz-library-question-picker">
                      {suggestion.quiz_json.questions.map((question, index) => (
                        <label key={index}>
                          <input type="checkbox" checked={(selectedLibraryQuestions[suggestion.id] || []).includes(index)} onChange={() => toggleLibraryQuestion(suggestion.id, index)} />
                          <span>Q{index + 1}: {question.prompt}</span>
                        </label>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="quiz-library-suggestion-actions">
                  {/* Was: an empty selection silently copied EVERY question. */}
                  <button
                    type="button"
                    className="btn fa-press"
                    onClick={() => handleUseSuggestion(suggestion)}
                    disabled={!selectedCount}
                    title={selectedCount ? undefined : 'Tick the questions you want first'}
                  >
                    {selectedCount ? `Add ${selectedCount} selected` : 'Add selected'}
                  </button>
                  <button type="button" className="btn-icon fa-press" onClick={() => handleReportSuggestion(suggestion)} aria-label={`Report ${suggestion.title}`} title="Report shared item"><AlertTriangle size={14} /></button>
                </div>
              </div>
            )
          })}
        </div>
      </section>
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

const localDateKey = (date) => (
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
)

/* Settings can receive the school-level calendar before the API has added its
 * derived `days` array, while the main app's week board already includes it.
 * Keep both response shapes renderable so a calendar never disappears during
 * that transition. The backend remains the source of exact closure details
 * whenever `days` is present. */
function inferredWeekDays(week) {
  if (!week.start || !week.end) return []
  const start = parseISO(week.start)
  const end = parseISO(week.end)
  const monday = new Date(start)
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
  return Array.from({ length: 5 }, (_, index) => {
    const date = new Date(monday)
    date.setDate(monday.getDate() + index)
    const inRange = date >= start && date <= end
    const isSchool = !week.no_school && inRange
    return {
      date: localDateKey(date),
      is_school: isSchool,
      note: isSchool ? '' : week.no_school ? (week.notes || 'No school') : date < start ? 'Before the first day' : 'After the last day',
    }
  })
}

/* Every week's own `days` array (backend/schoolcal.py's week_days, already
 * attached to each /api/weeks row — see db.py's week_board) flattened into
 * one date → info map, then re-grouped into real calendar months. Weekends
 * carry no record at all (the school week is Mon–Fri only) — treated as
 * closed here rather than left blank, since a wall calendar with two
 * unexplained gaps every row would read as missing data, not as Saturday. */
function buildMonths(weeks) {
  const byDate = new Map()
  weeks.forEach((w) => {
    const days = Array.isArray(w.days) && w.days.length ? w.days : inferredWeekDays(w)
    days.forEach((d) => {
      if (!d.date) return
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
export function CalendarBody({ weeks = [], currentWeek, classId }) {
  const months = useMemo(() => buildMonths(weeks), [weeks])
  const today = todayISO()
  const monthRefs = useRef([])
  const todayMonthIndex = useMemo(() => {
    const index = months.findIndex((month) => month.cells.some((cell) => cell?.iso === today))
    return index >= 0 ? index : 0
  }, [months, today])
  const activeWeek = useMemo(() => {
    if (currentWeek != null) return currentWeek
    return weeks.find((week) => week.start <= today && today <= week.end)?.week
  }, [weeks, currentWeek, today])
  const focusMonthIndex = useMemo(() => {
    const index = months.findIndex((month) => month.cells.some((cell) => (
      cell && (currentWeek != null ? cell.week === currentWeek : cell.iso === today)
    )))
    return index >= 0 ? index : 0
  }, [months, currentWeek, today])
  const [activeMonthIndex, setActiveMonthIndex] = useState(focusMonthIndex)
  /* scrollIntoView's own scroll fires the SAME 'scroll' event handleMonthScroll
     listens for to track free (manual) scrolling — and while that scroll is
     still in flight (or, inside onboarding's animated step transition,
     delayed well past when it would normally settle), container.scrollLeft
     doesn't yet match its destination, so handleMonthScroll's
     nearest-month measurement briefly resolves to the WRONG (starting)
     month and stomps the correct index right back to 0.
     A timing-based guard (armed on scroll, cleared after a fixed delay or
     on 'scrollend') was tried here first and still lost this race under
     onboarding's own mount animation — timing assumptions about how long a
     browser takes to settle a scroll are exactly the kind of thing that
     holds locally and breaks somewhere with different layout/animation
     timing. This is deliberately not a timing guess: handleMonthScroll
     simply never runs at all until the scroller has received a genuine
     user gesture (wheel, touch, or a pointer press) — every mount-time or
     button-triggered scroll (scrollIntoView, scrollToMonth) already sets
     activeMonthIndex itself, so handleMonthScroll only exists to track
     FREE dragging/swiping, which cannot happen without one of these
     gestures firing first regardless of animation or scroll timing. */
  const userScrolledRef = useRef(false)

  useEffect(() => {
    const container = monthRefs.current[0]?.closest('.cal-months')
    if (!container) return undefined
    const markUserScrolled = () => { userScrolledRef.current = true }
    container.addEventListener('wheel', markUserScrolled, { passive: true })
    container.addEventListener('touchstart', markUserScrolled, { passive: true })
    container.addEventListener('pointerdown', markUserScrolled)
    return () => {
      container.removeEventListener('wheel', markUserScrolled)
      container.removeEventListener('touchstart', markUserScrolled)
      container.removeEventListener('pointerdown', markUserScrolled)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [months.length])

  // useLayoutEffect, not useEffect: runs before the browser paints, so the
  // very first frame already shows the right month instead of a flash of
  // month 0 that a post-paint effect would correct a tick later.
  useLayoutEffect(() => {
    if (!months.length) return
    setActiveMonthIndex(focusMonthIndex)
    monthRefs.current[focusMonthIndex]?.scrollIntoView({ block: 'nearest', inline: 'start' })
  }, [months.length, focusMonthIndex])

  const scrollToMonth = (index) => {
    const nextIndex = Math.max(0, Math.min(months.length - 1, index))
    setActiveMonthIndex(nextIndex)
    monthRefs.current[nextIndex]?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' })
  }

  const handleMonthScroll = (event) => {
    if (!userScrolledRef.current) return
    const container = event.currentTarget
    const nextIndex = monthRefs.current.reduce((closest, month, index) => {
      if (!month) return closest
      const distance = Math.abs(month.offsetLeft - container.scrollLeft)
      const closestDistance = Math.abs(monthRefs.current[closest]?.offsetLeft - container.scrollLeft)
      return distance < closestDistance ? index : closest
    }, 0)
    if (nextIndex !== activeMonthIndex) setActiveMonthIndex(nextIndex)
  }

  if (!weeks.length) {
    return <p className="note">No school calendar is on file for this class.</p>
  }

  return (
    <div className="cal-shell">
      <div className="cal-toolbar">
        <button
          type="button"
          className="cal-today-button"
          onClick={() => scrollToMonth(todayMonthIndex)}
          disabled={activeMonthIndex === todayMonthIndex}
        >
          Today
        </button>
        <h3 className="cal-toolbar-label">
          {months[activeMonthIndex]?.label || months[0]?.label}
          {activeWeek != null ? <span className="cal-toolbar-week">Week {String(activeWeek).padStart(2, '0')}</span> : null}
        </h3>
        <div className="cal-nav" aria-label="Calendar month navigation">
          <button
            type="button"
            onClick={() => scrollToMonth(activeMonthIndex - 1)}
            disabled={activeMonthIndex === 0}
            aria-label="Previous month"
            title="Previous month"
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => scrollToMonth(activeMonthIndex + 1)}
            disabled={activeMonthIndex === months.length - 1}
            aria-label="Next month"
            title="Next month"
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="cal-months" onScroll={handleMonthScroll} tabIndex={0} role="region" aria-label="School calendar months">
      {months.map((month, monthIndex) => (
        <div key={month.key} className="cal-month fa-rise" ref={(node) => { monthRefs.current[monthIndex] = node }}>
          <h3 className="cal-month-label">{month.label}</h3>
          <div className="cal-weekday-row" aria-hidden="true">
            {WEEKDAY_LETTERS.map((d) => (
              <span key={d}>{d}</span>
            ))}
          </div>
          <div className="cal-grid">
            {month.cells.map((cell, i) => {
              if (!cell) return <span key={`pad-${i}`} className="cal-day is-pad" aria-hidden="true" />
              const isToday = cell.iso === today
              const isThisPlanWeek = activeWeek != null && cell.week === activeWeek
              const openable = cell.hasPlan && cell.chatId && !isThisPlanWeek && !cell.isOff
              const cellBody = (
                <span
                  className={`cal-day${cell.isOff ? ' is-off' : ''}${
                    isToday ? ' is-today' : ''
                  }${isThisPlanWeek ? ' is-current-week' : ''}${openable ? ' is-openable' : ''}`}
                  title={`${longDay(cell.iso)}${cell.note ? ` — ${cell.note}` : ''}`}
                >
                  <span className="cal-day-number">{cell.day}</span>
                  <span className={`cal-day-status ${cell.isOff ? 'is-off' : 'is-work'}`} aria-hidden="true" />
                </span>
              )
              return openable ? (
                <Link key={cell.iso} to={`/c/${classId}/chat/${cell.chatId}`} className="cal-day-link">
                  {cellBody}
                </Link>
              ) : (
                <span key={cell.iso}>
                  {cellBody}
                </span>
              )
            })}
          </div>
        </div>
      ))}
      </div>
      <div className="cal-key" aria-label="Calendar key">
        <span><i className="cal-key-dot is-work" aria-hidden="true" /> Teaching day</span>
        <span><i className="cal-key-dot is-off" aria-hidden="true" /> Non-teaching day</span>
        {activeWeek != null ? <span><i className="cal-key-line" aria-hidden="true" /> Current week</span> : null}
      </div>
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
  onFullscreenChange,
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
  // .artifact-overlay (ChatPage.jsx) is what actually needs to grow: it sits
  // inset from the left rail with backdrop-filter + will-change: transform,
  // both of which make it the real containing block for ANY position:fixed
  // descendant (this .doc-shell's own "fullscreen" rule included) — CSS has
  // no way for a child to opt out of an ancestor's filter/will-change once
  // it's there. Confirmed live: maximizing did nothing visible, because
  // .doc-shell's inset:0 was already resolving against .artifact-overlay's
  // own box, which is exactly the box it was already filling. Growing the
  // OVERLAY itself past that fixed left inset, rather than fighting the
  // browser to have doc-shell escape a containing block it can't escape, is
  // what ArtifactPanel's own twin of this effect does too.
  useEffect(() => {
    onFullscreenChange?.(isFullscreen)
    return () => onFullscreenChange?.(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFullscreen])

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
            quiz ? (
              <>
                {/* Cloud sharing and the Canvas preview live behind one
                    export control; the two local formats remain explicit. */}
                <button
                  type="button"
                  className="btn-icon fa-press"
                  aria-label="Export this quiz"
                  title="Export this quiz"
                  onClick={() => setShareOpen(true)}
                >
                  <Upload size={16} className="text-ink-muted" />
                </button>

                <DocxDownloadButton
                  planId={planId}
                  downloadRequest={() => api.downloadQuizDocx(planId, quiz.id, { fallbackName: `${title}.docx` })}
                  className="doc-download fa-press flex items-center gap-1.5"
                  aria-label="Download Word document"
                  title="Download Word document"
                >
                  <Download size={14} aria-hidden="true" className="text-ink-muted" />
                  <span className="font-medium">Download Word</span>
                </DocxDownloadButton>
                {quiz?.has_qti ? (
                  <a
                    href={planId && quiz?.id ? api.quizDownloadUrl(planId, quiz.id) : undefined}
                    download
                    className="doc-download fa-press flex items-center gap-1.5"
                    aria-label="Download QTI .zip"
                    title="Download QTI .zip"
                  >
                    <Download size={14} aria-hidden="true" className="text-ink-muted" />
                    <span className="font-medium">Download QTI</span>
                  </a>
                ) : null}
              </>
            ) : (
              /* Both export artifacts failed; keep a keyboard-accessible
                 explanation rather than presenting a dead download link. */
              <button
                type="button"
                className="doc-download opacity-45 flex items-center gap-1.5"
                onClick={() => toast.apiError('Quiz exports failed to build', new Error('Please ask the AI to generate this quiz again in the chat to rebuild the Word and QTI files.'))}
                aria-label="Quiz exports failed to build — ask again in chat to rebuild them"
                title="The quiz exports failed to build — ask again in chat to rebuild them"
              >
                <Download size={14} aria-hidden="true" className="text-ink-muted" />
                <span className="font-medium">Exports unavailable</span>
              </button>
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
      />
    </section>
  )
}
