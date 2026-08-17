import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'

/* A hover/focus tooltip, shared rather than reimplemented per component.
 *
 * This exists because ArtifactPanel.jsx started importing `./Tooltip` for a
 * template-fallback warning icon, but the file was never created — a build
 * break (`Could not resolve './Tooltip'`). SettingsPage.jsx already had its own
 * near-identical local `Tooltip({ text, children })`; this is that
 * implementation promoted to a shared component so the two don't drift, with
 * `content` instead of `text` (matching what ArtifactPanel's call site already
 * expects) and a `position` prop for the one non-default placement in use.
 *
 * Token-driven (`bg-ink`/`text-paper`), not a hardcoded color — the thing this
 * app's own design-system conventions ask for.
 */
export function Tooltip({ content, position = 'top', children }) {
  const [show, setShow] = useState(false)

  const placement =
    position === 'bottom-right'
      ? 'left-0 top-full mt-2'
      : position === 'bottom'
        ? 'left-1/2 top-full mt-2 -translate-x-1/2'
        : // 'top', the default: centered above the trigger.
          'left-1/2 bottom-full mb-2 -translate-x-1/2'

  return (
    <span
      className="relative inline-flex items-center"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      onFocus={() => setShow(true)}
      onBlur={() => setShow(false)}
    >
      {children}
      <AnimatePresence>
        {show && (
          <motion.span
            role="tooltip"
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 5 }}
            className={`pointer-events-none absolute z-50 w-max max-w-xs rounded bg-ink px-2 py-1.5 text-xs text-paper shadow-lg ${placement}`}
          >
            {content}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  )
}
