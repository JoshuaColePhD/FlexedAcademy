import { useEffect, useState } from 'react'
import { PanelLeft } from 'lucide-react'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'
import { ThemeToggle } from '../components/ThemeToggle'

/* One class. These three values used to be hardcoded into the LLM prompt
   ("Josh Cole", "3rd period"), which is why the app couldn't address anything
   else. They now go onto the plan server-side after validation — the model never
   authors the teacher's name. */
export function MyClassPage({ shell }) {
  const toast = useToast()
  const { theme, onToggleSidebar, settings, setSettings } = shell
  const [form, setForm] = useState(settings || { teacher: '', course: '', period: '' })
  const [saving, setSaving] = useState(false)
  const [health, setHealth] = useState(null)

  useEffect(() => {
    if (settings) setForm(settings)
  }, [settings])

  useEffect(() => {
    api.health().then(setHealth).catch(() => {})
  }, [])

  const save = async (e) => {
    e.preventDefault()
    setSaving(true)
    try {
      const saved = await api.putSettings({
        teacher: form.teacher.trim(),
        course: form.course.trim(),
        period: form.period.trim(),
      })
      setSettings(saved)
      toast.success('Class details saved', 'New plans will use these.')
    } catch (err) {
      toast.error('Could not save', err.hint || err.message)
    } finally {
      setSaving(false)
    }
  }

  const dirty =
    settings &&
    (form.teacher !== settings.teacher ||
      form.course !== settings.course ||
      form.period !== settings.period)

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
        <span className="topbar-title">My Class</span>
        <span className="topbar-spacer" />
        <ThemeToggle mode={theme.mode} onCycle={theme.cycle} />
      </header>

      <div className="page">
        <div className="page-inner">
          <div className="page-head">
            <h1>My Class</h1>
            <p>
              These go in the header of every lesson plan document. One class for now — the plan is
              to add more once this is working the way you want.
            </p>
          </div>

          <form className="card" onSubmit={save}>
            <div className="field">
              <label htmlFor="teacher">Teacher</label>
              <input
                id="teacher"
                className="input"
                value={form.teacher}
                onChange={(e) => setForm({ ...form, teacher: e.target.value })}
                required
              />
              <small>Printed as “Teacher:” in the document header.</small>
            </div>

            <div className="field">
              <label htmlFor="course">Course</label>
              <input
                id="course"
                className="input"
                value={form.course}
                onChange={(e) => setForm({ ...form, course: e.target.value })}
                required
              />
              <small>
                The standards corpus is Grade 11 AP Lang, so plans stay grounded in that regardless
                of what you put here.
              </small>
            </div>

            <div className="field">
              <label htmlFor="period">Period</label>
              <input
                id="period"
                className="input"
                value={form.period}
                onChange={(e) => setForm({ ...form, period: e.target.value })}
                required
              />
            </div>

            <div style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'center' }}>
              <button type="submit" className="btn btn-primary" disabled={saving || !dirty}>
                {saving ? 'Saving…' : 'Save changes'}
              </button>
              {dirty ? (
                <button type="button" className="btn" onClick={() => setForm(settings)}>
                  Reset
                </button>
              ) : (
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-muted)' }}>
                  Saved{settings?.updated_at ? ` ${settings.updated_at.replace('T', ' ')}` : ''}
                </span>
              )}
            </div>
          </form>

          {health ? (
            <section className="card" aria-label="System status">
              <h2 style={{ fontSize: 'var(--fs-lg)', marginBottom: 'var(--sp-3)' }}>Status</h2>
              <div className="list" style={{ border: 'none' }}>
                {[
                  ['Model', health.model],
                  ['Template', health.builder_template],
                  ['Standards indexed', `${health.chunks} (${health.chroma_count} embedded)`],
                  ['Relevance floor', health.retrieval_floor],
                  ['API key', health.api_key_set ? 'set' : 'missing'],
                ].map(([k, v]) => (
                  <div className="list-row" key={k} style={{ padding: 'var(--sp-2) 0' }}>
                    <div className="list-row-main">
                      <small style={{ color: 'var(--ink-soft)' }}>{k}</small>
                    </div>
                    <span className={`tag${health.ok ? '' : ' is-warn'} is-mono`}>{String(v)}</span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  )
}
