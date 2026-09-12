import assert from 'node:assert/strict'
import { firstUnplanned } from '../src/lib/queue.js'
import {
  canPinNewChatToWeek,
  existingChatForWeek,
  newChatWeekOptions,
  pinWeekForNewChat,
  priorWeeksWithWork,
} from '../src/lib/weekAccess.js'

const weeks = [
  { week: 1, no_school: false, is_past: true, has_plan: false, chat_id: null },
  { week: 2, no_school: false, is_past: true, has_plan: true, chat_id: 'chat-w2' },
  { week: 3, no_school: false, is_past: false, is_current: true, has_plan: true, chat_id: 'chat-w3' },
  { week: 4, no_school: false, is_past: false, has_plan: false, chat_id: null },
  { week: 5, no_school: true, is_past: false, has_plan: false, chat_id: null },
]

assert.equal(firstUnplanned(weeks)?.week, 4)
assert.equal(pinWeekForNewChat(weeks, null), 4)
assert.equal(pinWeekForNewChat(weeks, 4), 4)
assert.equal(pinWeekForNewChat(weeks, 3), 3)
assert.equal(pinWeekForNewChat(weeks, 2), 4, 'past week must not pin a new chat')
assert.equal(pinWeekForNewChat(weeks, 1), 4)
assert.equal(pinWeekForNewChat(weeks, 99), 4)

assert.equal(canPinNewChatToWeek(weeks[1]), false)
assert.equal(canPinNewChatToWeek(weeks[2]), true)
assert.equal(existingChatForWeek(weeks[1]), 'chat-w2')

const pinOptions = newChatWeekOptions(weeks, null)
assert.deepEqual(pinOptions.map((w) => w.week), [3, 4])

const pinOptionsOnPastChat = newChatWeekOptions(weeks, 2)
assert.deepEqual(pinOptionsOnPastChat.map((w) => w.week), [2, 3, 4])

const prior = priorWeeksWithWork(weeks, null)
assert.deepEqual(prior.map((w) => w.week), [2])
assert.equal(priorWeeksWithWork(weeks, 2).length, 0)

console.log('week-access ok')
