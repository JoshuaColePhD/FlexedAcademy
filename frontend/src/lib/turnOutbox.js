import { readAccountStorage, removeAccountStorage, writeAccountStorage } from './accountStorage'

/* A tiny, account-scoped outbox for the one thing a chat must never lose:
 * the teacher's explicit send. File objects cannot survive a reload, so only
 * attachment metadata/text is retained here; the original File remains in
 * memory while the tab is alive. */
const namespace = 'turn-outbox'

export function outboxScope(chatKey) {
  return encodeURIComponent(String(chatKey || 'new'))
}

export function readTurnOutbox(accountId, chatKey) {
  const raw = readAccountStorage(namespace, accountId, outboxScope(chatKey))
  if (!raw) return null
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || typeof value.text !== 'string') return null
    return value
  } catch {
    return null
  }
}

export function writeTurnOutbox(accountId, chatKey, item) {
  if (!item) return removeTurnOutbox(accountId, chatKey)
  return writeAccountStorage(namespace, accountId, outboxScope(chatKey), JSON.stringify(item))
}

export function removeTurnOutbox(accountId, chatKey) {
  return removeAccountStorage(namespace, accountId, outboxScope(chatKey))
}

export function durableTurnSnapshot({ id, text, attachments = [] }) {
  return {
    id,
    text: String(text || ''),
    attachments: attachments.map((attachment) => ({
      filename: attachment?.filename || attachment?.name || 'attachment',
      text: typeof attachment?.text === 'string' ? attachment.text : '',
      chars: Number(attachment?.chars || attachment?.text?.length || 0),
    })),
    createdAt: Date.now(),
  }
}
