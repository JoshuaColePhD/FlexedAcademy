import { useEffect, useState } from 'react'

/* The guided alternative to typing a paragraph, for the one message that's too
 * vague to build from ("I want to make a lesson"). The model (see
 * backend/llm.py's ask_clarifying_questions tool) picks 2-4 short questions
 * and a few options each, on request — this only renders what it sent, it
 * never invents a fixed question set of its own.
 *
 * One question at a time, not all of them stacked — a wall of 2-4 question
 * blocks each with their own option row was the thing this replaced. Numbered
 * options double as keyboard shortcuts (1-9), the same "tap or press a
 * number" language a Claude clarification prompt uses, so answering a whole
 * round can be entirely keyboard-driven.
 *
 * Single-select per question, on purpose: this is a quick way to point the
 * model in a direction, not a form. "Other" is the escape hatch for an
 * answer that isn't any of the offered options — it replaces every tapped
 * option for that question, not alongside them. Skip leaves the current
 * question out of the final answer entirely rather than guessing.
 */
// The model sometimes throws its own bare "Other" into the options list
// (nothing in ask_clarifying_questions' schema asks it to — it just doesn't
// know this UI already has a real free-text escape hatch below). Tapping
// that would submit the literal word "Other" as the answer, and left in
// place it just duplicates the row this component always renders anyway —
// so it's filtered out rather than shown twice. Anything more specific than
// the bare word ("Other — a different era") is a real option and stays.
const isBareOther = (opt) => opt.trim().toLowerCase() === 'other'
function realOptions(q) {
  return (q.options || []).filter((opt) => !isBareOther(opt))
}

