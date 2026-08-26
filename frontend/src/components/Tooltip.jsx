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
export function Tooltip({ content, position = 'top', interactive = false, children }) {
  const [show, setShow] = useState(false)

  const placement =
    position === 'bottom-right'
      ? 'left-0 top-full pt-2'
      : position === 'bottom'
        ? 'left-1/2 top-full pt-2 -translate-x-1/2'
        : // 'top', the default: centered above the trigger.
          'left-1/2 bottom-full pb-2 -translate-x-1/2'

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
          <div
            className={`absolute z-50 flex ${interactive ? '' : 'pointer-events-none'} ${placement}`}
          >
            <motion.div
              role="tooltip"
              initial={{ opacity: 0, scale: 0.9, y: position.startsWith('bottom') ? -5 : 5 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: position.startsWith('bottom') ? -5 : 5 }}
              transition={{ type: "spring", stiffness: 350, damping: 20 }}
              className="w-max max-w-xs rounded bg-ink px-2 py-1.5 text-xs text-paper shadow-lg"
            >
              {content}
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </span>
  )
}
