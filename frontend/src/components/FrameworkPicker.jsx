import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronsUpDown, X } from 'lucide-react'
import { findFramework, gradeRangeLabel, groupFrameworks, matchesFramework } from '../lib/frameworks'
import { useExitTransition } from '../hooks/useExitTransition'

function PickerPortal({ enabled, children }) {
  return enabled ? createPortal(children, document.body) : children
}

export function FrameworkPicker({ frameworks, value, onChange, disabled, id, variant = 'popover', beforeInput, afterInput, onQueryChange, emptyMessage, constrainPopover = false, expandPopover = false, gradeFilter, onGradeFilterChange, gradeOptions = [] }) {
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
  const [popoverMaxHeight, setPopoverMaxHeight] = useState(null)
  const [popoverPosition, setPopoverPosition] = useState(null)
  const rootRef = useRef(null)
  const panelRef = useRef(null)
  const inputRef = useRef(null)
  const listRef = useRef(null)
  const groupRefs = useRef(new Map())
  const autoId = useId()
  const listId = `${id || autoId}-listbox`

  const selected = findFramework(frameworks, value)

  const groups = useMemo(() => {
    const filtered = (frameworks || []).filter((f) => (
      (gradeFilter === undefined || gradeFilter === '' || f.grades?.includes(Number(gradeFilter)))
      && matchesFramework(f, query)
    ))
    return groupFrameworks(filtered)
  }, [frameworks, gradeFilter, query])

  // One flat list behind the grouped display, so arrow keys walk the options
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups])

  useEffect(() => setActive(0), [query])
  useEffect(() => setActiveGroup(groups[0]?.name ?? null), [groups])

  // A picker inside a short onboarding step can otherwise render a tall
  // dropdown into the shell's scroll boundary, leaving the course options
  // visibly cut off. Keep the popover inside the available space below its
  // trigger and let the list scroll within that space.
  useLayoutEffect(() => {
    if ((!constrainPopover && !expandPopover) || isInline || !open) {
      setPopoverMaxHeight(null)
      setPopoverPosition(null)
      return undefined
    }
    const updatePopover = () => {
      const rootRect = rootRef.current?.getBoundingClientRect()
      if (!rootRect) return
      const surfaceRect = expandPopover
        ? rootRef.current?.closest('[data-course-picker-surface]')?.getBoundingClientRect()
        : null
      if (surfaceRect) {
        const pageRect = rootRef.current?.closest('.split-layout-shell')?.getBoundingClientRect()
        // Center the catalog against the whole page shell, including the
        // navigation rail, rather than either the right panel or form column.
        // Keep a small inset so the rounded edge reads cleanly at the page
        // boundaries while allowing the surface to span the full composition.
        const horizontalRect = pageRect || surfaceRect
        const width = Math.max(0, Math.min(horizontalRect.width - 16, window.innerWidth - 16))
        const top = Math.max(8, surfaceRect.top + 8)
        const left = Math.max(8, Math.min(
          horizontalRect.left + (horizontalRect.width - width) / 2,
          window.innerWidth - width - 8,
        ))
        // Give the page-level catalog a little more vertical room. If the
        // requested height would run below the viewport, lift it upward while
        // keeping the whole surface visible rather than cutting off results.
           const shellTop = pageRect?.top ?? 0
           const shellHeight = pageRect?.height ?? window.innerHeight
           const desiredHeight = Math.min(48 * 16, shellHeight - 16, window.innerHeight - 16)
           const shellBottom = Math.min(window.innerHeight, pageRect?.bottom ?? window.innerHeight)
           const fittedTop = Math.max(shellTop + 8, Math.min(top, shellBottom - desiredHeight - 8))
        const available = Math.max(18 * 16, desiredHeight)
        setPopoverPosition({ top: fittedTop, left, width })
        setPopoverMaxHeight(`${available}px`)
        return
      }
      const width = Math.min(44 * 16, window.innerWidth - 32)
      const left = Math.min(rootRect.left, window.innerWidth - width - 16)
      const top = rootRect.bottom + 4
      const available = Math.max(11 * 16, window.innerHeight - top - 16)
      setPopoverPosition({ top, left: Math.max(16, left), width })
      setPopoverMaxHeight(`${Math.min(28 * 16, available)}px`)
    }
    updatePopover()
    window.addEventListener('resize', updatePopover)
    window.addEventListener('scroll', updatePopover, true)
    return () => {
      window.removeEventListener('resize', updatePopover)
      window.removeEventListener('scroll', updatePopover, true)
    }
  }, [constrainPopover, expandPopover, isInline, open])

  useEffect(() => {
    if (!expandPopover || isInline || !open) return undefined
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [expandPopover, isInline, open])

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
    const list = listRef.current
    const group = groupRefs.current.get(name)
    if (!list || !group) return
    // scrollIntoView() is allowed to move every scrollable ancestor. In the
    // inline onboarding picker that included the wizard page itself, so a
    // category click could shift the whole card upward. Move only the list's
    // own scrollTop instead.
    const listRect = list.getBoundingClientRect()
    const groupRect = group.getBoundingClientRect()
    list.scrollTo({
      top: Math.max(0, list.scrollTop + groupRect.top - listRect.top),
      behavior: 'smooth',
    })
  }

  const keepActiveOptionVisible = (option) => {
    const list = listRef.current
    if (!list || !option) return
    const listRect = list.getBoundingClientRect()
    const optionRect = option.getBoundingClientRect()
    const topInset = 8
    const bottomInset = 8
    if (optionRect.top < listRect.top + topInset) {
      list.scrollBy({ top: optionRect.top - (listRect.top + topInset) })
    } else if (optionRect.bottom > listRect.bottom - bottomInset) {
      list.scrollBy({ top: optionRect.bottom - (listRect.bottom - bottomInset) })
    }
  }

  useEffect(() => {
    if (isInline || !open) return undefined
    const onDown = (e) => {
      if (!rootRef.current?.contains(e.target) && !panelRef.current?.contains(e.target)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [isInline, open])

  useEffect(() => {
    if (!open) return
    keepActiveOptionVisible(listRef.current?.querySelector('[data-active="true"]'))
  }, [active, open])

  const commit = (fw) => {
    if (disabled) return
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
    } else if (e.key === 'Home') {
      if (!open || !flat.length) return
      e.preventDefault()
      setActive(0)
    } else if (e.key === 'End') {
      if (!open || !flat.length) return
      e.preventDefault()
      setActive(flat.length - 1)
    } else if (e.key === 'Escape') {
      if (!open) return
      e.preventDefault()
      setOpen(false)
      setQuery('')
    }
  }

  const inputNode = (
    <div className="relative flex-1">
      <input
        ref={inputRef}
        type="text"
        id={id}
        disabled={disabled}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && flat[active] ? `${listId}-${flat[active].id}` : undefined}
        aria-autocomplete="list"
        placeholder="Search courses — try “math”, “elementary”, “Pre-AP”..."
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        value={isInline ? query : (open ? query : (selected?.label || ''))}
        onFocus={() => {
          setOpen(true)
          // Popover: refocusing means “reopening,” which should start from a
          // blank search. The expanded search is already open when it mounts,
          // so moving focus into it must not erase the teacher's query.
          if (!isInline && !open) setQuery('')
          setActive(0)
        }}
        onChange={(e) => {
          setQuery(e.target.value)
          setActive(0)
          if (!open) setOpen(true)
          onQueryChange?.(e.target.value)
        }}
        onKeyDown={onKeyDown}
        className="neo-inset flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-edge bg-paper-raised py-2.5 pl-3 pr-8 text-sm text-ink placeholder:text-ink-muted outline-none transition-[border-color,box-shadow] focus:border-accent focus:ring-1 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
      />
      {!isInline ? (
        <ChevronsUpDown
          size={14}
          aria-hidden="true"
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-muted"
        />
      ) : null}
    </div>
  )

  return (
    <div className={`fw-picker relative w-full${isInline ? ' flex min-h-0 flex-1 flex-col gap-3' : ''}`} ref={rootRef}>
      {!expandPopover || !open ? (
        <div className={isInline && (beforeInput || afterInput) ? 'flex items-center gap-3' : undefined}>
          {isInline ? beforeInput : null}
          {inputNode}
          {isInline ? afterInput : null}
        </div>
      ) : null}

      {(isInline || mounted) ? (
        <PickerPortal enabled={constrainPopover && Boolean(popoverPosition) && !isInline}>
          <div
            ref={constrainPopover && !isInline ? panelRef : undefined}
            className={
              isInline
                ? 'fw-picker-panel neo-panel flex min-h-0 w-full flex-1 overflow-hidden rounded-2xl border border-edge bg-paper-raised'
                : `fw-picker-panel fw-picker-popover${expandPopover ? ' fw-picker-popover-expanded' : ''} neo-panel fa-card-drop absolute left-0 z-50 mt-1 flex flex-col overflow-hidden rounded-2xl bg-paper-raised${closing ? ' fa-chip-exit' : ''}`
            }
            style={isInline ? undefined : {
              ...(popoverPosition ? {
                position: 'fixed',
                top: popoverPosition.top,
                left: popoverPosition.left,
                width: popoverPosition.width,
              } : {
                width: 'min(34rem, calc(100vw - 2rem))',
                maxWidth: 'calc(100vw - 2rem)',
              }),
              ...(popoverMaxHeight ? { maxHeight: popoverMaxHeight } : {}),
              ...((constrainPopover || expandPopover) && popoverMaxHeight ? { height: popoverMaxHeight } : {}),
            }}
          >
          {!isInline ? (
            <div className={`fw-picker-popover-header relative flex shrink-0 items-center justify-between gap-4 border-b border-edge px-4 py-3${expandPopover ? ' flex-col items-stretch gap-3 pr-12 sm:grid sm:grid-cols-[auto,minmax(0,1fr),minmax(0,1fr)] sm:items-center' : ''}`}>
              {expandPopover ? (
                <select
                  value={gradeFilter ?? ''}
                  onChange={(event) => onGradeFilterChange?.(event.target.value)}
                  aria-label="Filter courses by grade"
                  className="neo-select neo-inset min-h-11 w-full shrink-0 rounded-lg border border-edge bg-paper-raised py-2.5 pl-3 pr-8 text-sm text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent sm:w-32"
                >
                  <option value="">All grades</option>
                  {gradeOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              ) : null}
              {expandPopover ? (
                <div className="w-full min-w-0 sm:max-w-xl sm:justify-self-center sm:translate-x-8">
                  {inputNode}
                </div>
              ) : null}
              <div className={expandPopover ? 'min-w-0 flex-1 text-center' : 'min-w-0 shrink-0'}>
                <p className="text-sm font-semibold text-ink">Browse courses</p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  {flat.length === 1 ? '1 course matches' : `${flat.length} courses match`}
                </p>
              </div>
              {expandPopover ? (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false)
                    setQuery('')
                    inputRef.current?.blur()
                  }}
                  aria-label="Close course browser"
                  className="absolute right-3 top-3 inline-flex h-11 w-11 translate-y-0 shrink-0 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-paper-inset hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:top-1/2 sm:h-8 sm:w-8 sm:-translate-y-1/2"
                >
                  <X size={16} aria-hidden="true" />
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* Category rail — desktop only. A phone-width dropdown has no room
              for a second column, so it falls back to the plain scrolling
              list (still grouped, just without the jump-to-category rail). */}
          {/* Inline onboarding keeps its category rail even for one visible
              group. Grade filtering can temporarily reduce the catalog to a
              single subject; hiding the entire left pane in that state made
              the full course browser collapse into a plain list and broke the
              split-panel shape halfway through the same task. The one-item
              rail still tells the teacher what catalog they are browsing, and
              it expands naturally when another grade or search reveals more
              groups. Popovers stay compact and retain the old >1 rule. */}
          {(isInline ? groups.length > 0 : groups.length > 1) ? (
            <div
              className={`fw-picker-rail hidden ${isInline ? 'w-56' : 'w-48'} shrink-0 flex-col gap-1 overflow-y-auto border-r border-edge/60 bg-paper-sunken/60 p-3 sm:flex${isInline ? ' h-full' : ''}`}
              style={isInline ? undefined : { maxHeight: constrainPopover ? undefined : (popoverMaxHeight || 'min(28rem, 70vh)') }}
            >
              {groups.map((g) => (
                <button
                  key={g.name}
                  type="button"
                  onClick={() => scrollToGroup(g.name)}
                  className={`onboarding-course-category flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium transition-colors ${
                    activeGroup === g.name ? 'neo-inset bg-paper text-ink' : 'text-ink-muted hover:bg-paper hover:text-ink'
                  }${activeGroup === g.name ? ' onboarding-course-category-active' : ''}`}
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
            style={isInline ? undefined : { maxHeight: constrainPopover ? undefined : (popoverMaxHeight || 'min(28rem, 70vh)') }}
          >
            {flat.length === 0 ? (
              <li className="px-3 py-6 text-center text-sm text-ink-muted">
                {emptyMessage || `No course matches “${query}”.`}
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
                    className="fw-picker-group-heading eyebrow sticky top-0 z-10 bg-paper-sunken px-4 py-2"
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
                            id={`${listId}-${fw.id}`}
                            aria-selected={isSelected}
                            disabled={disabled}
                            tabIndex={-1}
                            data-active={isActive}
                            className={`fw-picker-option flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                              isActive ? 'onboarding-course-active bg-paper-sunken text-ink' : 'hover:bg-paper-sunken'
                            }${isSelected ? ' onboarding-course-selected' : ''}`}
                            onFocus={() => setActive(i)}
                            onKeyDown={onKeyDown}
                            onMouseEnter={() => setActive(i)}
                            onClick={() => commit(fw)}
                          >
                            <span className="min-w-0 flex-1">
                              <span className="fw-picker-option-label block truncate text-sm text-ink font-medium">{fw.label}</span>
                              {/* Grade range only — the standards count was a
                                  build-time implementation detail (how many
                                  chunks got ingested), not something a
                                  teacher deciding "is this my course" needs
                                  to see. gradeRangeLabel is the fact that
                                  actually tells a K-2 teacher apart from an
                                  AP one at a glance. */}
                              {gradeRangeLabel(fw) ? (
                                <span className="fw-picker-option-meta block text-[11px] text-ink-muted">{gradeRangeLabel(fw)}</span>
                              ) : null}
                            </span>
                            {isSelected ? (
                              <span className="fw-picker-option-check flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent-text">
                                <Check size={14} aria-hidden="true" />
                              </span>
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
          </div>
        </PickerPortal>
      ) : null}
    </div>
  )
}
