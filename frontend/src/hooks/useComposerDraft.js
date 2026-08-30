import { useEffect, useRef } from 'react'
import { useDebouncedValue } from './useDebouncedValue'
import { accountStorageKey } from '../lib/accountStorage'

const PREFIX = 'composer-draft'

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
 * Writes debounce off the SAME trailing-value hook Standards' search filter
 * already uses (useDebouncedValue) rather than writing on every keystroke.
 * Clearing on an actual send is the caller's job (see clearComposerDraft,
 * used from ChatPage's submit()) — this hook only reacts to `value` itself
 * going empty, which is one render behind a fresh send. */
export function useComposerDraft(key, value, setValue, accountId) {
  // useDebouncedValue's own `debounced` state initializes to whatever
  // `value` IS on this hook's first call for a given mount — '' at that
  // point, since the restore effect below hasn't run yet. Without this
  // flag, the write-back effect's first firing (same commit, `debounced`
  // still '') would `removeItem` the draft this render is in the middle of
  // restoring, before React ever paints the restored text. Set back to
  // true by the restore effect itself (declared first, so it runs first)
  // whenever `key` changes, so a chat switch gets the same one-render
  // grace period a fresh mount does.
  const skipNextWriteRef = useRef(true)

  useEffect(() => {
    skipNextWriteRef.current = true
    const storageKey = accountStorageKey(PREFIX, accountId, key)
    if (!storageKey) return
    let saved = ''
    try {
      saved = localStorage.getItem(storageKey) || ''
    } catch {
      // localStorage blocked (private mode, storage full) — draft recovery
      // just doesn't happen; nothing else here depends on it.
    }
    setValue(saved)
    // Only re-run when the KEY changes — re-firing on every `value` change
    // would fight the user's own typing by resetting it back to whatever
    // was last saved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, accountId])

  const debouncedValue = useDebouncedValue(value, 400)
  useEffect(() => {
    const storageKey = accountStorageKey(PREFIX, accountId, key)
    if (!storageKey) return
    if (skipNextWriteRef.current) {
      skipNextWriteRef.current = false
      return
    }
    try {
      if (debouncedValue) localStorage.setItem(storageKey, debouncedValue)
      else localStorage.removeItem(storageKey)
    } catch {
      // ignore — see above
    }
  }, [key, accountId, debouncedValue])
}

/** Explicit clear at the moment a message actually sends — a message that
 *  went out shouldn't leave a stale draft behind to reappear on the next
 *  visit, and waiting for the debounced write-back above to notice `value`
 *  went empty would leave a ~400ms window where a refresh mid-send restores
 *  text that was already sent. */
export function clearComposerDraft(key, accountId) {
  const storageKey = accountStorageKey(PREFIX, accountId, key)
  if (!storageKey) return
  try {
    localStorage.removeItem(storageKey)
  } catch {
    // ignore
  }
}
