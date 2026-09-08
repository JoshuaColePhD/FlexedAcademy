export function ThinkingIndicator({ label = 'Thinking' }) {
  return (
    <div className="chat-thinking-state" role="status" aria-label={label}>
      <span className="chat-thinking-mark" aria-hidden="true" />
      <span>{label}<span aria-hidden="true">…</span></span>
    </div>
  )
}
