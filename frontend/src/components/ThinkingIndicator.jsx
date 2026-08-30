export function ThinkingIndicator() {
  return (
    <div className="chat-thinking-state" role="status" aria-label="Thinking">
      <span className="chat-thinking-mark" aria-hidden="true" />
      <span>Thinking<span aria-hidden="true">…</span></span>
    </div>
  )
}
