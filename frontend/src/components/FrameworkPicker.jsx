import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { findFramework, groupFrameworks, matchesFramework, verifiedPct } from '../lib/frameworks'
import { useExitTransition } from '../hooks/useExitTransition'

export function FrameworkPicker({ frameworks, value, onChange, disabled, id, variant = 'popover' }) {
  // 'inline' is the full-page course browser (WelcomePage.jsx's /welcome) —
  // permanently visible, no dropdown to open. Every isInline branch below
  // falls through to the exact 'popover' code path when omitted, so the
  // other two callers (OnboardingWizard's ClassStep, ClassPage's Classroom
  // Profile) are byte-identical to before this existed.
  const isInline = variant === 'inline'
  const [open, setOpen] = useState(isInline)
  const { mounted, closing } = useExitTransition(open, 150)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  // Which group's header is topmost in the scrolled list right now — mirrors
  // an IDE settings panel (categories on the left, a tall scrollable list on
  // the right that the category rail tracks and jumps to), which is exactly
  // what a 72-item flat dropdown couldn't offer: 18rem of scroll and no way
  // to jump straight to "Science" without hunting past everything before it.
  const [activeGroup, setActiveGroup] = useState(null)
  const rootRef = useRef(null)
  const inputRef = useRef(null)
  const listRef = useRef(null)
  const groupRefs = useRef(new Map())
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
  useEffect(() => setActiveGroup(groups[0]?.name ?? null), [groups])

  // Tracks which group header is currently topmost in the scrollable list,
  // so the rail highlights where you actually are — the same "scrollspy"
  // behavior a settings sidebar gives you, rather than only updating on
  // click and going stale the moment someone scrolls by hand.
  useEffect(() => {
    if (!open || !listRef.current) return undefined
    const headers = groups
      .map((g) => groupRefs.current.get(g.name))
      .filter(Boolean)
    if (!headers.length) return undefined
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]) setActiveGroup(visible[0].target.dataset.group)
      },
      { root: listRef.current, threshold: 0, rootMargin: '0px 0px -85% 0px' },
    )
    headers.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [open, groups])

  const scrollToGroup = (name) => {
    setActiveGroup(name)
    groupRefs.current.get(name)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  useEffect(() => {
    if (isInline || !open) return undefined
    const onDown = (e) => {
      if (!rootRef.current?.contains(e.target)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [isInline, open])

  useEffect(() => {
    if (!open) return
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const commit = (fw) => {
    onChange(fw.id)
    // Inline never "closes" — there's no popover to dismiss, and the
    // scrollspy/active-scroll effects above are both keyed on `open`, so
    // flipping it false here would silently kill rail-highlighting for the
    // rest of the session the moment a teacher picked a course.
    if (!isInline) {
      setOpen(false)
      setQuery('')
      inputRef.current?.blur()
    }
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
    <div className={`fw-picker relative w-full${isInline ? ' flex min-h-0 flex-1 flex-col gap-3' : ''}`} ref={rootRef}>
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
          placeholder="Search courses — try “math”, “elementary”, “Pre-AP”..."
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          value={isInline ? query : (open ? query : (selected?.label || ''))}
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
        {!isInline ? (
          <ChevronsUpDown
            size={14}
            aria-hidden="true"
            className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-faint"
          />
        ) : null}
      </div>

      {(isInline || mounted) ? (
        <div
          className={
            isInline
              ? 'fw-picker-panel neo-panel flex min-h-0 w-full flex-1 overflow-hidden rounded-2xl border border-edge bg-paper-raised'
              : `fw-picker-panel neo-panel fa-card-drop absolute left-0 z-50 mt-1 flex overflow-hidden rounded-2xl bg-paper-raised${closing ? ' fa-chip-exit' : ''}`
          }
          style={isInline ? undefined : { width: 'min(34rem, calc(100vw - 2rem))', maxWidth: 'calc(100vw - 2rem)' }}
        >
          {/* Category rail — desktop only. A phone-width dropdown has no room
              for a second column, so it falls back to the plain scrolling
              list (still grouped, just without the jump-to-category rail). */}
          {groups.length > 1 ? (
            <div
              className={`fw-picker-rail hidden ${isInline ? 'w-56' : 'w-40'} shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-edge/60 bg-paper-sunken/60 p-2 sm:flex${isInline ? ' h-full' : ''}`}
              style={isInline ? undefined : { maxHeight: 'min(28rem, 70vh)' }}
            >
              {groups.map((g) => (
                <button
                  key={g.name}
                  type="button"
                  onClick={() => scrollToGroup(g.name)}
                  className={`flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium transition-colors ${
                    activeGroup === g.name ? 'neo-inset bg-paper text-ink' : 'text-ink-muted hover:bg-paper hover:text-ink'
                  }`}
                >
                  <span className="truncate">{g.name}</span>
                  <span className="shrink-0 text-[10px] text-ink-faint">{g.items.length}</span>
                </button>
              ))}
            </div>
          ) : null}

          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label="Standards frameworks"
            className={`min-w-0 flex-1 overflow-y-auto py-1${isInline ? ' h-full' : ''}`}
            style={isInline ? undefined : { maxHeight: 'min(28rem, 70vh)' }}
          >
            {flat.length === 0 ? (
              <li className="px-3 py-6 text-center text-sm text-ink-muted">
                No course matches “{query}”.
              </li>
            ) : (
              groups.map((g) => (
                <li key={g.name} role="presentation">
                  <p
                    ref={(el) => {
                      if (el) groupRefs.current.set(g.name, el)
                      else groupRefs.current.delete(g.name)
                    }}
                    data-group={g.name}
                    className="eyebrow sticky top-0 z-10 bg-paper-sunken px-3 py-1.5"
                  >
                    {g.name}
                  </p>
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