export function LessonQuestions({ questions, onSubmit }) {
  const [index, setIndex] = useState(0)
  const [answers, setAnswers] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const [typingOther, setTypingOther] = useState(false)
  const [customText, setCustomText] = useState('')
  // The picked option, held just long enough to actually be seen. choose()
  // used to set the answer and advance to the next question in the same
  // event — both batched into one render, so the option's own "selected"
  // state (aria-pressed below) never painted before it was replaced by an
  // entirely different question. Tapping registered nothing back, which is
  // most of why this read as filling out a form rather than answering
  // someone. advancePending holds the swap for one short beat so the tap
  // has a visible effect before the next question appears.
  const [advancePending, setAdvancePending] = useState(null)

  const total = questions.length
  const q = questions[index]
  const isLast = index === total - 1
  const options = realOptions(q)
  const otherKey = options.length + 1

  // Fresh "Other" state per question — typing an answer for question 2
  // shouldn't still be open when question 3 renders.
  useEffect(() => {
    setTypingOther(false)
    setCustomText('')
  }, [index])

  const finish = (finalAnswers) => {
    setSubmitted(true)
    const text = questions
      .map((qq) => (finalAnswers[qq.id] ? `${qq.text} ${finalAnswers[qq.id]}` : null))
      .filter(Boolean)
      .join('\n')
    // Every question skipped is still possible — send what was asked rather
    // than nothing at all, so the model has at least the topic to react to.
    onSubmit(text || questions.map((qq) => qq.text).join('\n'))
  }

  const advance = (finalAnswers) => {
    if (isLast) finish(finalAnswers)
    else setIndex((i) => i + 1)
  }

  // The actual swap, held one beat by advancePending — see that state's own
  // comment. A ref, not a cleanup return from the effect below: unmounting
  // mid-pause (the whole card can vanish if the teacher types over it) must
  // not fire a state update on a gone component.
  useEffect(() => {
    if (!advancePending) return undefined
    const t = setTimeout(() => {
      advance(advancePending)
      setAdvancePending(null)
    }, 220)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [advancePending])

  const choose = (opt) => {
    if (advancePending) return
    const next = { ...answers, [q.id]: opt }
    setAnswers(next)
    setAdvancePending(next)
  }

  const skip = () => {
    if (advancePending) return
    advance(answers)
  }

  const submitCustom = () => {
    if (!customText.trim()) return
    choose(customText.trim())
  }

  // Number-key shortcuts for the current question's options, plus one more
  // for "Other" — dead while the free-text row is open, so typing a digit
  // into it doesn't jump questions out from under the cursor.
  useEffect(() => {
    if (typingOther || submitted || advancePending) return undefined
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      // Not while the teacher is actually typing somewhere — the composer
      // sits right below this dock, and "1" is a normal character there.
      if (['INPUT', 'TEXTAREA'].includes(e.target.tagName) || e.target.isContentEditable) return
      const n = Number(e.key)
      if (!n) return
      if (n >= 1 && n <= options.length) choose(options[n - 1])
      else if (n === otherKey) setTypingOther(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typingOther, submitted, advancePending, q, index, answers, options, otherKey])

  if (submitted) return null

  return (
    // neo-inset, not neo-panel: this card sits flush against the edges of
    // questions-dock-body (ChatPage), which clips overflow with zero margin
    // to spare. neo-panel's shadow bleeds OUTSIDE its own box (12px offset,
    // 28px blur on each side) to read as "raised" — with no room to fade
    // before the clip, the dark half of it got cut off hard, showing up as
    // a visible rectangular notch in whichever corner that shadow happened
    // to fall in (bottom-right in a left-to-right, top-to-bottom light).
    // neo-inset's shadow is entirely INSET, so it can never bleed past this
    // element's own border box no matter how tightly its container clips —
    // the same reasoning composer's own .input textarea (just below this)
    // already used its inset shadow for.
    <div className="neo-world neo-inset flex flex-col gap-2 rounded-2xl bg-paper-raised p-3">
      {/* Was literal "Question 2 of 4" — the label a form field carries, not
          something a person asking you things would ever say out loud. A
          teacher already sees the question itself right below; what this
          line is actually for is just "there's more than one, and here's
          where you are," which a few dots say without sounding like
          paperwork. */}
      {total > 1 ? (
        <div className="flex items-center gap-1" role="img" aria-label={`Question ${index + 1} of ${total}`}>
          {questions.map((qq, i) => (
            <span
              key={qq.id}
              aria-hidden="true"
              className={`h-1.5 rounded-full transition-all ${
                i === index ? 'w-4 bg-accent' : i < index ? 'w-1.5 bg-accent/40' : 'w-1.5 bg-paper-sunken'
              }`}
            />
          ))}
        </div>
      ) : null}

      <p key={`q-${q.id}`} className="lesson-question-prompt text-sm font-medium leading-snug text-ink">
        {q.text}
      </p>
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {advancePending ? `Selected ${advancePending[q.id]}. Moving to the next question.` : ''}
      </div>

      {typingOther ? (
        // fa-context-pop, the same rise-up reveal the composer's own
        // suggestion tray uses when its content changes — a new question
        // (or this editor swapping in for its options) is content arriving,
        // not a popover dropping down from an anchor above it, which is
        // what fa-card-drop communicates elsewhere.
        <div className="lesson-question-editor flex flex-col gap-2">
          <label className="visually-hidden" htmlFor="clarify-custom-input">
            Type your own answer instead
          </label>
          <textarea
            id="clarify-custom-input"
            className="input"
            autoFocus
            rows={2}
            placeholder="Type your own answer…"
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submitCustom()
              }
              if (e.key === 'Escape') setTypingOther(false)
            }}
          />
          <div className="flex gap-2">
            <button
              type="button"
              className="fa-press neo-raised rounded-lg bg-paper-raised px-4 py-2 text-sm font-medium text-ink disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!customText.trim()}
              onClick={submitCustom}
            >
              Use this answer
            </button>
            <button
              type="button"
              className="rounded-lg px-4 py-2 text-sm font-medium text-ink-muted"
              onClick={() => setTypingOther(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div key={`opts-${q.id}`} className="lesson-question-options flex flex-col gap-1.5">
          {options.map((opt, i) => {
            const picked = answers[q.id] === opt
            return (
              <button
                key={opt}
                type="button"
                aria-pressed={picked}
                onClick={() => choose(opt)}
                // The other options fade back once one is picked — advancePending
                // is the brief pause between tap and moving on (see its own
                // comment above); without this every option still looked equally
                // choosable right up to the instant the next question replaced
                // them, so the tap read as having done nothing.
                style={{ animationDelay: `${Math.min(i, 4) * 32 + 55}ms` }}
                className={`lesson-question-option fa-press tap-target flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm font-medium transition-all ${
                  picked
                    ? 'neo-inset text-accent-text'
                    : advancePending
                      ? 'neo-raised text-ink-soft opacity-40'
                      : 'neo-raised text-ink-soft'
                }`}
              >
                <span
                  aria-hidden="true"
                  className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-paper-sunken text-2xs font-semibold text-ink-faint"
                >
                  {i + 1}
                </span>
                {opt}
              </button>
            )
          })}
          <button
            type="button"
            onClick={() => setTypingOther(true)}
            disabled={Boolean(advancePending)}
            style={{ animationDelay: `${Math.min(options.length, 4) * 32 + 55}ms` }}
            className={`lesson-question-option fa-press tap-target flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm font-medium text-ink-muted transition-colors hover:bg-paper-sunken ${
              advancePending ? 'opacity-40' : ''
            }`}
          >
            <span
              aria-hidden="true"
              className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-paper-sunken text-2xs font-semibold text-ink-faint"
            >
              {otherKey}
            </span>
            Other — type your own
          </button>
        </div>
      )}

      {/* Tapping an option in the list above already answers AND advances
          (choose(), just above) — Skip is the only footer action left that
          isn't reachable some other way, for the question the teacher
          would rather leave blank than guess at. A preview of the next
          question sits beside it, faint on purpose: enough to feel like
          this is heading somewhere specific without spoiling the point of
          asking one at a time (the wall of every question up front, all
          over again). Last question gets no preview — there's nothing
          after it but the answer being sent. */}
      {!typingOther ? (
        <div className="lesson-question-footer flex items-center justify-between gap-3">
          <button
            type="button"
            className="text-sm font-medium text-ink-muted hover:underline disabled:pointer-events-none disabled:opacity-40"
            onClick={skip}
            disabled={Boolean(advancePending)}
          >
            Skip
          </button>
          {!isLast ? (
            <p className="min-w-0 truncate text-2xs text-ink-faint">Next: {questions[index + 1].text}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
