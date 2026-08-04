import { Monitor, Moon, Sun } from 'lucide-react'

const NEXT_LABEL = { light: 'dark', dark: 'system', system: 'light' }

export function ThemeToggle({ mode, onCycle }) {
  const Icon = mode === 'light' ? Sun : mode === 'dark' ? Moon : Monitor
  return (
    <button
      type="button"
      className="btn-icon"
      onClick={onCycle}
      aria-label={`Theme: ${mode}. Switch to ${NEXT_LABEL[mode]}.`}
      title={`Theme: ${mode}`}
    >
      <Icon size={16} aria-hidden="true" />
    </button>
  )
}
