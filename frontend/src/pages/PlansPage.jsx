import { useCallback, useEffect, useState } from 'react'
import { Download, PanelLeft, RefreshCw, Trash2 } from 'lucide-react'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'
import { ThemeToggle } from '../components/ThemeToggle'
import { LessonPlanTable } from '../components/LessonPlanTable'
import { Marginalia } from '../components/Marginalia'

/* Every plan ever generated. Previously each one was a UUID .docx rotting in
   temp/ with localStorage as the only record, so a cleaned temp/ meant the week
   was gone. */
export function PlansPage({ shell }) {
  const toast = useToast()
  const { theme, onToggleSidebar } = shell
  const [data, setData] = useState({ items: [], total: 0 })
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(null)

  const load = useCallback(
    async (search) => {
      setLoading(true)
      try {
        setData(await api.listPlans({ q: search, limit: 100 }))
      } catch (err) {
        toast.error('Could not load your plans', err.hint || err.message)
      } finally {
        setLoading(false)
      }
    },
    [toast]
  )

  useEffect(() => {
    load('')
  }, [load])

  const remove = async (plan) => {
    if (!confirm(`Delete ${plan.week_label}? The document and the saved plan both go.`)) return
    try {
      await api.deletePlan(plan.id)
      setData((d) => ({ ...d, items: d.items.filter((p) => p.id !== plan.id), total: d.total - 1 }))
      if (open?.id === plan.id) setOpen(null)
      toast.success('Plan deleted')
    } catch (err) {
      toast.error('Could not delete that plan', err.message)
    }
  }

  const rebuild = async (plan) => {
    try {
      const row = await api.rebuildPlan(plan.id)
      setData((d) => ({ ...d, items: d.items.map((p) => (p.id === row.id ? row : p)) }))
      toast.success('Document rebuilt', row.week_label)
    } catch (err) {
      toast.error('Could not rebuild that document', err.hint || err.message)
    }
  }

  const openPlan = async (plan) => {
    try {
      setOpen(await api.getPlan(plan.id))
    } catch (err) {
      toast.error('Could not open that plan', err.message)
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
        <span className="topbar-title">Plans</span>
        <span className="topbar-spacer" />
        <ThemeToggle mode={theme.mode} onCycle={theme.cycle} />
      </header>

      <div className="page">
        <div className="page-inner">
          <div className="page-head">
            <h1>Plans</h1>
            <p>
              Every week you’ve generated, with the document it produced. Nothing here depends on a
              temporary file — each plan is stored and can be rebuilt.
            </p>
          </div>

          <form
            className="toolbar"
            onSubmit={(e) => {
              e.preventDefault()
              load(q)
            }}
          >
            <label className="visually-hidden" htmlFor="plan-search">
              Search plans
            </label>
            <input
              id="plan-search"
              className="input"
              placeholder="Search by week, unit, or the request that made it"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <button type="submit" className="btn btn-outline">
              Search
            </button>
            {q ? (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setQ('')
                  load('')
                }}
              >
                Clear
              </button>
            ) : null}
          </form>

          {loading ? (
            <p className="empty-note">Loading…</p>
          ) : data.items.length === 0 ? (
            <div className="list">
              <p className="empty-note">
                {q ? 'No plans match that search.' : 'No plans yet. Generate one from the chat.'}
              </p>
            </div>
          ) : (
            <div className="list">
              {data.items.map((plan) => (
                <div className="list-row" key={plan.id}>
                  <div className="list-row-main">
                    <strong>{plan.week_label}</strong>
                    <small>{plan.query}</small>
                  </div>
                  {plan.unit ? <span className="tag">{plan.unit}</span> : null}
                  {plan.warning_count || plan.warnings?.length ? (
                    <span className="tag is-warn">
                      {plan.warnings?.length ?? plan.warning_count} note
                      {(plan.warnings?.length ?? plan.warning_count) === 1 ? '' : 's'}
                    </span>
                  ) : null}
                  {!plan.has_docx ? <span className="tag is-warn">no document</span> : null}
                  <div className="list-row-actions">
                    <button type="button" className="btn" onClick={() => openPlan(plan)}>
                      Review
                    </button>
                    {plan.has_docx ? (
                      <a
                        className="btn-icon"
                        href={api.planDownloadUrl(plan.id)}
                        download
                        aria-label={`Download ${plan.week_label}`}
                        title="Download DOCX"
                      >
                        <Download size={15} aria-hidden="true" />
                      </a>
                    ) : (
                      <button
                        type="button"
                        className="btn-icon"
                        onClick={() => rebuild(plan)}
                        aria-label={`Rebuild the document for ${plan.week_label}`}
                        title="Rebuild document"
                      >
                        <RefreshCw size={15} aria-hidden="true" />
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-icon is-danger"
                      onClick={() => remove(plan)}
                      aria-label={`Delete ${plan.week_label}`}
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {open ? (
            <section className="card" aria-label={`Review ${open.week_label}`}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--sp-3)',
                  marginBottom: 'var(--sp-4)',
                }}
              >
                <h2 style={{ flex: 1, fontSize: 'var(--fs-xl)' }}>{open.week_label}</h2>
                <button type="button" className="btn" onClick={() => setOpen(null)}>
                  Close
                </button>
              </div>
              <LessonPlanTable plan={open.plan_json} groundedCodes={open.retrieved_ids} />
              <div style={{ height: 'var(--sp-4)' }} />
              <Marginalia warnings={open.warnings} />
            </section>
          ) : null}
        </div>
      </div>
    </div>
  )
}
