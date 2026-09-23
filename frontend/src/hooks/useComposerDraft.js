import { useEffect, useRef } from 'react'
import { accountStorageKey } from '../lib/accountStorage'

const PREFIX = 'composer-draft'
// Only mounted writers are retained. Explicit sends invalidate their pending
// writes as well as storage, so cleanup cannot restore text that was sent.
const activeDrafts = new Map()

function persistDraft(draft) {
  if (!draft.dirty) return
  try {
    if (draft.value) localStorage.setItem(draft.key, draft.value)
    else localStorage.removeItem(draft.key)
    draft.dirty = false
  } catch {
    // Draft storage is best-effort when the browser blocks localStorage.
  }
}

// One narrow migration for drafts produced by the old contextual-completion
// loop. Those drafts are recognizable because the generated wrapper appears
// twice; repairing only that exact shape protects anything the teacher typed
// intentionally while making an already-open chat recover on refresh.
function repairLegacyGhostDraft(value) {
  const saved = String(value || '')
  const duplicate = saved.match(/^(let['’]?s\s+keep\s+building\s+the\s+)keep\s+building\s+the\s+/i)
  if (!duplicate) return saved

  const remainder = saved.slice(duplicate[0].length).trimStart()
  // The remainder in the reported case is a generated question card, not a
  // teacher-authored topic. Avoid restoring that long, truncated question
  // into a fixed one-line composer.
  if (/^(?:which|what|how|why|when|where)\b/i.test(remainder)) return "Let's keep building this lesson plan."
  return `${duplicate[1]}${remainder}`
}

/* Backs the composer's typed text to localStorage, keyed per chat — so
 * navigating away mid-sentence, or a refresh, doesn't just lose it. Text
 * only: attachments are real File objects (not meaningfully serializable
 * through localStorage) and voice/recording state has its own lifecycle;
 * neither belongs here.
 *
 * Syncs to the NEW key's own saved draft (or '' if none) every time `key`
 * changes, not just on first mount — switching between two chats each
 * mid-draft should show each its own text, not whatever was left over from
 * the one you were just on. `key` is `chatId` when one exists, else
 * `new:${classId}` for a chat that doesn't exist yet — a draft started
 * before the first message creates the chat still isn't lost.
 *
 * Writes debounce while typing, but the old key's latest draft is flushed
 * before restoring a new key or unmounting. Explicit sends also invalidate
 * the pending writer before the cleared value reaches React.
 *
 * The latest text is recorded during render, not only in the value effect.
 * A chat switch can commit before that effect runs — filling the composer
 * and navigating on the next tick is enough — and the key cleanup would
 * otherwise flush the previous chat's empty draft and drop the unsent idea. */
export function useComposerDraft(key, value, setValue, accountId) {
  const storageKey = accountStorageKey(PREFIX, accountId, key)
  const currentDraft = useRef(null)
  const restoreValue = useRef(setValue)
  restoreValue.current = setValue

  const mounted = currentDraft.current
  if (mounted && mounted.value !== value) {
    // This render still belongs to the draft currently mounted, including
    // the render that switches chats: voice/text state updates after the
    // key effect restores the destination. Capture it before that flush.
    mounted.value = value
    mounted.dirty = true
  }

  useEffect(() => {
    if (!storageKey) {
      currentDraft.current = null
      return undefined
    }
    let draft = currentDraft.current
    if (draft?.key !== storageKey) {
      let saved = ''
      try {
        saved = localStorage.getItem(storageKey) || ''
      } catch {
        // Recovery remains optional when browser storage is unavailable.
      }
      const repaired = repairLegacyGhostDraft(saved)
      draft = { key: storageKey, value: repaired, dirty: repaired !== saved, timer: null }
      currentDraft.current = draft
      restoreValue.current(repaired)
      persistDraft(draft)
    }
    // The same commit still contains the previous key's value. StrictMode
    // also replays this setup; reuse its restored draft without restoring a
    // second time or overwriting a route handoff applied by a later effect.
    draft.skipObservation = true
    const writers = activeDrafts.get(storageKey) || new Set()
    writers.add(draft)
    activeDrafts.set(storageKey, writers)
    const flush = () => {
      clearTimeout(draft.timer)
      draft.timer = null
      persistDraft(draft)
    }
    if (typeof window !== 'undefined') window.addEventListener('pagehide', flush)
    return () => {
      flush()
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', flush)
      writers.delete(draft)
      if (!writers.size) activeDrafts.delete(storageKey)
    }
  }, [storageKey])

  useEffect(() => {
    const draft = currentDraft.current
    if (!draft || draft.key !== storageKey) return undefined
    if (draft.skipObservation) {
      draft.skipObservation = false
      return undefined
    }
    if (draft.value !== value) {
      draft.value = value
      draft.dirty = true
    }
    // Render may already have copied this text onto the draft. Still arm the
    // debounced write; returning early here would leave it only in the ref
    // until the next navigation.
    if (!draft.dirty) return undefined
    if (!value) {
      persistDraft(draft)
      return undefined
    }
    draft.timer = setTimeout(() => persistDraft(draft), 400)
    return () => { clearTimeout(draft.timer); draft.timer = null }
  }, [storageKey, value])
}

/** Explicit clear at the moment a message actually sends — a message that
 *  went out shouldn't leave a stale draft behind to reappear on the next
 *  visit, and waiting for the debounced write-back above to notice `value`
 *  went empty would leave a ~400ms window where a refresh mid-send restores
 *  text that was already sent. */
export function clearComposerDraft(key, accountId) {
  const storageKey = accountStorageKey(PREFIX, accountId, key)
  if (!storageKey) return
  for (const draft of activeDrafts.get(storageKey) || []) {
    clearTimeout(draft.timer)
    draft.timer = null
    draft.dirty = false
  }
  try {
    localStorage.removeItem(storageKey)
  } catch {
    // ignore
  }
}
