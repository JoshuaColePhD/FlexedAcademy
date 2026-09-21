import { readAccountStorage, removeAccountStorage, writeAccountStorage } from './accountStorage.js'
import { normalizeGrade } from './grades.js'

const NAMESPACE = 'first-plan-setup-v1'

export function readFirstPlanDraft(accountId) {
  try {
    const value = JSON.parse(readAccountStorage(NAMESPACE, accountId) || 'null')
    if (!value || value.version !== 1) return null
    return {
      version: 1,
      classId: typeof value.classId === 'string' ? value.classId : '',
      step: value.step === 'preview' && value.classId ? 'preview' : 'context',
      state: typeof value.state === 'string' ? value.state.slice(0, 2) : '',
      grade: normalizeGrade(value.grade) || '',
      subject: typeof value.subject === 'string' ? value.subject.slice(0, 120) : '',
      school: typeof value.school === 'string' ? value.school : 'generic',
      topic: typeof value.topic === 'string' ? value.topic.slice(0, 4000) : '',
      week: Number.isInteger(Number(value.week)) && Number(value.week) > 0 ? String(value.week) : '',
    }
  } catch {
    return null
  }
}

export function writeFirstPlanDraft(accountId, draft) {
  return writeAccountStorage(NAMESPACE, accountId, '', JSON.stringify({ ...draft, version: 1 }))
}

export function clearFirstPlanDraft(accountId) {
  removeAccountStorage(NAMESPACE, accountId)
}

export function firstPlanPrompt(topic, weekNumber, weekLabel = '') {
  return `Build my first weekly lesson plan for ${weekLabel || `Week ${weekNumber}`} using my saved class, grade, and available course standards.\n\nWhat I am teaching: ${String(topic).trim()}\n\nCreate a practical first draft with learning goals, daily activities, checks for understanding, and inspectable standards citations where sources are available. Clearly identify any missing standards or assumptions.`
}
