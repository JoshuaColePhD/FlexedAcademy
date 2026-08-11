import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import { findFramework, groupFrameworks, matchesFramework, verifiedPct } from '../lib/frameworks'

/* A searchable, grouped picker for the 72 ingested standards frameworks.
 *
 * Replaces a flat <select>. Two things it does that the <select> could not:
 * group the eleven Alabama Course of Study frameworks above the sixty-odd
 * College Board ones, and show each framework's standard count — which is the
 * only way to tell "AP Language & Composition" (476) from the similarly-named
 * "AP English Language and Composition" (37) before you commit to one. */
export function FrameworkPicker({ frameworks, value, onChange, disabled, id }) {
  const [open, setOpen] = useState(false)
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

  // One flat list behind the grouped display, so arrow keys walk the options a
  // reader actually sees rather than the unfiltered source order.
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups])

  useEffect(() => setActive(0), [query])

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  useEffect(() => {
    if (open) inputRef.current?.focus()
    else setQuery('')
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
    }
  }

  return (
    <div className="relative w-full" ref={rootRef}>
      <button
        type="button"
        id={id}
        disabled={disabled}
        className="neo-inset flex w-full items-center justify-between gap-3 rounded-lg bg-paper-sunken px-3 py-2.5 text-left transition-shadow disabled:cursor-not-allowed disabled:opacity-50"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-ink">
            {selected?.label || value || 'Choose a framework'}
          </span>
          {selected ? (
            <span className="mt-0.5 block text-xs text-ink-muted">
              {selected.chunks.toLocaleString()} standards
              {verifiedPct(selected) !== null
                ? ` · ${verifiedPct(selected)}% verified against the source PDF`
                : ''}
            </span>
          ) : null}
        </span>
        <ChevronDown
          size={16}
          aria-hidden="true"
          className={`shrink-0 text-ink-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open ? (
        <div className="neo-panel absolute left-0 right-0 z-50 mt-1 overflow-hidden rounded-2xl bg-paper-raised">
          <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
            <Search size={15} aria-hidden="true" className="shrink-0 text-ink-muted" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search subjects — try “math”, “world lang”, “biology”"
              aria-label="Search standards frameworks"
              aria-controls={listId}
              className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-muted"
            />
          </div>

          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label="Standards frameworks"
            className="max-h-[19rem] overflow-y-auto py-1"
          >
            {flat.length === 0 ? (
              <li className="px-3 py-6 text-center text-sm text-ink-muted">
                No framework matches “{query}”.
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
                              isActive ? 'neo-inset bg-accent-tint text-accent-text' : 'hover:bg-paper-sunken'
                            }`}
                            onMouseEnter={() => setActive(i)}
                            onClick={() => commit(fw)}
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm text-ink">{fw.label}</span>
                              <span className="block text-xs text-ink-muted">
                                {fw.chunks.toLocaleString()} standards
                                {verifiedPct(fw) !== null && verifiedPct(fw) < 100
                                  ? ` · ${verifiedPct(fw)}% verified`
                                  : ''}
                              </span>
                            </span>
                            {isSelected ? (
                              <Check size={15} aria-hidden="true" className="shrink-0 text-accent-text" />
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
