import { useMemo, useState } from 'react'
import { ArrowLeft, BarChart3, BookOpen, Check, Layers3, Loader2, Plus, Search, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
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
    navigate(`/c/${classId}`, {
      state: {
        prefill: text,
        selectedStandard: {
          code: standard.code,
          description: standard.description,
          strand: standard.strand,
          domain: standard.domain,
        },
      },
    })
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
  const state = activeClass?.state
  const [search, setSearch] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('all')
  const [standardsView, setStandardsView] = useState('browse')

  const {
    data,
    isLoading,
    isError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['standards', subject, grade, state, search],
    queryFn: ({ pageParam = 0 }) => api.listStandards({ subject, grade, state, q: search, limit: 200, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) => {
      const loaded = pages.reduce((sum, page) => sum + (page.items?.length || 0), 0)
      return loaded < (lastPage.total || 0) ? loaded : undefined
    },
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
    const loaded = data?.pages?.flatMap((page) => page.items || []) || EMPTY_STANDARDS
    return loaded.filter((standard) => {
      if (seen.has(standard.code)) return false
      seen.add(standard.code)
      return true
    })
  }, [data])
  const totalStandards = data?.pages?.[0]?.total || 0
  const coverage = useMemo(() => coverageData || {}, [coverageData])

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

  const groupedFiltered = useMemo(() => {
    const groups = new Map()
    for (const standard of filtered) {
      const category = standardCategory(standard)
      if (!groups.has(category)) groups.set(category, [])
      groups.get(category).push(standard)
    }
    return Array.from(groups, ([name, items]) => ({ name, items }))
  }, [filtered])

  const coveredCount = useMemo(
    () => standards.filter((standard) => coverage[standard.code] > 0).length,
    [coverage, standards],
  )
  const coveragePercent = standards.length ? Math.round((coveredCount / standards.length) * 100) : 0
  const maxCoverage = useMemo(
    () => Math.max(0, ...standards.map((standard) => coverage[standard.code] || 0)),
    [coverage, standards],
  )

  const focusStandard = (code) => {
    setSelectedCategory('all')
    setSearch(code)
    requestAnimationFrame(() => document.getElementById('standards-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

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
          <header className="mb-6 flex items-start gap-3">
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
                <BookOpen size={14} aria-hidden="true" /> Standards library
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight text-ink">
                  {activeClass ? activeClass.name : 'Standards'}
                </h1>
                {activeClass?.subject ? (
                  <span className="rounded-full border border-accent/20 bg-accent-tint px-2.5 py-1 text-2xs font-semibold text-accent-text">
                    {activeClass.subject}{activeClass.grade !== undefined ? ` · Grade ${activeClass.grade}` : ''}
                  </span>
                ) : null}
              </div>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-muted">
                Browse the standards attached to this course, then send one directly into a new lesson plan.
              </p>
            </div>
          </header>

          <div className="mb-5 flex rounded-2xl border border-edge bg-paper-sunken/45 p-1" role="tablist" aria-label="Standards views">
            <button
              type="button"
              role="tab"
              aria-selected={standardsView === 'browse'}
              onClick={() => setStandardsView('browse')}
              className={`fa-press flex min-h-10 flex-1 items-center justify-center gap-2 rounded-xl px-3 text-sm font-semibold transition-colors ${standardsView === 'browse' ? 'bg-paper-raised text-ink shadow-sm' : 'text-ink-muted hover:text-ink'}`}
            >
              <BookOpen size={15} aria-hidden="true" /> Browse standards
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={standardsView === 'heatmap'}
              onClick={() => setStandardsView('heatmap')}
              className={`fa-press flex min-h-10 flex-1 items-center justify-center gap-2 rounded-xl px-3 text-sm font-semibold transition-colors ${standardsView === 'heatmap' ? 'bg-paper-raised text-ink shadow-sm' : 'text-ink-muted hover:text-ink'}`}
            >
              <BarChart3 size={15} aria-hidden="true" /> Coverage heatmap
            </button>
          </div>

          {standardsView === 'browse' ? (
          <section className="neo-world neo-panel rounded-3xl border border-edge/80 bg-paper-raised/85 p-4 sm:p-5" aria-label="Standards overview">
            <div className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-[0.16em] text-ink-muted">
              <BarChart3 size={14} aria-hidden="true" /> Course coverage
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2 sm:gap-3">
              <div className="rounded-2xl bg-paper-sunken/70 p-3">
                <p className="text-2xs font-semibold uppercase tracking-wider text-ink-muted">Standards</p>
                <p className="mt-1 text-xl font-semibold tracking-tight text-ink">{standards.length}</p>
              </div>
              <div className="rounded-2xl bg-paper-sunken/70 p-3">
                <p className="text-2xs font-semibold uppercase tracking-wider text-ink-muted">Strands</p>
                <p className="mt-1 text-xl font-semibold tracking-tight text-ink">{categories.length}</p>
              </div>
              <div className="rounded-2xl bg-paper-sunken/70 p-3">
                <p className="text-2xs font-semibold uppercase tracking-wider text-ink-muted">Used in plans</p>
                <p className="mt-1 text-xl font-semibold tracking-tight text-ink">{coveragePercent}%</p>
              </div>
            </div>
            <div className="mt-4 flex items-center justify-between gap-3 text-xs text-ink-muted">
              <span>{coveredCount} of {standards.length || 0} standards have been used in a plan</span>
              <Layers3 size={16} className="shrink-0 text-accent" aria-hidden="true" />
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-paper-sunken" aria-hidden="true">
              <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${coveragePercent}%` }} />
            </div>
          </section>
          ) : null}

          {standardsView === 'heatmap' && standards.length > 0 ? (
            <section className="mt-5 rounded-3xl border border-edge bg-paper-raised/70 p-4 shadow-sm sm:p-5" aria-labelledby="standards-heatmap-title">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-[0.16em] text-ink-muted">
                    <Layers3 size={14} aria-hidden="true" /> Standards heatmap
                  </div>
                  <h2 id="standards-heatmap-title" className="mt-2 text-base font-semibold text-ink">Where your plans are concentrated</h2>
                  <p className="mt-1 text-sm text-ink-muted">Each tile is a standard. Darker violet means it appears in more plans.</p>
                </div>
                <div className="flex items-center gap-1.5 text-2xs font-medium text-ink-muted" aria-label="Heatmap legend">
                  <span>Less</span>
                  {[0, 1, 2, 3, 4].map((level) => (
                    <span key={level} className={`h-3 w-3 rounded-sm border ${
                      level === 0 ? 'border-edge bg-paper-sunken/50' : level === 1 ? 'border-accent/15 bg-accent/10' : level === 2 ? 'border-accent/25 bg-accent/20' : level === 3 ? 'border-accent/40 bg-accent/35' : 'border-accent/60 bg-accent/50'
                    }`} aria-hidden="true" />
                  ))}
                  <span>More</span>
                </div>
              </div>
              <div className="mt-4 max-h-64 overflow-y-auto rounded-2xl bg-paper-sunken/35 p-2" role="list" aria-label="Standards usage heatmap">
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
                  {standards.map((standard) => {
                    const count = coverage[standard.code] || 0
                    const ratio = maxCoverage ? count / maxCoverage : 0
                    const level = count === 0 ? 0 : ratio >= 0.75 ? 4 : ratio >= 0.5 ? 3 : ratio >= 0.25 ? 2 : 1
                    const levelClass = level === 0
                      ? 'border-edge bg-paper-raised text-ink-muted hover:border-accent/35 hover:text-ink'
                      : level === 1
                        ? 'border-accent/15 bg-accent/10 text-ink hover:border-accent/35'
                        : level === 2
                          ? 'border-accent/25 bg-accent/20 text-ink hover:border-accent/45'
                          : level === 3
                            ? 'border-accent/40 bg-accent/35 text-ink hover:border-accent/60'
                            : 'border-accent/60 bg-accent/50 text-ink hover:border-accent'
                    return (
                      <button
                        key={standard.code}
                        type="button"
                        role="listitem"
                        onClick={() => focusStandard(standard.code)}
                        className={`fa-press min-h-12 rounded-xl border px-2 py-2 text-left transition-colors ${levelClass}`}
                        aria-label={`Filter to ${standard.code}; used in ${count} ${count === 1 ? 'plan' : 'plans'}`}
                        title={`Filter to ${standard.code}`}
                      >
                        <span className="block truncate font-mono text-2xs font-semibold">{standard.code}</span>
                        <span className="mt-1 block text-2xs opacity-75">{count ? `${count} ${count === 1 ? 'plan' : 'plans'}` : 'Not used'}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            </section>
          ) : null}

          {standardsView === 'browse' ? (<>
          <div className="sticky top-0 z-10 -mx-4 mt-5 bg-paper/80 px-4 pb-3 pt-1 backdrop-blur-xl sm:-mx-6 sm:px-6 md:-mx-10 md:px-10">
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

            <div className="mt-3 -mx-1 overflow-x-auto px-1 pb-1" role="group" aria-label="Filter standards by category">
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
          </div>

          <div className="mt-6 flex items-center justify-between gap-3 px-1 text-xs text-ink-muted" aria-live="polite">
            <span>
              {isLoading ? 'Loading standards…' : `${filtered.length}${totalStandards > filtered.length ? ` of ${totalStandards}` : ''} ${filtered.length === 1 ? 'standard' : 'standards'}`}
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
            <div id="standards-results" className="mt-5 flex flex-col gap-7">
              {groupedFiltered.map(({ name, items }) => (
                <section key={name} aria-labelledby={`standard-group-${name}`}>
                  <div className="mb-2 flex items-center justify-between gap-3 px-1">
                    <h2 id={`standard-group-${name}`} className="text-sm font-semibold text-ink">{name}</h2>
                    <span className="text-2xs font-semibold uppercase tracking-wider text-ink-faint">
                      {items.length} {items.length === 1 ? 'standard' : 'standards'}
                    </span>
                  </div>
                  <div className="flex flex-col gap-2">
                    {items.map((standard) => (
                      <StandardRow
                        key={standard.code}
                        standard={standard}
                        classId={classId}
                        coverageCount={coverage[standard.code] || 0}
                      />
                    ))}
                  </div>
                </section>
              ))}
              {hasNextPage ? (
                <button
                  type="button"
                  className="btn mx-auto mt-2"
                  onClick={() => fetchNextPage()}
                  disabled={isFetchingNextPage}
                >
                  {isFetchingNextPage ? 'Loading more…' : `Load more standards (${Math.max(0, totalStandards - standards.length)} remaining)`}
                </button>
              ) : null}
            </div>
          )}
          </> ) : null}
        </div>
      </main>
    </div>
  )
}
