import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight } from 'lucide-react'
import { api } from '../../lib/api'
import { qk } from '../../lib/queryKeys'
import { useAuth } from '../../lib/authContext'
import { useToast } from '../../lib/toastContext'
import { FrameworkPicker } from '../../components/FrameworkPicker'

/* First run.
 *
 * Everything here already existed as an endpoint and as a field somewhere on My
 * Class — but a brand-new teacher had no reason to visit My Class, so they
 * landed on an empty year with no class attached and nothing telling them what
 * to do. Four separate places linked to class setup and none of them was a
 * first-run path.
 *
 * Two steps, because POST /api/classes auto-names the class from the framework
 * and grade (_auto_name in routes/classes.py) — so a class really is two picks
 * and nothing needs typing except the teacher's own name.
 */

/* Value and label kept apart on purpose. The backend's _auto_name does
   int(grade) to build "AP Language & Composition · 11th", and ClassPage's own
   Add-a-class form sends a bare "11". Sending "11th" from here parsed to NaN, so
   the very FIRST class a teacher created was the only one in their list that
   rendered as "AP Language & Composition · NaNth". */
const GRADES = [
  { value: '9', label: '9th' },
  { value: '10', label: '10th' },
  { value: '11', label: '11th' },
  { value: '12', label: '12th' },
]

export function WelcomePage() {
  const { user, refresh } = useAuth()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()

  const [name, setName] = useState(user?.name || '')
  const [subject, setSubject] = useState('')
  const [grade, setGrade] = useState('11')
  const [saving, setSaving] = useState(false)

  const { data: frameworks = [] } = useQuery({
    queryKey: qk.frameworks,
    queryFn: () => api.getFrameworks(),
    staleTime: Infinity,
  })

  const submit = async (e) => {
    e.preventDefault()
    if (!subject) {
      toast.error('Pick a course first', 'It decides which standards your plans are grounded in.')
      return
    }
    setSaving(true)
    try {
      if (name.trim() && name.trim() !== user?.name) await api.updateMe(name.trim())
      const created = await api.createClass({ subject, grade })
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.classes }),
        refresh(),
      ])
      /* The class root, which is the index route — a new plan, the thing the
         app is for. This said `/calendar`, a route deleted with the week board
         (see the comment on ClassRoutes in App.jsx), so EVERY new account
         finished onboarding on "That address doesn't exist in this app." — and
         `replace: true` meant the back button could not rescue them. */
      navigate(`/c/${created.id}`, { replace: true })
    } catch (err) {
      toast.apiError('Could not set that up', err)
      setSaving(false)
    }
  }

  return (
    <div className="flex min-h-app w-full items-center justify-center bg-paper p-gutter">
      <form
        onSubmit={submit}
        className="flex w-full max-w-measure-form flex-col gap-7 rounded-2xl border border-edge bg-paper-raised p-8 md:p-10"
      >
        <div>
          <h1 className="text-2xl font-semibold tracking-display text-ink">Let’s set up your year</h1>
          <p className="mt-1.5 text-sm text-ink-muted">
            Two things, then your calendar is ready. You can add more classes later.
          </p>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-ink">What should plans say your name is?</span>
          <span className="text-xs text-ink-muted">
            It gets stamped on every .docx. Asked once, not per class.
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            autoComplete="name"
            className="mt-1 block w-full rounded-lg border border-edge bg-paper px-3.5 py-2.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent"
          />
        </label>

        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-ink">Your first class</span>
          <span className="text-xs text-ink-muted">
            The course decides which standards get retrieved. It names itself from these two.
          </span>
          <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-start">
            <div className="min-w-0 flex-1">
              <FrameworkPicker
                frameworks={frameworks}
                value={subject}
                onChange={setSubject}
                id="welcome-framework"
              />
            </div>
            <select
              aria-label="Grade"
              value={grade}
              onChange={(e) => setGrade(e.target.value)}
              className="min-h-touch rounded-lg border border-edge bg-paper px-2.5 py-2.5 text-sm text-ink outline-none focus:border-accent sm:w-24"
            >
              {GRADES.map((g) => (
                <option key={g.value} value={g.value}>{g.label}</option>
              ))}
            </select>
          </div>
        </div>

        <button
          type="submit"
          disabled={saving}
          className="flex min-h-touch-lg w-full items-center justify-center gap-2 rounded-lg bg-ink px-4 text-sm font-semibold text-ink-inverse transition-colors hover:bg-ink-soft disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? 'Setting up…' : 'Open my year'}
          {saving ? null : <ArrowRight size={15} aria-hidden="true" />}
        </button>
      </form>
    </div>
  )
}
