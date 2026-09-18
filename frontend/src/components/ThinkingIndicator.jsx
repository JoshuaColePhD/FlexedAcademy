import { AnimatePresence, motion } from 'framer-motion'
import { chatStatusLabel } from '../lib/chatStatus'

/** The waiting state for a reply that has not produced a token yet.
 *
 * The line now tracks the stream's real phase instead of sitting on one static
 * string for the whole wait. It crossfades rather than snapping, matching the
 * thinking -> content transition in Message, and announces politely so a screen
 * reader reads each phase once rather than re-reading on every frame.
 */
export function ThinkingIndicator({ label = 'One sec', code }) {
  const line = chatStatusLabel(code, label)
  return (
    <div className="chat-thinking-state" role="status" aria-live="polite">
      <span className="chat-thinking-mark" aria-hidden="true" />
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={line}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
        >
          {line}<span aria-hidden="true">…</span>
        </motion.span>
      </AnimatePresence>
    </div>
  )
}
