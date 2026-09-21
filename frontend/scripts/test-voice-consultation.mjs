import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { transform } from 'esbuild'

const source = await readFile(new URL('../src/hooks/useVoiceConsultation.js', import.meta.url), 'utf8')
const { code } = await transform(source, { loader: 'js', format: 'cjs' })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const edit = { planAction: { action: 'revise', target_plan_id: 'p1', instruction: 'Add a worked example on Tuesday.' }, text: 'I have noted that change.' }
function harness(overrides = {}) {
  let cursor = 0, dirty = true, callbacks, view, serial = 0
  const slots = [], effects = [], pendingMessages = []
  const calls = { submits: [], consultations: [], appended: [], persisted: [], spoken: [] }
  const changed = (a, b) => !a || !b || a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]))
  const react = {
    useRef(value) { const i = cursor++; return slots[i] ||= { current: value } },
    useState(initial) {
      const i = cursor++; slots[i] ||= { value: initial }
      return [slots[i].value, (update) => { const next = typeof update === 'function' ? update(slots[i].value) : update; if (!Object.is(next, slots[i].value)) dirty = true; slots[i].value = next }]
    },
    useCallback(fn, deps) { const i = cursor++; if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { value: fn, deps }; return slots[i].value },
    useEffect(effect, deps) {
      const i = cursor++
      if (!slots[i] || changed(slots[i].deps, deps)) effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: effect() } })
    },
  }
  const stream = {
    isStreaming: false, text: '',
    start(messages, options) {
      const pending = deferred()
      calls.consultations.push({ messages, options, ...pending })
      stream.isStreaming = true; dirty = true
      return pending.promise.finally(() => { stream.isStreaming = false; dirty = true })
    },
    stop() { for (const call of calls.consultations) call.resolve(null); stream.isStreaming = false; dirty = true },
  }
  let options = {
    open: true, busy: true, preparing: false, artifactBusy: true,
    messages: [], planId: 'p1', chatId: 'chat1', classId: 'c1', weekNumber: 4,
    saveState: 'saving', planWorkResult: null,
    voice: { status: 'live', speak: (text) => calls.spoken.push(text), cancelSpeech() {} },
    stopReply() {},
    submit(text, args) { const pending = deferred(); calls.submits.push({ text, args, ...pending }); return pending.promise },
    appendMessage(message) { calls.appended.push(message); pendingMessages.push(message); dirty = true },
    persistMessage(chatId, message) { calls.persisted.push({ chatId, message }); return Promise.resolve() },
    ...overrides,
  }
  const modules = { react, './useChatStream': { useChatStream: (value) => { callbacks = value; return stream } }, '../lib/chatActions': { chatMessageText: (message) => message.content } }
  const module = { exports: {} }
  vm.runInNewContext(code, { module, exports: module.exports, require: (id) => modules[id], crypto: { randomUUID: () => `m${++serial}` } })
  const render = () => {
    if (pendingMessages.length) options = { ...options, messages: [...options.messages, ...pendingMessages.splice(0)] }
    dirty = false; cursor = 0; view = module.exports.useVoiceConsultation(options)
    while (effects.length) effects.shift()()
    return view
  }
  const flush = async () => {
    for (let i = 0; i < 20; i++) { await new Promise((resolve) => setImmediate(resolve)); if (!dirty) return view; render() }
    throw new Error('Hook did not settle')
  }
  render()
  return {
    calls, get hook() { return view }, render, flush,
    update(patch) { options = { ...options, ...patch }; dirty = true; render() },
    sentence(text) { callbacks.onSentence(text) },
    finish(result = edit) { if (result?.planAction || result?.quizRequested || result?.dayRevisionRequested) callbacks.onAction(result); calls.consultations.at(-1).resolve(result) },
  }
}
async function queued(h, text = 'Add an example on Tuesday.') {
  const pending = h.hook.handleUtterance(text)
  h.finish()
  await pending; await h.flush()
}
function saved(h, id, ok = true) {
  h.update({ busy: false, artifactBusy: false, saveState: ok ? 'saved' : 'error', planWorkResult: { id, ok } })
}

test('queued changes remain until the replay artifact actually saves', async () => {
  const h = harness()
  await queued(h)
  saved(h, 'original')
  assert.equal(h.calls.submits.length, 1)
  h.calls.submits[0].resolve(edit)
  await h.flush()
  assert.equal(h.hook.pendingChanges.length, 1)
  assert.equal(h.hook.pendingPaused, false)
  saved(h, 'revision')
  await h.flush()
  assert.equal(h.hook.pendingChanges.length, 0)
})

