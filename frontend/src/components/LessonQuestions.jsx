import { useState } from 'react'

/* The guided alternative to typing a paragraph, for the one message that's too
 * vague to build from ("I want to make a lesson"). The model (see
 * backend/llm.py's ask_clarifying_questions tool) picks 2-4 short questions
 * and a few options each, on request — this only renders what it sent, it
 * never invents a fixed question set of its own.
 *
 * Single-select per question, on purpose: this is a quick way to point the
 * model in a direction, not a form. A teacher who wants to say something more
 * specific than any option offered still has the composer for that — Continue
 * only needs every question touched, not a perfect answer to each.
 */
export function LessonQuestions({ questions, onSubmit }) {
  const [answers, setAnswers] = useState({})
  const [submitted, setSubmitted] = useState(false)

  if (submitted) return null

  const allAnswered = questions.every((q) => answers[q.id])

  const submit = () => {
    setSubmitted(true)
    const text = questions.map((q) => `${q.text} ${answers[q.id]}`).join('\n')
    onSubmit(text)
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
                  className={`rounded-full px-3.5 py-2 text-sm font-medium transition-shadow ${
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
      <button
        type="button"
        className="neo-raised mt-1 self-start rounded-lg bg-accent-tint px-4 py-2 text-sm font-medium text-accent-text disabled:cursor-not-allowed disabled:opacity-50"
        disabled={!allAnswered}
        onClick={submit}
      >
        Continue
      </button>
    </div>
  )
}
