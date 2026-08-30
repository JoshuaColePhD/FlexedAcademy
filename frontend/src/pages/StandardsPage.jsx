import { useMemo, useState } from 'react'
import { ArrowLeft, BookOpen, Check, Loader2, Plus, Search, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useActiveClass } from '../hooks/useAppData'
import { useToast } from '../lib/toastContext'

const EMPTY_STANDARDS = []

function standardCategory(standard) {
  const strand = standard.strand?.trim()
  if (!strand) return standard.domain?.trim() || 'Other'
  if (/^unit\s+\d+/i.test(strand)) return 'Units'
  if (/^big idea\s*:/i.test(strand)) return 'Big Ideas'
  if (strand.includes(' – ') || strand.includes(' — ')) return 'Course skills'
  return strand.split(/\s+[–—-]\s+/)[0].trim()
}

function StandardRow({ standard, classId, coverageCount }) {
  const navigate = useNavigate()
  const toast = useToast()
  const [expanded, setExpanded] = useState(false)

  const addToPlan = (event) => {
    event.stopPropagation()
    const text = `Focus this lesson on ${standard.code}: ${standard.description}`
    navigate(`/c/${classId}?prefill=${encodeURIComponent(text)}`)
    toast({ title: 'Added to chat', type: 'success' })
  }

  const detailsLabel = expanded ? `Hide details for ${standard.code}` : `Show details for ${standard.code}`

  return (
    <article className="overflow-hidden rounded-2xl border border-edge bg-paper-raised shadow-sm transition-shadow hover:shadow-md">
      <div className="flex items-start gap-3 p-4">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-3 text-left"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-label={detailsLabel}
        >
          <span className="shrink-0 rounded-lg bg-paper-sunken px-2.5 py-1.5 font-mono text-sm font-semibold text-ink">
            {standard.code}
          </span>
          <span className="min-w-0 pt-1 text-sm leading-relaxed text-ink">
            {standard.description}
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-2">
          {coverageCount > 0 ? (
            <span className="hidden rounded-full bg-ok-tint px-2 py-1 text-2xs font-semibold text-ok sm:inline-flex">
              Used {coverageCount}×
            </span>
          ) : null}
          <button
            type="button"
            className="btn-icon fa-press"
            onClick={addToPlan}
            aria-label={`Add ${standard.code} to the lesson plan`}
            title="Add to plan"
          >
            <Plus size={16} aria-hidden="true" />
          </button>
        </div>
      </div>

      {expanded ? (
        <div className="border-t border-edge bg-paper-sunken/50 px-4 pb-4 pt-3">
          <div className="flex flex-wrap items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-ink-muted">
            {standard.strand ? <span>{standard.strand}</span> : null}
            {standard.domain ? <span>· {standard.domain}</span> : null}
            {coverageCount > 0 ? <span>· Used {coverageCount} times</span> : <span>· Not used yet</span>}
          </div>
          <button type="button" className="btn mt-3" onClick={addToPlan}>
            <Plus size={14} className="mr-1.5" aria-hidden="true" /> Add to plan
          </button>
        </div>
      ) : null}
    </article>
  )
}

