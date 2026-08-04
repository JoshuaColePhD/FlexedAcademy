import { useCallback, useEffect, useState } from 'react'
import { PanelLeft, Search } from 'lucide-react'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'
import { ThemeToggle } from '../components/ThemeToggle'

/* Makes the corpus and its limits visible.

   This page exists because retrieval cannot prove a negative on its own. The
   semantic search deliberately SHOWS what the relevance floor rejected, with the
   distance, so the cutoff is inspectable rather than a black box — and the gaps
   panel states plainly what the sources don't cover. */
export function StandardsPage({ shell }) {
  const toast = useToast()
  const { theme, onToggleSidebar } = shell

  const [stats, setStats] = useState(null)
  const [gaps, setGaps] = useState(null)
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [filter, setFilter] = useState('')
  const [sourceType, setSourceType] = useState('')
  const [semantic, setSemantic] = useState('')
  const [results, setResults] = useState(null)
  const [detail, setDetail] = useState(null)

  useEffect(() => {
    Promise.all([api.standardsStats(), api.standardsGaps()])
      .then(([s, g]) => {
        setStats(s)
        setGaps(g)
      })
      .catch((err) => toast.error('Could not load the corpus', err.hint || err.message))
  }, [toast])

  const load = useCallback(
    async (q, st) => {
      try {
        const data = await api.listStandards({ q, source_type: st, limit: 300 })
        setItems(data.items)
        setTotal(data.total)
      } catch (err) {
        toast.error('Could not load standards', err.message)
      }
    },
    [toast]
  )

  useEffect(() => {
    load(filter, sourceType)
  }, [load, filter, sourceType])

  const runSemantic = async (e) => {
    e.preventDefault()
    if (!semantic.trim()) return
    try {
      setResults(await api.searchStandards(semantic.trim(), 12))
    } catch (err) {
      toast.error('Search failed', err.hint || err.message)
    }
  }

  return (
    <div className="column">
      <header className="topbar">
        <button
          type="button"
          className="btn-icon"
          onClick={onToggleSidebar}
          aria-label="Toggle sidebar"
        >
          <PanelLeft size={16} aria-hidden="true" />
        </button>
        <span className="topbar-title">Standards</span>
        <span className="topbar-spacer" />
        <ThemeToggle mode={theme.mode} onCycle={theme.cycle} />
      </header>

      <div className="page">
        <div className="page-inner">
          <div className="page-head">
            <h1>Standards</h1>
            <p>
              What the generator is allowed to cite. Every chunk was checked back against the source
              document it came from, and what the sources don’t cover is recorded below rather than
              filled in.
            </p>
          </div>

          {stats ? (
            <div className="card">
              <div className="stat-row">
                <span className="stat">
                  <b>{stats.total}</b>
                  <span>standards</span>
                </span>
                <span className="stat">
                  <b>{stats.verbatim_ok}</b>
                  <span>verified verbatim</span>
                </span>
                <span className="stat">
                  <b>{stats.retrieval_floor}</b>
                  <span>relevance floor</span>
                </span>
                {Object.entries(stats.by_source_type).map(([k, v]) => (
                  <span className="stat" key={k}>
                    <b>{v}</b>
                    <span>{k.replace(/_/g, ' ')}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {/* Semantic search that shows the rejects. */}
          <section className="card" aria-label="Test retrieval">
            <h2 style={{ fontSize: 'var(--fs-lg)', marginBottom: 'var(--sp-2)' }}>
              Test what a request would retrieve
            </h2>
            <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--ink-muted)', marginBottom: 'var(--sp-4)' }}>
              Anything above the {stats?.retrieval_floor ?? 0.78} floor is shown but marked — that’s
              what the generator refuses to use.
            </p>
            <form className="toolbar" onSubmit={runSemantic}>
              <label className="visually-hidden" htmlFor="semantic">
                Describe a lesson
              </label>
              <input
                id="semantic"
                className="input"
                placeholder="e.g. analysing tone through diction"
                value={semantic}
                onChange={(e) => setSemantic(e.target.value)}
              />
              <button type="submit" className="btn btn-primary">
                <Search size={14} aria-hidden="true" /> Search
              </button>
            </form>

            {results ? (
              <div className="list" style={{ marginTop: 'var(--sp-4)' }}>
                {results.results.map((r) => (
                  <div className="list-row" key={r.code}>
                    <span className="tag is-mono">{r.code}</span>
                    <div className="list-row-main">
                      <small style={{ whiteSpace: 'normal' }}>{r.description}</small>
                    </div>
                    <span className={`tag ${r.below_floor ? 'is-ok' : 'is-warn'}`}>
                      {r.distance.toFixed(3)} {r.below_floor ? 'used' : 'rejected'}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </section>

          {/* Browse */}
          <section aria-label="Browse standards">
            <div className="toolbar" style={{ marginBottom: 'var(--sp-4)' }}>
              <label className="visually-hidden" htmlFor="std-filter">
                Filter standards
              </label>
              <input
                id="std-filter"
                className="input"
                placeholder="Filter by code or wording"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <label className="visually-hidden" htmlFor="std-source">
                Source type
              </label>
              <select
                id="std-source"
                className="input"
                value={sourceType}
                onChange={(e) => setSourceType(e.target.value)}
                style={{ flex: 'none', minWidth: 180 }}
              >
                <option value="">All sources</option>
                {stats
                  ? Object.keys(stats.by_source_type).map((k) => (
                      <option key={k} value={k}>
                        {k.replace(/_/g, ' ')}
                      </option>
                    ))
                  : null}
              </select>
              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-muted)' }}>
                {total} shown
              </span>
            </div>

            <div className="list">
              {items.length === 0 ? (
                <p className="empty-note">Nothing matches that filter.</p>
              ) : (
                items.map((s) => (
                  <div className="list-row" key={s.code}>
                    <span className="tag is-mono">{s.code}</span>
                    <div className="list-row-main">
                      <small style={{ whiteSpace: 'normal' }}>{s.description}</small>
                    </div>
                    {s.frequency ? <span className="tag">×{s.frequency}</span> : null}
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setDetail(detail?.code === s.code ? null : s)}
                      aria-expanded={detail?.code === s.code}
                    >
                      Source
                    </button>
                  </div>
                ))
              )}
            </div>

            {detail ? (
              <div className="card" style={{ marginTop: 'var(--sp-4)' }}>
                <span className="tag is-mono">{detail.code}</span>
                <p style={{ margin: 'var(--sp-3) 0' }}>{detail.description}</p>
                <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-muted)' }}>
                  <code style={{ fontFamily: 'var(--font-mono)' }}>{detail.source_document}</code>
                  {detail.source_page_or_section ? ` · ${detail.source_page_or_section}` : ''}
                  {detail.strand ? ` · ${detail.strand}` : ''}
                  {detail.verbatim_ok ? ' · verified verbatim against the source' : ''}
                </p>
              </div>
            ) : null}
          </section>

          {/* What we don't have. */}
          {gaps ? (
            <section className="card" aria-label="Known gaps">
              <h2 style={{ fontSize: 'var(--fs-lg)' }}>What these sources don’t cover</h2>
              <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--ink-muted)', margin: 'var(--sp-2) 0 var(--sp-4)' }}>
                Recorded so the generator never invents coverage it doesn’t have. Codes in the{' '}
                {gaps.ungroundable_families.join(' and ')} families can’t be grounded in anything
                held here, and a plan citing one is flagged.
              </p>
              {gaps.sections.map((s) => (
                <details key={s.title} style={{ borderTop: '1px solid var(--rule-hair)', padding: 'var(--sp-3) 0' }}>
                  <summary style={{ cursor: 'pointer', fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-sm)' }}>
                    {s.title}
                  </summary>
                  <p className="prose" style={{ marginTop: 'var(--sp-2)' }}>
                    {s.body_md}
                  </p>
                </details>
              ))}
            </section>
          ) : null}
        </div>
      </div>
    </div>
  )
}