test('failed artifact retains the batch and retries despite an error save state', async () => {
  const h = harness()
  await queued(h)
  saved(h, 'original')
  h.calls.submits[0].resolve(edit)
  await h.flush()
  saved(h, 'failed', false)
  await h.flush()
  assert.equal(h.hook.pendingChanges.length, 1)
  assert.equal(h.hook.pendingPaused, true)
  h.hook.retryPending(); await h.flush()
  assert.equal(h.calls.submits.length, 2)
  h.calls.submits[1].resolve(edit)
  await h.flush()
  saved(h, 'retry')
  await h.flush()
  assert.equal(h.hook.pendingChanges.length, 0)
})

test('submit early return pauses the request instead of discarding it', async () => {
  const h = harness()
  await queued(h)
  saved(h, 'original')
  h.calls.submits[0].resolve(undefined)
  await h.flush()
  assert.equal(h.hook.pendingChanges.length, 1)
  assert.equal(h.hook.pendingPaused, true)
  assert.equal(h.calls.submits.length, 1)
})

test('empty settled input releases the replay gate without another utterance', async () => {
  const h = harness()
  await queued(h)
  h.hook.interrupt(); await h.flush()
  saved(h, 'original')
  assert.equal(h.calls.submits.length, 0)
  h.hook.handleInputSettled(); await h.flush()
  assert.equal(h.calls.submits.length, 1)
})

test('same-task barge-in preserves spoken advice in the next request context', async () => {
  const h = harness()
  const first = h.hook.handleUtterance('How should I scaffold this?')
  h.sentence('Try a worked example before independent practice.')
  h.hook.interrupt()
  const second = h.hook.handleUtterance('Use that scaffold on Tuesday.')
  const context = h.calls.consultations[1].messages
  assert.equal(context[0].content, 'How should I scaffold this?')
  assert.match(context[1].content, /worked example.*\n\n\[Interrupted\]/s)
  assert.equal(context[2].content, 'Use that scaffold on Tuesday.')
  assert.equal(h.calls.persisted.filter((call) => call.message.content.includes('[Interrupted]')).length, 1)
  h.finish(); await Promise.all([first, second]); await h.flush()
  assert.equal(h.hook.pendingChanges.length, 2)
})

test('ending voice during preparation preserves completed waiting turns without auto-submit', async () => {
  const h = harness({ preparing: true, chatId: null, planId: null })
  await h.hook.handleUtterance('Keep the reading short.')
  await h.flush()
  h.update({ open: false, preparing: false, chatId: 'new-chat', busy: false, artifactBusy: false })
  await h.flush()
  assert.equal(h.calls.submits.length, 0)
  assert.equal(h.calls.consultations.length, 0)
  assert.equal(h.calls.persisted[0].message.content, 'Keep the reading short.')
  assert.equal(h.calls.persisted[0].chatId, 'new-chat')
  assert.equal(h.hook.pendingChanges.length, 1)
  assert.equal(h.hook.pendingPaused, true)
})

test('later consultation requests survive completion of the earlier replay batch', async () => {
  const h = harness()
  await queued(h)
  saved(h, 'original')
  h.calls.submits[0].resolve(edit); await h.flush()
  h.update({ busy: true, artifactBusy: true })
  await queued(h, 'Also add an exit ticket.')
  assert.equal(h.hook.pendingChanges.length, 2)
  saved(h, 'revision')
  await h.flush()
  assert.equal(h.hook.pendingChanges.length, 1)
  assert.equal(h.hook.pendingChanges[0].text, 'Also add an exit ticket.')
  assert.equal(h.calls.submits.length, 2)
})

test('reset invalidates late replay completion without altering the next conversation', async () => {
  const h = harness()
  await queued(h)
  saved(h, 'original')
  h.hook.reset(); await h.flush()
  h.calls.submits[0].resolve(edit); await h.flush()
  saved(h, 'late-save', false); await h.flush()
  assert.equal(h.hook.pendingChanges.length, 0)
  assert.equal(h.hook.pendingPaused, false)
})

