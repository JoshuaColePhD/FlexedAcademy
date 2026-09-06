import { Sparkles } from 'lucide-react'

export function ThinkingIndicator() {
  return (
    <div className="chat-thinking-state" role="status" aria-label="Crafting your lesson">
      <span className="chat-thinking-mark" aria-hidden="true" />
      <Sparkles size={14} className="chat-thinking-spark" aria-hidden="true" />
      <span>Crafting your lesson<span aria-hidden="true">…</span></span>
    </div>
  )
}
