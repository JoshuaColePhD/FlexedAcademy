import os

file_path = "frontend/src/pages/SettingsPage.jsx"
with open(file_path, "r") as f:
    content = f.read()

# 1. Add Tooltip component
tooltip_code = """
import { motion, AnimatePresence } from 'framer-motion'

function Tooltip({ text, children }) {
  const [show, setShow] = useState(false)
  return (
    <div 
      className="relative flex items-center" 
      onMouseEnter={() => setShow(true)} 
      onMouseLeave={() => setShow(false)}
      onFocus={() => setShow(true)}
      onBlur={() => setShow(false)}
    >
      {children}
      <AnimatePresence>
        {show && (
          <motion.div 
            initial={{ opacity: 0, y: 5 }} 
            animate={{ opacity: 1, y: 0 }} 
            exit={{ opacity: 0, y: 5 }}
            className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 w-max max-w-xs bg-ink text-paper text-xs px-2 py-1.5 rounded shadow-lg z-50 pointer-events-none"
          >
            {text}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
"""

if "function Tooltip" not in content:
    content = content.replace("const CUSTOM_INSTRUCTIONS_MAX = 2000", tooltip_code + "\\nconst CUSTOM_INSTRUCTIONS_MAX = 2000")

# 2. Add focus states
content = content.replace("focus:ring-1 focus:ring-accent", "focus-visible:ring-2 focus-visible:ring-accent outline-none")
content = content.replace("className=\\"fa-press neo-raised rounded-lg bg-accent px-3 py-2 text-sm font-medium text-ink-inverse hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40\\"", "className=\\"fa-press neo-raised rounded-lg bg-accent px-3 py-2 text-sm font-medium text-ink-inverse hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-accent outline-none disabled:cursor-not-allowed disabled:opacity-40\\"")
content = content.replace("className={`neo-raised flex flex-col items-start gap-0.5 rounded-xl px-3.5 py-3 text-left transition-colors ${", "className={`neo-raised flex flex-col items-start gap-0.5 rounded-xl px-3.5 py-3 text-left transition-colors focus-visible:ring-2 focus-visible:ring-accent outline-none ${")

# 3. Apply tooltips to DesignSkinSection
if "text-2xs text-ink-muted" in content and "Tooltip" in tooltip_code:
    content = content.replace(
        '<span className="text-2xs text-ink-muted">{opt.hint}</span>',
        '<Tooltip text={opt.hint}><span className="text-2xs text-ink-muted flex items-center gap-1 cursor-help underline decoration-dotted">{opt.hint.split(",")[0]}</span></Tooltip>'
    )

# 4. Optimistic UI for CustomInstructions
optimistic_save = """
  const save = async () => {
    setSaving(true)
    const previousSaved = saved
    setSaved(text) // Optimistic update
    try {
      await api.updateMe({ customInstructions: text })
      toast.success('Saved')
      onSaved?.()
    } catch (err) {
      setSaved(previousSaved) // Rollback
      toast.apiError('Could not save your instructions', err)
    } finally {
      setSaving(false)
    }
  }
"""
content = content.replace("""  const save = async () => {
    setSaving(true)
    try {
      await api.updateMe({ customInstructions: text })
      setSaved(text)
      toast.success('Saved')
      onSaved?.()
    } catch (err) {
      toast.apiError('Could not save your instructions', err)
    } finally {
      setSaving(false)
    }
  }""", optimistic_save)

with open(file_path, "w") as f:
    f.write(content)

print("SettingsPage updated.")
