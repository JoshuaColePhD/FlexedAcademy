import { useState } from 'react'

/* The guided alternative to typing a paragraph, for the one message that's too
 * vague to build from ("I want to make a lesson"). The model (see
 * backend/llm.py's ask_clarifying_questions tool) picks 2-4 short questions
 * and a few options each, on request — this only renders what it sent, it
 * never invents a fixed question set of its own.
 *
 * Single-select per question, on purpose: this is a quick way to point the
 * model in a direction, not a form. "Type instead" is the real escape hatch
 * for a teacher whose answer isn't any of the offered options — it used to
 * be "abandon this card and use the composer instead," which nothing here
 * ever said out loud, so it was findable only by already knowing the trick.
 * Typing sends the free text as the whole answer, in place of every tapped
 * option, not alongside them — mixing "tapped some, typed the rest" would
 * have to guess which question the typed text was even answering.
 */
export function LessonQuestions({ questions, onSubmit }) {
  const [answers, setAnswers] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const [typing, setTyping] = useState(false)
  const [customText, setCustomText] = useState('')

  if (submitted) return null

  const allAnswered = questions.every((q) => answers[q.id])

  const submit = () => {
    setSubmitted(true)
    const text = questions.map((q) => `${q.text} ${answers[q.id]}`).join('\n')
    onSubmit(text)
  }

  const submitCustom = () => {
    if (!customText.trim()) return
    setSubmitted(true)
    onSubmit(customText.trim())
  }

  return (
    <div className="neo-world neo-panel flex flex-col gap-4 rounded-2xl bg-paper-raised p-4">
      {questions.map((q) => (
        <div key={q.id} className="flex flex-col gap-2">
          <p className="text-sm font-medium text-ink">{q.text}</p>
          <div className="flex flex-wrap gap-2">
            {q.options.map((opt) => {
              const selected = answers[q.id] === opt
              return (
                <button
                  key={opt}
                  type="button"
                  aria-pressed={selected}
                  className={`fa-press rounded-full px-3.5 py-2 text-sm font-medium transition-shadow ${
                    selected ? 'neo-inset text-accent-text' : 'neo-raised text-ink-soft'
                  }`}
                  onClick={() => setAnswers((prev) => ({ ...prev, [q.id]: opt }))}
                >
                  {opt}
                </button>
              )
            })}
          </div>
        </div>
      ))}

      {typing ? (
        // fa-card-drop, the same settle-into-place CellTweak's own popover
        // uses for the identical moment elsewhere — a small editor appearing
        // in place of what was just tapped.
        <div className="fa-card-drop flex flex-col gap-2">
          <label className="visually-hidden" htmlFor="clarify-custom-input">
            Type your own answer instead
          </label>
          <textarea
            id="clarify-custom-input"
            className="input"
            autoFocus
            rows={2}
            placeholder="Type your own answer instead…"
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submitCustom()
              }
              if (e.key === 'Escape') setTyping(false)
            }}
          />
          <div className="flex gap-2">
            <button
              type="button"
              className="fa-press neo-raised rounded-lg bg-accent-tint px-4 py-2 text-sm font-medium text-accent-text disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!customText.trim()}
              onClick={submitCustom}
            >
              Send
            </button>
            <button
              type="button"
              className="rounded-lg px-4 py-2 text-sm font-medium text-ink-muted"
              onClick={() => setTyping(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-4">
          <button
            type="button"
            className="fa-press neo-raised self-start rounded-lg bg-accent-tint px-4 py-2 text-sm font-medium text-accent-text disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!allAnswered}
            onClick={submit}
          >
            Continue
          </button>
          <button
            type="button"
            className="self-start text-sm font-medium text-ink-muted underline-offset-2 hover:underline"
            onClick={() => setTyping(true)}
          >
            Type instead
          </button>
        </div>
      )}
    </div>
  )
}
