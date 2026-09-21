import assert from 'node:assert/strict'
import { readFirstPlanDraft, writeFirstPlanDraft, clearFirstPlanDraft, firstPlanPrompt } from '../src/lib/firstPlanSetup.js'

const values = new Map()
globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) }
writeFirstPlanDraft('teacher-a', { step: 'preview', classId: 'c1', state: 'AL', grade: '0', subject: 'ela', topic: 'Comparing stories', week: 3 })
assert.equal(readFirstPlanDraft('teacher-a').step, 'preview')
assert.equal(readFirstPlanDraft('teacher-a').grade, '0', 'kindergarten is an explicit grade')
assert.equal(readFirstPlanDraft('teacher-b'), null, 'account drafts cannot cross identities')
writeFirstPlanDraft('teacher-b', { step: 'preview', grade: '', topic: 'My next week' })
assert.equal(readFirstPlanDraft('teacher-b').step, 'context', 'unsaved classes cannot skip the class step')
assert.match(firstPlanPrompt('Argument in two speeches', 4), /Week 4/)
assert.match(firstPlanPrompt('Argument in two speeches', 4), /Argument in two speeches/)
clearFirstPlanDraft('teacher-a')
assert.equal(readFirstPlanDraft('teacher-a'), null)
assert.equal(readFirstPlanDraft('teacher-b').topic, 'My next week')
console.log('First-plan resume, account isolation, and handoff tests passed')
