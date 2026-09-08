export const CHAT_AVATAR_COLORS = ['#63c6bb', '#f4a13a', '#8d68e8', '#4388e9', '#f2762e', '#6dbaa5']

export function formatChatListTime(iso) {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  if (sameDay) return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(date)
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date)
}

export function chatPreview(chat) {
  const preview = chat.last_message_preview || chat.preview || ''
  if (preview) return preview.replace(/\s+/g, ' ').trim()
  return 'Start the conversation.'
}

export function chatAvatarColor(chat) {
  const hash = Array.from(String(chat?.id || 'new')).reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 0)
  return CHAT_AVATAR_COLORS[hash % CHAT_AVATAR_COLORS.length]
}
