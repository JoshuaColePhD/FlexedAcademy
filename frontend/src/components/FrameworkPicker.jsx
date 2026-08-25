import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { findFramework, groupFrameworks, matchesFramework, verifiedPct } from '../lib/frameworks'
import { useExitTransition } from '../hooks/useExitTransition'

export function FrameworkPicker({ frameworks, value, onChange, disabled, id }) {
  const [open, setOpen] = useState(false)
  const { mounted, closing } = useExitTransition(open, 150)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const rootRef = useRef(null)
  const inputRef = useRef(null)
  const listRef = useRef(null)
  const autoId = useId()
  const listId = `${id || autoId}-listbox`

  const selected = findFramework(frameworks, value)

  const groups = useMemo(() => {
    const filtered = (frameworks || []).filter((f) => matchesFramework(f, query))
    return groupFrameworks(filtered)
  }, [frameworks, query])

  // One flat list behind the grouped display, so arrow keys walk the options
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups])

  useEffect(() => setActive(0), [query])

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      if (!rootRef.current?.contains(e.target)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  useEffect(() => {
    if (!open) return
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const commit = (fw) => {
    onChange(fw.id)
    setOpen(false)
    setQuery('')
    inputRef.current?.blur()
  }

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) return setOpen(true)
      setActive((i) => Math.min(i + 1, flat.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      if (!open) return
      e.preventDefault()
      if (flat[active]) commit(flat[active])
    } else if (e.key === 'Escape') {
      if (!open) return
      e.preventDefault()
      setOpen(false)
      setQuery('')
    }
  }

  return (
    <div className="relative w-full" ref={rootRef}>
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          id={id}
          disabled={disabled}
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-autocomplete="list"
          placeholder="Search courses — try “math”, “biology”, “Pre-AP”..."
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          value={open ? query : (selected?.label || '')}
          onFocus={() => {
            setOpen(true)
            setQuery('')
            setActive(0)
          }}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
            if (!open) setOpen(true)
          }}
          onKeyDown={onKeyDown}
          className="neo-inset flex w-full items-center justify-between gap-3 rounded-lg bg-paper-sunken py-2.5 pl-3 pr-8 text-sm text-ink placeholder:text-ink-faint outline-none transition-shadow disabled:cursor-not-allowed disabled:opacity-50"
        />
        <ChevronsUpDown
          size={14}
          aria-hidden="true"
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-faint"
        />
      </div>

      {mounted ? (
        <div
          className={`neo-panel fa-card-drop absolute left-0 right-0 z-50 mt-1 overflow-hidden rounded-2xl bg-paper-raised${closing ? ' fa-chip-exit' : ''}`}
        >
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label="Standards frameworks"
            className="max-h-72 overflow-y-auto py-1"
          >
            {flat.length === 0 ? (
              <li className="px-3 py-6 text-center text-sm text-ink-muted">
                No course matches “{query}”.
              </li>
            ) : (
              groups.map((g) => (
                <li key={g.name} role="presentation">
                  <p className="eyebrow sticky top-0 z-10 bg-paper-sunken px-3 py-1.5">{g.name}</p>
                  <ul role="presentation">
                    {g.items.map((fw) => {
                      const i = flat.indexOf(fw)
                      const isActive = i === active
                      const isSelected = fw.id === value
                      return (
                        <li key={fw.id} role="presentation">
                          <button
                            type="button"
                            role="option"
                            aria-selected={isSelected}
                            data-active={isActive}
                            className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors ${
                              isActive ? 'neo-inset bg-paper text-ink' : 'hover:bg-paper-sunken'
                            }`}
                            onMouseEnter={() => setActive(i)}
                            onClick={() => commit(fw)}
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm text-ink font-medium">{fw.label}</span>
                              <span className="block text-[11px] text-ink-muted">
                                {fw.chunks.toLocaleString()} standards
                                {verifiedPct(fw) !== null && verifiedPct(fw) < 100
                                  ? ` · ${verifiedPct(fw)}% verified`
                                  : ''}
                              </span>
                            </span>
                            {isSelected ? (
                              <Check size={14} aria-hidden="true" className="shrink-0 text-accent-text" />
                            ) : null}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