// Draft ownership uses commit-order effects: old cleanups run before any new
// setups, including when navigation and account changes happen before 400ms.
const draftSource = await readFile(new URL('../src/hooks/useComposerDraft.js', import.meta.url), 'utf8')
const { code: draftCode } = await transform(draftSource, { loader: 'js', format: 'cjs' })
function draftHarness(initial = {}) {
  let cursor = 0, timerId = 0, pendingValue
  let key = 'voice:chat-a', accountId = 'teacher-a', value = ''
  const slots = [], pendingEffects = [], timers = new Map(), storage = new Map(Object.entries(initial)), pagehide = new Set(), restored = []
  const react = {
    useRef(initialValue) { const i = cursor++; return slots[i] ||= { current: initialValue } },
    useEffect(effect, deps) {
      const i = cursor++, old = slots[i]
      if (!old || deps.some((item, index) => !Object.is(item, old.deps[index]))) pendingEffects.push({ i, effect, deps })
    },
  }
  const modules = {
    react,
    '../lib/accountStorage': { accountStorageKey: (prefix, owner, chat) => owner ? `${prefix}:${encodeURIComponent(owner)}:${chat}` : null },
  }
  const module = { exports: {} }
  vm.runInNewContext(draftCode, {
    module, exports: module.exports, require: (id) => modules[id],
    localStorage: { getItem: (storageKey) => storage.get(storageKey) ?? null, setItem: (storageKey, text) => storage.set(storageKey, text), removeItem: (storageKey) => storage.delete(storageKey) },
    setTimeout: (fn) => { const id = ++timerId; timers.set(id, fn); return id }, clearTimeout: (id) => timers.delete(id),
    window: { addEventListener: (event, fn) => { if (event === 'pagehide') pagehide.add(fn) }, removeEventListener: (event, fn) => pagehide.delete(fn) },
  })
  const commit = () => {
    const effects = pendingEffects.splice(0)
    for (const item of effects) slots[item.i]?.cleanup?.()
    for (const { i, effect, deps } of effects) slots[i] = { effect, deps, cleanup: effect() }
  }
  const render = () => {
    cursor = 0
    module.exports.useComposerDraft(key, value, (text) => { pendingValue = text; restored.push(text) }, accountId)
    commit()
  }
  const settle = () => {
    for (let i = 0; i < 10 && pendingValue !== undefined; i++) {
      const next = pendingValue; pendingValue = undefined
      if (next !== value) { value = next; render() }
    }
  }
  render()
  return {
    storage, restored, settle, get value() { return value },
    type(text) { value = text; render() },
    navigate(nextKey, nextAccount = accountId) { key = nextKey; accountId = nextAccount; render(); settle() },
    clear() { module.exports.clearComposerDraft(key, accountId) },
    tick() { for (const [id, fn] of [...timers]) { timers.delete(id); fn() } },
    pagehide() { for (const fn of pagehide) fn() },
    unmount() { for (const slot of slots) slot?.cleanup?.() },
    strictReplay() { for (const slot of slots) slot?.cleanup?.(); for (const slot of slots) if (slot?.effect) slot.cleanup = slot.effect() },
  }
}
const storageKey = (chat = 'voice:chat-a', account = 'teacher-a') => `composer-draft:${account}:${chat}`

test('draft navigation flushes the previous key immediately and restores the destination unchanged', () => {
  const h = draftHarness({ [storageKey('voice:chat-b')]: 'The other lesson.' })
  h.settle(); h.type('Keep the final sentence.')
  assert.equal(h.storage.has(storageKey()), false)
  h.navigate('voice:chat-b')
  assert.equal(h.storage.get(storageKey()), 'Keep the final sentence.')
  assert.equal(h.value, 'The other lesson.')
  h.tick()
  assert.equal(h.storage.get(storageKey('voice:chat-b')), 'The other lesson.')
  h.navigate('voice:chat-a')
  assert.equal(h.value, 'Keep the final sentence.')
  h.unmount()
})

test('draft cleanup flushes to the old account and never seeds the next account', () => {
  const h = draftHarness({ [storageKey('voice:chat-a', 'teacher-b')]: 'Their own draft.' })
  h.settle(); h.type('My private lesson idea.')
  h.navigate('voice:chat-a', 'teacher-b')
  assert.equal(h.storage.get(storageKey()), 'My private lesson idea.')
  assert.equal(h.value, 'Their own draft.')
  h.type('A new private idea.'); h.unmount()
  assert.equal(h.storage.get(storageKey('voice:chat-a', 'teacher-b')), 'A new private idea.')
})

test('an explicit send clear cannot be resurrected by a debounce, navigation, or unmount', () => {
  const h = draftHarness()
  h.settle(); h.type('A submitted voice turn.'); h.clear(); h.tick()
  assert.equal(h.storage.has(storageKey()), false)
  h.navigate('voice:chat-b'); h.unmount()
  assert.equal(h.storage.has(storageKey()), false)
})

test('new typing after an explicit clear remains eligible for preservation', () => {
  const h = draftHarness()
  h.settle(); h.type('Sent text.'); h.clear(); h.type(''); h.type('A new idea.'); h.unmount()
  assert.equal(h.storage.get(storageKey()), 'A new idea.')
})

test('StrictMode replays do not erase stored drafts or restore over route handoffs', () => {
  const h = draftHarness({ [storageKey()]: 'Stored text.' })
  h.strictReplay()
  assert.equal(h.restored.length, 1)
  assert.equal(h.storage.get(storageKey()), 'Stored text.')
  h.settle(); h.type('The route handoff.'); h.strictReplay()
  assert.equal(h.restored.length, 1)
  assert.equal(h.value, 'The route handoff.')
  h.unmount()
  assert.equal(h.storage.get(storageKey()), 'The route handoff.')
})

test('pagehide flushes the final draft and an emptied draft stays removed', () => {
  const h = draftHarness()
  h.settle(); h.type('About to refresh.'); h.pagehide()
  assert.equal(h.storage.get(storageKey()), 'About to refresh.')
  h.type(''); h.unmount()
  assert.equal(h.storage.has(storageKey()), false)
})
