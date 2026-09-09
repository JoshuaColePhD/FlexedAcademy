export const CLARIFY_MARKER = '<!--flexed:clarifying_questions-->'

export function stripClarifyMarker(content) {
  return String(content || '').replace(new RegExp(`^${CLARIFY_MARKER}\\s*`), '')
}

export function isClarifyingMessage(message) {
  if (!message) return false
  if (message.kind === 'clarifying_questions' || message.questions?.length) return true
  return String(message.content || '').includes(CLARIFY_MARKER)
}

function asQuizRequested(parsed) {
  const types = parsed.question_types || parsed.questionTypes
  if (!types) return null
  const known = (Array.isArray(types) ? types : [types]).filter(Boolean)
  return {
    questionTypes: known.length ? known : ['multiple_choice'],
    numQuestions: parsed.num_questions || parsed.numQuestions || 10,
    passageMode: parsed.passage_mode || parsed.passageMode || 'none',
    passageTitle: parsed.passage_title || parsed.passageTitle || '',
    passageText: parsed.passage_text || parsed.passageText || '',
    revisesCurrent: !!parsed.revises_current || !!parsed.revisesCurrent,
  }
}

function asDayRevision(parsed) {
  if (!parsed.day || !parsed.field || !parsed.feedback) return null
  return {
    day: parsed.day,
    field: parsed.field,
    feedback: parsed.feedback,
  }
}

/**
 * Prefer a real tool_call event. Only parse streamed JSON when the model
 * dumped tool arguments as literal text instead.
 */
export function recoverDumpedToolsFromText(accumulated, {
  questions = null,
  toolCalled = false,
  quizRequested = null,
  dayRevisionRequested = null,
} = {}) {
  if (questions || toolCalled || quizRequested || dayRevisionRequested) {
    return {
      questions: questions || null,
      quizRequested,
      dayRevisionRequested,
      text: accumulated,
    }
  }
  const trimmed = String(accumulated || '').trim()
  if (!trimmed.startsWith('{')) {
    return { questions: null, quizRequested: null, dayRevisionRequested: null, text: accumulated }
  }
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed.questions) && parsed.questions.length) {
      return { questions: parsed.questions, quizRequested: null, dayRevisionRequested: null, text: '' }
    }
    const quiz = asQuizRequested(parsed)
    if (quiz) {
      return { questions: null, quizRequested: quiz, dayRevisionRequested: null, text: '' }
    }
    const day = asDayRevision(parsed)
    if (day) {
      return { questions: null, quizRequested: null, dayRevisionRequested: day, text: '' }
    }
  } catch {
    // Not parseable JSON — leave the reply as plain text.
  }
  return { questions: null, quizRequested: null, dayRevisionRequested: null, text: accumulated }
}

/** @deprecated Prefer recoverDumpedToolsFromText. Kept for callers that only recover clarifying questions. */
export function recoverClarifyingQuestionsFromText(accumulated, state = {}) {
  const recovered = recoverDumpedToolsFromText(accumulated, state)
  return { questions: recovered.questions, text: recovered.text }
}
