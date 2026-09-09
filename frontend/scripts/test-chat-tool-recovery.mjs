import {
  recoverClarifyingQuestionsFromText,
  recoverDumpedToolsFromText,
} from '../src/lib/chatToolRecovery.js'

const dumped = JSON.stringify({ questions: [{ id: 'x', text: 'What text?', options: ['A'] }] })
const dumpedHit = recoverClarifyingQuestionsFromText(dumped, {})
if (!dumpedHit.questions || dumpedHit.questions.length !== 1) {
  console.error('dump parse failed')
  process.exit(2)
}

const preferTool = recoverClarifyingQuestionsFromText(dumped, {
  questions: [{ id: 'tool', text: 'From the tool' }],
  toolCalled: true,
})
if (preferTool.questions[0].id !== 'tool') process.exit(3)
if (preferTool.text !== dumped) process.exit(4)

const quizDump = JSON.stringify({ question_types: ['true_false'], num_questions: 5 })
const quizHit = recoverDumpedToolsFromText(quizDump, {})
if (!quizHit.quizRequested || quizHit.quizRequested.questionTypes[0] !== 'true_false') {
  console.error('quiz dump parse failed')
  process.exit(5)
}
if (quizHit.text !== '') process.exit(6)

const preferQuizEvent = recoverDumpedToolsFromText(quizDump, {
  quizRequested: { questionTypes: ['multiple_choice'] },
  toolCalled: true,
})
if (preferQuizEvent.quizRequested.questionTypes[0] !== 'multiple_choice') process.exit(7)

const dayDump = JSON.stringify({ day: 'Thursday', field: 'during', feedback: 'Socratic seminar' })
const dayHit = recoverDumpedToolsFromText(dayDump, {})
if (!dayHit.dayRevisionRequested || dayHit.dayRevisionRequested.day !== 'Thursday') {
  console.error('day dump parse failed')
  process.exit(8)
}

console.log('ok')
