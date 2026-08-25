import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

export function AccordionPanel({ title, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="bg-paper-raised border border-edge rounded-xl shadow-sm mb-3 overflow-hidden transition-all duration-200">
      <button 
        type="button" 
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2.5 bg-paper hover:bg-paper-sunken transition-colors outline-none"
      >
        <span className="text-sm font-semibold text-ink">{title}</span>
        {open ? <ChevronDown size={14} className="text-ink-muted" /> : <ChevronRight size={14} className="text-ink-muted" />}
      </button>
      {open && (
        <div className="p-1 border-t border-edge bg-paper-raised">
          {children}
        </div>
      )}
    </div>
  )
}
