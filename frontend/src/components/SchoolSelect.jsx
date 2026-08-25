import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { useExitTransition } from '../hooks/useExitTransition'

/* A searchable stand-in for `<select>` on the school picker — same job
 * (choose one row from the `schools` table), but a plain native select
 * stopped being usable the moment that table grew from one hand-picked row
 * to every public high school in Alabama (~300+): typing only jumped to the
 * first option starting with that letter, and scrolling that many <option>s
 * by hand is its own kind of broken.
 *
 * Filters by substring against each school's name as you type, shows up to
 * MAX_RESULTS at a time (not the whole list re-rendered), and "My school
 * isn't listed yet" always stays reachable at the bottom of the results —
 * the same "always available, not gated behind the list" contract the three
 * plain `<select>`s this replaces already had.
 *
 * Popup shape/behavior mirrors ClassSwitcher.jsx (click-outside + Escape to
 * close, `useExitTransition` for a real exit animation, `neo-panel` +
 * `role=listbox`/`role=option`) — this app's one existing custom dropdown,
 * so the two read as the same kind of control rather than two different
 * ones bolted on separately.
 */
const MAX_RESULTS = 8

export function SchoolSelect({
  id,
  ariaLabel,
  schools,
  value,
  onChange,
  genericLabel = "My school isn't listed yet",
  genericValue = 'generic',
  emptyOption = null,
  disabled = false,
  className = '',
  inputClassName = '',
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const { mounted, closing } = useExitTransition(open, 150)
  const ref = useRef(null)
  const inputRef = useRef(null)

  const selected = schools.find((s) => s.id === value) || null
  const selectedLabel = selected
    ? selected.name
    : value === genericValue
      ? genericLabel
      : emptyOption && value === emptyOption.value
        ? emptyOption.label
        : ''

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    
    const getScore = (school) => {
      const name = school.name.toLowerCase()
      let score = 0
      
      if (!q) {
        // No query: prioritize active schools
        score += school.has_calendar ? 100 : school.has_pending_calendar ? 50 : 0
        return score
      }

      if (!name.includes(q)) return -1 // Doesn't match

      // Exact match gets highest score
      if (name === q) score += 1000
      // Prefix match gets high score
      else if (name.startsWith(q)) score += 500
      // Word boundary match
      else if (name.includes(` ${q}`)) score += 200
      // Normal substring
      else score += 10

      // Prioritize active schools among matches
      score += school.has_calendar ? 50 : school.has_pending_calendar ? 25 : 0

      return score
    }

    if (!q) {
      return [...schools].sort((a, b) => getScore(b) - getScore(a)).slice(0, MAX_RESULTS)
    }

    return schools
      .map((s) => ({ school: s, score: getScore(s) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS)
      .map((x) => x.school)
  }, [schools, query])

  const parseSchoolName = (name) => {
    let type = null
    let base = name
    if (name.includes('High School')) { type = 'High'; base = name.replace('High School', '').trim() }
    else if (name.includes('Middle School')) { type = 'Middle'; base = name.replace('Middle School', '').trim() }
    else if (name.includes('Elementary School')) { type = 'Elementary'; base = name.replace('Elementary School', '').trim() }
    else if (name.includes('Primary School')) { type = 'Primary'; base = name.replace('Primary School', '').trim() }
    else if (name.includes('Intermediate School')) { type = 'Intermediate'; base = name.replace('Intermediate School', '').trim() }
    return { base, type }
  }

  // The generic option matches "isn't listed" style queries too, not just an
  // empty query — typing "not listed" while searching should still surface it.
  const genericMatches = !query.trim() || genericLabel.toLowerCase().includes(query.trim().toLowerCase())

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      if (!ref.current?.contains(e.target)) close()
    }
    const onKey = (e) => e.key === 'Escape' && close()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const optionCount = filtered.length + (genericMatches ? 1 : 0)

  const close = () => {
    setOpen(false)
    setQuery('')
  }

  const choose = (nextValue) => {
    if (nextValue !== value) onChange(nextValue)
    close()
    inputRef.current?.blur()
  }

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) setOpen(true)
      setHighlight((i) => Math.min(i + 1, optionCount - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (highlight < filtered.length) choose(filtered[highlight].id)
      else if (genericMatches) choose(genericValue)
    }
  }

  return (
    <div className={`relative ${className}`} ref={ref}>
      <div className="relative">
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={id ? `${id}-listbox` : undefined}
          aria-autocomplete="list"
          aria-label={ariaLabel}
          disabled={disabled}
          placeholder="Search for your school…"
          // iOS Safari's QuickType bar can commit a predictive completion
          // (typing "Floren" then tapping the suggested "Florence") via a
          // native text-replacement path that doesn't fire a normal input
          // event in sync with React's controlled `value` — the DOM shows
          // the completed word a beat before `query` catches up, so the
          // filtered results below briefly (or, on some iOS versions,
          // permanently until another keystroke) match the OLD partial
          // text instead of what's visibly typed. This isn't a real word
          // being composed, just a school name search, so autocomplete/
          // autocorrect/predictive text have nothing correct to suggest
          // here — turning them off removes the whole class of bug rather
          // than chasing the event-timing mismatch it comes from.
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          value={open ? query : selectedLabel}
          onFocus={() => {
            setOpen(true)
            setQuery('')
            setHighlight(0)
          }}
          onChange={(e) => {
            setQuery(e.target.value)
            setHighlight(0)
            if (!open) setOpen(true)
          }}
          onKeyDown={onKeyDown}
          className={
            inputClassName ||
            'neo-inset w-full rounded-lg bg-paper-raised py-2 pl-3 pr-8 text-sm text-ink placeholder:text-ink-faint disabled:opacity-60'
          }
        />
        <ChevronsUpDown
          size={14}
          aria-hidden="true"
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-faint"
        />
      </div>

      {mounted ? (
        <ul
          id={id ? `${id}-listbox` : undefined}
          role="listbox"
          aria-label={ariaLabel}
          className={`neo-panel fa-card-drop absolute z-50 mt-1 max-h-72 w-full overflow-y-auto rounded-2xl bg-paper-raised py-1 ${
            closing ? ' fa-chip-exit' : ''
          }`}
        >
          {filtered.length === 0 && !genericMatches ? (
            <li className="px-3 py-2 text-sm text-ink-faint">No school matches &ldquo;{query}&rdquo;</li>
          ) : (
            <>
              {filtered.map((s, i) => (
                <li key={s.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={s.id === value}
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => choose(s.id)}
                    className={`flex min-h-touch w-full items-center gap-2 py-1.5 pl-3 pr-3 text-left text-sm transition-colors ${
                      i === highlight ? 'bg-paper-sunken' : ''
                    } ${s.id === value ? 'text-ink' : 'text-ink-soft'}`}
                  >
                    <span className="min-w-0 flex-1 flex items-center gap-2 truncate">
                      <span className={s.id === value ? 'font-medium' : ''}>{parseSchoolName(s.name).base}</span>
                      {parseSchoolName(s.name).type && (
                        <span className="shrink-0 rounded bg-paper-sunken px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                          {parseSchoolName(s.name).type}
                        </span>
                      )}
                    </span>
                    {s.has_calendar ? (
                      <span className="shrink-0 rounded bg-ok/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-ok">Active</span>
                    ) : s.has_pending_calendar ? (
                      <span className="shrink-0 rounded bg-warn/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-warn">Pending</span>
                    ) : null}
                    {s.id === value ? <Check size={14} aria-hidden="true" className="shrink-0 text-ok ml-1" /> : null}
                  </button>
                </li>
              ))}
              {genericMatches ? (
                <li>
                  <button
                    type="button"
                    role="option"
                    aria-selected={value === genericValue}
                    onMouseEnter={() => setHighlight(filtered.length)}
                    onClick={() => choose(genericValue)}
                    className={`flex min-h-touch w-full items-center gap-2 border-t border-edge py-1.5 pl-3 pr-3 text-left text-sm transition-colors ${
                      highlight === filtered.length ? 'bg-paper-sunken' : ''
                    } ${value === genericValue ? 'text-ink' : 'text-ink-soft'}`}
                  >
                    <span className="min-w-0 flex-1 truncate">{genericLabel}</span>
                    {value === genericValue ? (
                      <Check size={13} aria-hidden="true" className="shrink-0 text-ok" />
                    ) : null}
                  </button>
                </li>
              ) : null}
            </>
          )}
        </ul>
      ) : null}
    </div>
  )
}