export function StandardsPage() {
  const navigate = useNavigate()
  const { activeClass, classId } = useActiveClass()
  const subject = activeClass?.subject
  const grade = activeClass?.grade
  const [search, setSearch] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('all')

  const { data, isLoading, isError } = useQuery({
    queryKey: ['standards', subject, grade],
    queryFn: () => api.listStandards({ subject, grade }),
    staleTime: Infinity,
    enabled: !!subject && grade !== undefined,
  })

  const { data: coverageData } = useQuery({
    queryKey: ['standards', 'coverage', classId],
    queryFn: () => api.getStandardsCoverage(classId),
    staleTime: Infinity,
    enabled: !!classId,
  })

  const standards = useMemo(() => {
    const seen = new Set()
    return (data?.items || EMPTY_STANDARDS).filter((standard) => {
      if (seen.has(standard.code)) return false
      seen.add(standard.code)
      return true
    })
  }, [data])
  const coverage = coverageData || {}

  const categories = useMemo(() => {
    const counts = new Map()
    for (const standard of standards) {
      const category = standardCategory(standard)
      counts.set(category, (counts.get(category) || 0) + 1)
    }
    return Array.from(counts, ([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [standards])

  const activeCategory = selectedCategory === 'all' || categories.some(({ name }) => name === selectedCategory)
    ? selectedCategory
    : 'all'

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    return standards.filter((standard) => {
      if (activeCategory !== 'all' && standardCategory(standard) !== activeCategory) return false
      if (!query) return true
      return [standard.code, standard.description, standard.strand, standard.domain]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(query))
    })
  }, [activeCategory, search, standards])

  const categoryButtons = [
    { name: 'all', label: 'All standards', count: standards.length },
    ...categories,
  ]

  const selectCategory = (category) => {
    setSelectedCategory(category)
  }

  const matchingLabel = search ? `Matching “${search}”` : null

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-paper/40 backdrop-blur-3xl saturate-[1.2] glass-panel border border-white/5">
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-4 py-5 pb-28 sm:px-6 md:px-10 md:py-10">
          <header className="mb-8 flex items-start gap-3">
            <button
              type="button"
              onClick={() => navigate(-1)}
              aria-label="Back"
              className="btn-icon fa-press mt-0.5 shrink-0"
            >
              <ArrowLeft size={17} aria-hidden="true" />
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-[0.16em] text-ink-muted">
                <BookOpen size={14} aria-hidden="true" /> Standards
              </div>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">
                {activeClass ? `${activeClass.name} standards` : 'Standards'}
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-muted">
                Search the standards for this course, then add one directly to your lesson plan.
              </p>
            </div>
          </header>

          <label className="flex min-h-[52px] items-center gap-3 rounded-2xl border border-edge bg-paper-raised px-4 shadow-sm transition-shadow focus-within:shadow-md">
            <Search size={19} className="shrink-0 text-ink-muted" aria-hidden="true" />
            <span className="sr-only">Search standards</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by code or keyword"
              className="min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-ink-faint"
            />
            {search ? (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="btn-icon h-8 w-8 shrink-0"
                aria-label="Clear standards search"
              >
                <X size={15} aria-hidden="true" />
              </button>
            ) : null}
          </label>

          <div className="mt-4 -mx-1 overflow-x-auto px-1 pb-1" role="group" aria-label="Filter standards by category">
            <div className="flex min-w-max items-center gap-2">
              {categoryButtons.map(({ name, label = name, count }) => {
                const selected = activeCategory === name
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => selectCategory(name)}
                    aria-pressed={selected}
                    className={`fa-press tap-target inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                      selected
                        ? 'border-accent bg-accent text-accent-on shadow-sm'
                        : 'border-edge bg-paper-raised text-ink-muted hover:border-accent/50 hover:text-ink'
                    }`}
                  >
                    <span>{label}</span>
                    <span className={selected ? 'text-accent-on/75' : 'text-ink-faint'}>{count}</span>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="mt-6 flex items-center justify-between gap-3 px-1 text-xs text-ink-muted" aria-live="polite">
            <span>
              {isLoading ? 'Loading standards…' : `${filtered.length} ${filtered.length === 1 ? 'standard' : 'standards'}`}
            </span>
            {matchingLabel ? <span>{matchingLabel}</span> : null}
          </div>

          {isLoading ? (
            <div className="flex flex-col items-center justify-center gap-3 py-24 text-ink-muted">
              <Loader2 size={24} className="animate-spin text-accent" aria-hidden="true" />
              <p className="text-sm">Loading standards…</p>
            </div>
          ) : isError ? (
            <div className="py-24 text-center">
              <p className="text-base font-medium text-ink">Standards couldn’t load.</p>
              <p className="mt-1 text-sm text-ink-muted">Try refreshing the page.</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-24 text-center">
              <Check size={28} className="mx-auto text-ink-faint" aria-hidden="true" />
              <p className="mt-3 text-base font-medium text-ink">No matching standards</p>
              <p className="mt-1 text-sm text-ink-muted">Try a different code or keyword.</p>
            </div>
          ) : (
            <div className="mt-3 flex flex-col gap-2">
              {filtered.map((standard) => (
                <StandardRow
                  key={standard.code}
                  standard={standard}
                  classId={classId}
                  coverageCount={coverage[standard.code] || 0}
                />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
