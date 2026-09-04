import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronsUpDown } from 'lucide-react'
import { findFramework, gradeRangeLabel, groupFrameworks, matchesFramework } from '../lib/frameworks'
import { useExitTransition } from '../hooks/useExitTransition'

function PickerPortal({ enabled, children }) {
  return enabled ? createPortal(children, document.body) : children
}

export function FrameworkPicker({ frameworks, value, onChange, disabled, id, variant = 'popover', beforeInput, afterInput, onQueryChange, emptyMessage, constrainPopover = false }) {
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
    const filtered = (frameworks || []).filter((f) => matchesFramework(f, query))
    return groupFrameworks(filtered)
  }, [frameworks, query])

  // One flat list behind the grouped display, so arrow keys walk the options
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups])

  useEffect(() => setActive(0), [query])
  useEffect(() => setActiveGroup(groups[0]?.name ?? null), [groups])

  // A picker inside a short onboarding step can otherwise render a tall
  // dropdown into the shell's scroll boundary, leaving the course options
  // visibly cut off. Keep the popover inside the available space below its
  // trigger and let the list scroll within that space.
  useLayoutEffect(() => {
    if (!constrainPopover || isInline || !open) {
      setPopoverMaxHeight(null)
      setPopoverPosition(null)
      return undefined
    }
    const updatePopover = () => {
      const rootRect = rootRef.current?.getBoundingClientRect()
      if (!rootRect) return
      const width = Math.min(34 * 16, window.innerWidth - 32)
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
  }, [constrainPopover, isInline, open])

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

  return (
    <div className={`fw-picker relative w-full${isInline ? ' flex min-h-0 flex-1 flex-col gap-3' : ''}`} ref={rootRef}>
      <div className={isInline && (beforeInput || afterInput) ? 'flex items-center gap-3' : undefined}>
        {isInline ? beforeInput : null}
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
              // Popover: refocusing means "reopening," which should start
              // from a blank search same as the first open. Inline never
              // closed in the first place — clicking back into a search box
              // that's been visible the whole time shouldn't silently wipe
              // whatever was already typed into it.
              if (!isInline) setQuery('')
              setActive(0)
            }}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
              if (!open) setOpen(true)
              onQueryChange?.(e.target.value)
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
        {isInline ? afterInput : null}
      </div>

      {(isInline || mounted) ? (
        <PickerPortal enabled={constrainPopover && Boolean(popoverPosition) && !isInline}>
          <div
            ref={constrainPopover && !isInline ? panelRef : undefined}
            className={
              isInline
                ? 'fw-picker-panel neo-panel flex min-h-0 w-full flex-1 overflow-hidden rounded-2xl border border-edge bg-paper-raised'
                : `fw-picker-panel neo-panel fa-card-drop absolute left-0 z-50 mt-1 flex overflow-hidden rounded-2xl bg-paper-raised${closing ? ' fa-chip-exit' : ''}`
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
            }}
          >
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
              className={`fw-picker-rail hidden ${isInline ? 'w-56' : 'w-40'} shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-edge/60 bg-paper-sunken/60 p-2 sm:flex${isInline ? ' h-full' : ''}`}
              style={isInline ? undefined : { maxHeight: popoverMaxHeight || 'min(28rem, 70vh)' }}
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
            style={isInline ? undefined : { maxHeight: popoverMaxHeight || 'min(28rem, 70vh)' }}
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
                            id={`${listId}-${fw.id}`}
                            aria-selected={isSelected}
                            disabled={disabled}
                            tabIndex={-1}
                            data-active={isActive}
                    className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors ${
                      isActive ? 'onboarding-course-active bg-paper-sunken text-ink' : 'hover:bg-paper-sunken'
                    }${isSelected ? ' onboarding-course-selected' : ''}`}
                            onFocus={() => setActive(i)}
                            onKeyDown={onKeyDown}
                            onMouseEnter={() => setActive(i)}
                            onClick={() => commit(fw)}
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm text-ink font-medium">{fw.label}</span>
                              {/* Grade range only — the standards count was a
                                  build-time implementation detail (how many
                                  chunks got ingested), not something a
                                  teacher deciding "is this my course" needs
                                  to see. gradeRangeLabel is the fact that
                                  actually tells a K-2 teacher apart from an
                                  AP one at a glance. */}
                              {gradeRangeLabel(fw) ? (
                                <span className="block text-[11px] text-ink-muted">{gradeRangeLabel(fw)}</span>
                              ) : null}
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
        </PickerPortal>
      ) : null}
    </div>
  )
}
