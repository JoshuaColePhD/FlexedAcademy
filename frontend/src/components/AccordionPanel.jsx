import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown } from 'lucide-react'

/** `forceOpen` is distinct from `defaultOpen` — `defaultOpen` only seeds the
 *  panel's own state on first mount (a plain useState default), so it can't
 *  reach in and reopen a panel a teacher already collapsed. `forceOpen` is
 *  for the one case that needs to: "This week" (ArtifactRail.jsx) starts
 *  collapsed, but a plan actually generating is worth surfacing on its own,
 *  not left waiting for someone to notice and click. Fires once per rising
 *  edge (false→true), so a teacher who collapses it again mid-generation
 *  stays collapsed rather than being fought over every render. */
export function AccordionPanel({ title, defaultOpen = true, forceOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen)

  useEffect(() => {
    if (forceOpen) setOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceOpen])

  return (
    <div className="bg-paper-raised border border-edge rounded-xl shadow-sm mb-3 overflow-hidden">
      <button 
        type="button" 
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2.5 bg-paper hover:bg-paper-sunken transition-colors outline-none"
      >
        <span className="text-sm font-semibold text-ink">{title}</span>
        <motion.div
          animate={{ rotate: open ? 0 : -90 }}
          transition={{ duration: 0.2 }}
        >
          <ChevronDown size={14} className="text-ink-muted" />
        </motion.div>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="content"
            initial="collapsed"
            animate="open"
            exit="collapsed"
            variants={{
              open: { opacity: 1, height: 'auto' },
              collapsed: { opacity: 0, height: 0 }
            }}
            transition={{ duration: 0.3, ease: [0.04, 0.62, 0.23, 0.98] }}
          >
            <div className="p-1 border-t border-edge bg-paper-raised">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
