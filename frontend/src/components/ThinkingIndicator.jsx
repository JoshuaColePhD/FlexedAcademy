import React from 'react'

export function ThinkingIndicator() {
  return (
    <div className="flex w-fit items-center gap-3 rounded-full bg-paper px-4 py-2.5 shadow-[inset_1px_1px_2px_rgba(var(--neo-dark-rgb),0.1),inset_-1px_-1px_2px_rgba(var(--neo-light-rgb),0.3)]">
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-[rgb(var(--accent-rgb))] opacity-80 shadow-[0_0_8px_rgba(var(--accent-rgb),0.6)] animate-bounce" style={{ animationDelay: '0ms' }} />
        <span className="h-1.5 w-1.5 rounded-full bg-[rgb(var(--accent-rgb))] opacity-80 shadow-[0_0_8px_rgba(var(--accent-rgb),0.6)] animate-bounce" style={{ animationDelay: '150ms' }} />
        <span className="h-1.5 w-1.5 rounded-full bg-[rgb(var(--accent-rgb))] opacity-80 shadow-[0_0_8px_rgba(var(--accent-rgb),0.6)] animate-bounce" style={{ animationDelay: '300ms' }} />
      </div>
      <span className="text-xs font-medium tracking-wide text-ink-soft">Thinking...</span>
    </div>
  )
}
