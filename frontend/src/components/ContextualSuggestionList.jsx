export function ContextualSuggestionList({ suggestions = [], onSelect, className = '' }) {
  if (!suggestions.length) return null

  return (
    <div className={`flex flex-col gap-1 ${className}`} aria-label="Suggested actions">
      {suggestions.map((suggestion, index) => (
        <button
          key={suggestion.id}
          type="button"
          className={`flex items-start gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
            index === 0 ? 'neo-inset bg-paper-sunken' : 'hover:bg-paper-sunken'
          }`}
          onClick={() => onSelect?.(suggestion)}
        >
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-ink">{suggestion.label}</span>
            <span className="mt-0.5 block text-xs text-ink-muted">{suggestion.reason}</span>
          </span>
          {index === 0 ? <span className="mt-0.5 shrink-0 text-[0.625rem] text-ink-faint">Suggested</span> : null}
        </button>
      ))}
    </div>
  )
}
