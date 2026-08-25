import re

with open('frontend/src/pages/SettingsPage.jsx', 'r') as f:
    content = f.read()

# I will add a DetailPreferenceSection component.
detail_component = """
function ResponseDetailToggle({ value, onSaved }) {
  const toast = useToast()
  const [saving, setSaving] = useState(false)
  
  // Parse current detail level from custom instructions
  const detailMatch = (value || '').match(/\\n\\n\\[Response Detail: (Concise|Standard|Detailed)\\]/i)
  const currentDetail = detailMatch ? detailMatch[1] : 'Standard'
  
  const OPTIONS = [
    { value: 'Concise', label: 'Concise', hint: 'Short, direct responses without fluff' },
    { value: 'Standard', label: 'Standard', hint: 'Balanced level of detail' },
    { value: 'Detailed', label: 'Detailed', hint: 'Highly thorough, comprehensive responses' }
  ]
  
  const handleSelect = async (level) => {
    if (level === currentDetail) return
    setSaving(true)
    
    // Remove existing detail tag
    let newInstructions = (value || '').replace(/\\n\\n\\[Response Detail: (Concise|Standard|Detailed)\\]/gi, '').trim()
    
    // Add new detail tag if not Standard
    if (level !== 'Standard') {
        newInstructions += `\\n\\n[Response Detail: ${level}]`
        if (level === 'Concise') {
            newInstructions += ' Keep responses extremely concise and to the point.'
        } else if (level === 'Detailed') {
            newInstructions += ' Provide highly detailed, thorough, and comprehensive responses.'
        }
    }
    
    try {
      await api.updateMe({ customInstructions: newInstructions })
      toast.success(`Detail level set to ${level}`)
      onSaved?.()
    } catch (err) {
      toast.apiError('Could not save preference', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-5">
      <h2 className="text-sm font-semibold text-ink">Response Detail</h2>
      <p className="mt-1 text-xs text-ink-muted">
        How thorough you want the AI's responses to be in chat and planning.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => handleSelect(opt.value)}
            disabled={saving}
            aria-pressed={currentDetail === opt.value}
            className={`neo-raised flex flex-col items-start gap-0.5 rounded-xl px-3.5 py-3 text-left transition-colors focus-visible:ring-2 focus-visible:ring-accent outline-none ${
              currentDetail === opt.value ? 'neo-inset text-accent-text' : 'text-ink-soft'
            }`}
          >
            <span className="text-sm font-medium">{opt.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
"""

content = content.replace("function CustomInstructions", detail_component + "\nfunction CustomInstructions")

# Add the new component to the SettingsPage render
render_target = "<CustomInstructions value={me?.custom_instructions} onSaved={mutate} />"
content = content.replace(render_target, "<ResponseDetailToggle value={me?.custom_instructions} onSaved={mutate} />\n          " + render_target)

with open('frontend/src/pages/SettingsPage.jsx', 'w') as f:
    f.write(content)

