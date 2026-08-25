import re

with open('frontend/src/pages/SettingsPage.jsx', 'r') as f:
    content = f.read()

# Replace ResponseDetailToggle definition
new_comp = """function AiGenerationPreferences({ value, onSaved }) {
  const toast = useToast()
  const [saving, setSaving] = useState(false)

  const getLevel = (tag, defaultLevel) => {
    const regex = new RegExp(`\\\\[${tag}: (.*?)\\\\]`, 'i')
    const match = (value || '').match(regex)
    return match ? match[1] : defaultLevel
  }

  const length = getLevel('Response Length', 'Medium')
  const detail = getLevel('Level of Detail', 'Standard')
  const examples = getLevel('Specific Examples', 'Some')

  const handleSelect = async (tag, level) => {
    setSaving(true)
    
    let baseInstructions = (value || '')
      .replace(/\\[Response Length: .*?\\].*?\\n?/g, '')
      .replace(/\\[Level of Detail: .*?\\].*?\\n?/g, '')
      .replace(/\\[Specific Examples: .*?\\].*?\\n?/g, '')
      .replace(/\\[NOTE: These preferences only apply to the narrative.*?\\].*?\\n?/g, '')
      .trim()
      
    const activeTags = []
    
    const newLength = tag === 'Response Length' ? level : length
    const newDetail = tag === 'Level of Detail' ? level : detail
    const newExamples = tag === 'Specific Examples' ? level : examples

    if (newLength !== 'Medium') {
      activeTags.push(`[Response Length: ${newLength}] ${newLength === 'Short' ? 'Keep responses brief and to the point.' : 'Provide extended, comprehensive answers.'}`)
    }
    if (newDetail !== 'Standard') {
      activeTags.push(`[Level of Detail: ${newDetail}] ${newDetail === 'Concise' ? 'Focus strictly on the main points without extra fluff.' : 'Break down concepts thoroughly and exhaustively.'}`)
    }
    if (newExamples !== 'Some') {
      activeTags.push(`[Specific Examples: ${newExamples}] ${newExamples === 'Few' ? 'Use examples only when strictly necessary.' : 'Use abundant, specific, real-world examples.'}`)
    }
    
    if (activeTags.length > 0) {
      activeTags.push(`[NOTE: These preferences only apply to the narrative lesson plan and activities. Do NOT alter or abbreviate the text of the academic standards themselves.]`)
      baseInstructions += (baseInstructions ? '\\n\\n' : '') + activeTags.join('\\n')
    }

    try {
      await api.updateMe({ customInstructions: baseInstructions })
      toast.success(`Updated ${tag}`)
      onSaved?.()
    } catch (err) {
      toast.apiError('Could not save preference', err)
    } finally {
      setSaving(false)
    }
  }

  const Slider = ({ title, description, tag, options, currentValue }) => (
    <div className="mt-5">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <p className="mt-1 text-xs text-ink-muted">{description}</p>
      <div className="mt-2 flex gap-2">
        {options.map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => handleSelect(tag, opt)}
            disabled={saving}
            aria-pressed={currentValue === opt}
            className={`neo-raised flex-1 py-2 text-center text-sm font-medium rounded-lg transition-colors focus-visible:ring-2 focus-visible:ring-accent outline-none ${
              currentValue === opt ? 'neo-inset text-accent-text' : 'text-ink-soft hover:bg-paper-sunken'
            }`}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  )

  return (
    <div className="mt-6 border-t border-edge pt-4">
      <h2 className="text-sm font-semibold text-ink">AI Generation Criteria</h2>
      <p className="mt-1 text-xs text-ink-muted">Control the length, detail, and tone of the AI's outputs.</p>
      <Slider 
        title="Response Length" 
        description="How long the AI's generated narratives and plans should be."
        tag="Response Length"
        options={['Short', 'Medium', 'Long']}
        currentValue={length}
      />
      <Slider 
        title="Level of Detail" 
        description="How thoroughly concepts and activities are broken down."
        tag="Level of Detail"
        options={['Concise', 'Standard', 'Exhaustive']}
        currentValue={detail}
      />
      <Slider 
        title="Specific Examples" 
        description="How often the AI should invent specific, real-world examples."
        tag="Specific Examples"
        options={['Few', 'Some', 'Many']}
        currentValue={examples}
      />
    </div>
  )
}
"""

content = re.sub(r'function ResponseDetailToggle.*?(?=\nfunction CustomInstructions)', new_comp + "\n", content, flags=re.DOTALL)

# Insert the component invocation under CustomInstructions
invocation = """                <CustomInstructions
                  value={meState.data?.custom_instructions}
                  onSaved={() => qc.invalidateQueries({ queryKey: qk.me })}
                />
                
                <AiGenerationPreferences
                  value={meState.data?.custom_instructions}
                  onSaved={() => qc.invalidateQueries({ queryKey: qk.me })}
                />"""

content = re.sub(r'<CustomInstructions[^>]+/>', invocation, content)

with open('frontend/src/pages/SettingsPage.jsx', 'w') as f:
    f.write(content)

print("Done")
