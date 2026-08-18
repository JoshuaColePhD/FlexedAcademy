import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme } from '../hooks/useTheme'

const NEXT_LABEL = { light: 'dark', dark: 'system', system: 'light' }

/* Calls useTheme itself rather than taking mode/onCycle as props.
 *
 * It used to be handed them through the Shell object, and when that went away
 * nothing was passing them — the button rendered "Theme: undefined. Switch to
 * undefined." and did nothing on click. It is the only consumer of the hook, so
 * owning the call is both simpler and impossible to wire up wrong. */
export function ThemeToggle() {
  const { mode, cycle } = useTheme()
  const Icon = mode === 'light' ? Sun : mode === 'dark' ? Moon : Monitor
  return (
    <button
      type="button"
      className="btn-icon bg-paper-raised"
      onClick={cycle}
      aria-label={`Theme: ${mode}. Switch to ${NEXT_LABEL[mode]}.`}
      title={`Theme: ${mode}`}
    >
      <Icon size={16} aria-hidden="true" />
    </button>
  )
}
