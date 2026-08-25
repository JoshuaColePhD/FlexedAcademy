import re

with open('frontend/src/pages/SettingsPage.jsx', 'r') as f:
    text = f.read()

# Fix the regex
text = text.replace("new RegExp(`\[${tag}: (.*?)\]`, 'i')", "new RegExp(`\\\\[${tag}: (.*?)\\\\]`, 'i')")

# Replace the Slider component entirely
old_slider = """  const Slider = ({ title, description, tag, options, currentValue }) => {
    const currentIndex = options.indexOf(currentValue)
    const val = currentIndex !== -1 ? currentIndex : Math.floor((options.length - 1) / 2)
    return (
      <div className="mt-5">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        <p className="mt-1 text-xs text-ink-muted">{description}</p>
        <div className="mt-6 px-2 max-w-xl">
          <input 
            type="range" 
            min="0" 
            max={options.length - 1} 
            step="1"
            value={val}
            onChange={(e) => handleSelect(tag, options[parseInt(e.target.value, 10)])}
            disabled={saving}
            className="w-full h-1.5 bg-edge rounded-lg appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-accent"
            style={{ accentColor: 'rgb(var(--accent-rgb))' }}
          />
          <div className="flex justify-between mt-3 gap-2">
            {options.map((opt, i) => (
              <button
                key={opt}
                type="button"
                onClick={() => handleSelect(tag, opt)}
                disabled={saving}
                aria-pressed={i === val}
                className={`neo-raised flex-1 py-1.5 text-center text-xs font-medium rounded-lg transition-colors focus-visible:ring-2 focus-visible:ring-accent outline-none ${
                  i === val ? 'neo-inset text-accent-text' : 'text-ink-soft hover:bg-paper-sunken'
                }`}
              >
                {opt}
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }"""

new_slider = """  const Slider = ({ title, description, tag, options, currentValue }) => {
    const currentIndex = options.indexOf(currentValue)
    const val = currentIndex !== -1 ? currentIndex : Math.floor((options.length - 1) / 2)
    return (
      <div className="mt-5">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        <p className="mt-1 text-xs text-ink-muted">{description}</p>
        <div className="mt-4 max-w-xl">
          <div className="relative flex neo-inset rounded-xl p-1 bg-paper-sunken items-center">
            <div 
              className="absolute top-1 bottom-1 neo-raised bg-paper rounded-lg transition-all duration-300 ease-out pointer-events-none"
              style={{
                width: `calc(${100 / options.length}% - 8px)`,
                left: `calc(${(val * 100) / options.length}% + 4px)`,
              }}
            />
            {options.map((opt, i) => (
              <button
                key={opt}
                type="button"
                onClick={() => handleSelect(tag, opt)}
                disabled={saving}
                aria-pressed={i === val}
                className={`relative flex-1 py-2 text-center text-xs font-medium rounded-lg transition-colors focus-visible:ring-2 focus-visible:ring-accent outline-none ${
                  i === val ? 'text-accent-text' : 'text-ink-muted hover:text-ink-soft'
                }`}
              >
                {opt}
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }"""

text = text.replace(old_slider, new_slider)

with open('frontend/src/pages/SettingsPage.jsx', 'w') as f:
    f.write(text)

