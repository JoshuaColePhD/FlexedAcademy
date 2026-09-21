import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, BookOpen, Check, FileText, Loader2 } from 'lucide-react'
import { api } from '../../lib/api'
import { qk } from '../../lib/queryKeys'
import { useAuth } from '../../lib/authContext'
import { useToast } from '../../lib/toastContext'
import { US_STATES, isStandardsReady } from '../../lib/states'
import { GRADES, gradeLabel } from '../../lib/grades'
import { matchesFramework } from '../../lib/frameworks'
import { GENERIC_SCHOOL } from '../../lib/schools'
import { deferOnboarding } from '../../lib/onboardingWizardBus'
import { clearFirstPlanDraft, firstPlanPrompt, readFirstPlanDraft, writeFirstPlanDraft } from '../../lib/firstPlanSetup'
import './first-plan-setup.css'

const record = (name, step, props = {}) => {
  void api.recordOnboardingEvents([{ name, step, props }]).catch(() => {})
}

/** Two decisions before the first useful plan. Optional setup stays in Settings. */
export function FirstPlanSetup({ cls, onClose }) {
  const { user } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const [draft, setDraft] = useState(() => {
    const saved = readFirstPlanDraft(user?.id)
    if (saved) return saved.classId && saved.classId !== cls?.id
      ? { ...saved, classId: cls?.id || '', step: 'context' }
      : saved
    return {
      version: 1, step: 'context', classId: cls?.id || '',
      state: cls?.state || '', grade: cls?.grade == null ? '' : String(cls.grade),
      subject: cls?.subject || '', school: cls?.school || user?.school || GENERIC_SCHOOL,
      topic: '', week: '',
    }
  })
  const [savedClass, setSavedClass] = useState(cls || null)
  const [courseSearch, setCourseSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showSchool, setShowSchool] = useState(false)
  const [draftSaved, setDraftSaved] = useState(true)
  const inFlight = useRef(false)
  const createdClass = useRef(cls || null)
  const heading = useRef(null)
  const started = useRef(false)
  const update = (patch) => { setError(''); setDraft((value) => ({ ...value, ...patch })) }

  useEffect(() => { setDraftSaved(writeFirstPlanDraft(user?.id, draft)) }, [user?.id, draft])
  useEffect(() => {
    if (!started.current) {
      started.current = true
      record('flow_started', draft.step, { resumed: Boolean(readFirstPlanDraft(user?.id)?.classId) })
    }
    record('step_viewed', draft.step)
    void api.setOnboardingProgress({ step: draft.step }).catch(() => {})
    heading.current?.focus({ preventScroll: true })
  }, [draft.step, user?.id])

  const activeStates = useQuery({
    queryKey: qk.activeStandardsStates,
    queryFn: ({ signal }) => api.getActiveStandardsStates({ signal }).then((result) => new Set(result.states)),
    staleTime: 60_000,
  })
  const supported = isStandardsReady(draft.state, activeStates.data)
  const frameworks = useQuery({
    queryKey: qk.frameworks(draft.state),
    queryFn: ({ signal }) => api.getFrameworks({ state: draft.state, signal }),
    enabled: Boolean(draft.state),
    staleTime: 5 * 60_000,
  })
  const schools = useQuery({ queryKey: qk.schools, queryFn: ({ signal }) => api.listSchools({ signal }), enabled: showSchool, staleTime: 5 * 60_000 })
  const calendar = useQuery({
    queryKey: qk.calendar(draft.classId),
    queryFn: ({ signal }) => api.getWeeks(draft.classId, { signal }),
    enabled: Boolean(draft.classId) && draft.step === 'preview',
    staleTime: 5 * 60_000,
  })
  const source = useQuery({
    queryKey: ['onboarding-source', draft.state, draft.subject, draft.grade],
    queryFn: ({ signal }) => api.listStandards({ state: draft.state, subject: draft.subject, grade: draft.grade, limit: 1, signal }),
    enabled: draft.step === 'preview' && supported,
    staleTime: 5 * 60_000,
  })

  const eligible = useMemo(() => (frameworks.data || []).filter((course) => (course.grades || []).includes(Number(draft.grade))), [frameworks.data, draft.grade])
  const choices = eligible.filter((course) => matchesFramework(course, courseSearch))
  const courseLabel = (frameworks.data || []).find((course) => course.id === draft.subject)?.label || draft.subject
  const weeks = calendar.data?.weeks || []
  const defaultWeek = weeks.find((week) => week.is_current) || weeks.find((week) => !week.has_plan && !week.is_break) || weeks[0]
  const weekNumber = draft.week || String(defaultWeek?.week || 1)
  const selectedWeek = weeks.find((week) => String(week.week) === weekNumber)
  const sampleSource = source.data?.items?.[0]
  const schoolLabel = (schools.data || []).find((school) => school.id === draft.school)?.name

  const saveClass = async (event) => {
    event.preventDefault()
    if (inFlight.current) return
    if (!draft.state || !draft.grade || !draft.subject.trim()) {
      setError('Choose a state, grade, and course to continue.')
      return
    }
    if (supported && !eligible.some((course) => course.id === draft.subject)) {
      setError('Choose a course from the catalog for this grade.')
      return
    }
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      if (draft.school !== user.school) await api.updateMe({ school: draft.school || GENERIC_SCHOOL })
      const current = createdClass.current
      const row = current
        ? await api.updateClass(current.id, { subject: draft.subject.trim(), grade: draft.grade, state: draft.state, school: draft.school || GENERIC_SCHOOL })
        : await api.createClass({ subject: draft.subject.trim(), grade: draft.grade, state: draft.state })
      createdClass.current = row
      setSavedClass(row)
      const next = { ...draft, classId: row.id, step: 'preview' }
      writeFirstPlanDraft(user.id, next)
      setDraft(next)
      qc.setQueryData(qk.classes, (rows = []) => [...rows.filter((item) => item.id !== row.id), row])
      record('step_completed', 'context')
    } catch (err) {
      setError(err.message || 'Your class could not be saved. Try again.')
      record('step_error', 'context', { code: err.code || 'unknown' })
    } finally {
      setBusy(false)
      inFlight.current = false
    }
  }

  const finish = async (event) => {
    event.preventDefault()
    if (inFlight.current) return
    if (!draft.topic.trim()) { setError('Tell us what you are teaching this week.'); return }
    if (!Number.isInteger(Number(weekNumber)) || Number(weekNumber) < 1 || Number(weekNumber) > 53) { setError('Choose a week between 1 and 53.'); return }
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const completedUser = await api.markOnboardingSeen()
      // The mutation returns the complete account. Publish that confirmed
      // response and prevent an older in-flight /me read from replacing it.
      await qc.cancelQueries({ queryKey: qk.me })
      qc.setQueryData(qk.me, completedUser)
    } catch (err) {
      deferOnboarding(user.id)
      toast.info('Your class is saved', 'We will retry the setup status on your next visit.')
      record('step_error', 'preview', { code: err.code || 'unknown' })
    }
    record('step_completed', 'preview')
    record('flow_completed', 'preview', { plan: ['context', 'preview'] })
    clearFirstPlanDraft(user.id)
    onClose(savedClass || createdClass.current, supported ? {
      autoPrompt: firstPlanPrompt(draft.topic, weekNumber, selectedWeek?.label || selectedWeek?.week_label || ''),
      weekNumber: Number(weekNumber),
      onboardingFirstPlan: true,
    } : { prefill: draft.topic })
  }

  return (
    <main className="first-plan-setup" aria-label="Set up your first lesson plan">
      <header className="first-plan-header">
        <span className="text-sm font-semibold text-ink">FlexEd Academy</span>
        <a className="text-sm text-ink-muted" href="mailto:support@flexedacademy.com">Need a hand?</a>
      </header>
      <div className="first-plan-layout">
        <aside className="first-plan-intro">
          <p className="eyebrow">Less setup. A useful first week.</p>
          <h1>Start with what<br />you’re teaching.</h1>
          <p>{draft.state && !supported ? 'Keep your teaching context together while your course standards become available.' : 'We’ll turn your topic into a lesson plan you can review, revise, and download.'}</p>
          <ol aria-label="Setup progress" className="first-plan-steps">
            <li aria-current={draft.step === 'context' ? 'step' : undefined}><span>{draft.step === 'preview' ? <Check size={15} /> : '1'}</span>Your class</li>
            <li aria-current={draft.step === 'preview' ? 'step' : undefined}><span>2</span>Your first week</li>
          </ol>
          <div className="first-plan-person"><span>{(user.name || 'Teacher').split(' ').map((part) => part[0]).slice(0, 2).join('')}</span><div>{user.name}<small>The name on your plans. Change it later in Settings.</small></div></div>
        </aside>
        <section className="first-plan-card" aria-labelledby="first-plan-title">
          {draft.step === 'context' ? (
            <form onSubmit={saveClass}>
              <p className="eyebrow">1 of 2 · Your class</p>
              <h2 id="first-plan-title" tabIndex={-1} ref={heading}>Which class are we planning for?</h2>
              <p className="first-plan-lead">Your grade and course choose the standards. You can add other classes later.</p>
              <div className="first-plan-fields">
                <label>State<select aria-label="State" value={draft.state} onChange={(event) => { setCourseSearch(''); update({ state: event.target.value, subject: '', school: GENERIC_SCHOOL }) }} required><option value="">Choose a state</option>{US_STATES.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
                <label>Grade<select aria-label="Grade" value={draft.grade} onChange={(event) => update({ grade: event.target.value, subject: '' })} required><option value="">Choose a grade</option>{GRADES.map((grade) => <option value={grade.value} key={grade.value}>{grade.label}</option>)}</select></label>
              </div>
              {draft.state && !supported ? <p className="first-plan-notice">State standards for {US_STATES.find(([code]) => code === draft.state)?.[1]} are not available yet. You can save your teaching context and materials, but grounded lesson-plan generation needs a supported catalog.</p> : null}
              {draft.state && draft.grade ? (
                supported ? <fieldset className="first-plan-course"><legend>Course</legend>
                  <label className="sr-only" htmlFor="first-plan-course-search">Search courses</label>
                  <input id="first-plan-course-search" value={courseSearch} onChange={(event) => setCourseSearch(event.target.value)} placeholder="Search your course, e.g. Algebra or AP English" type="search" />
                  {frameworks.isPending ? <p role="status">Loading courses…</p> : frameworks.isError ? <p role="alert">Courses couldn’t load. <button type="button" onClick={() => frameworks.refetch()}>Try again</button></p> : choices.length ? <div className="first-plan-course-options">{choices.map((course) => <label key={course.id} className={draft.subject === course.id ? 'is-selected' : ''}><input type="radio" name="first-course" value={course.id} checked={draft.subject === course.id} onChange={() => update({ subject: course.id })} /><span>{course.label}</span></label>)}</div> : <p>No courses match this grade and search. Try a different name or contact support.</p>}
                </fieldset> : <label className="first-plan-field">Course name<input aria-label="Course name" value={draft.subject} onChange={(event) => update({ subject: event.target.value })} maxLength={120} placeholder="e.g. English Language Arts" required /></label>
              ) : null}
              <details className="first-plan-school" onToggle={(event) => setShowSchool(event.currentTarget.open)}>
                <summary>Use my school’s calendar and format <span>Optional</span></summary>
                <label className="first-plan-field">School<select aria-label="School" value={draft.school} onChange={(event) => update({ school: event.target.value })}><option value={GENERIC_SCHOOL}>Set this up later</option>{(schools.data || []).filter((school) => !draft.state || !school.state || school.state === draft.state).map((school) => <option key={school.id} value={school.id}>{school.name}</option>)}</select></label>
                {schools.isError ? <button type="button" className="btn" onClick={() => schools.refetch()}>Retry schools</button> : null}
                <p>A known school can supply dates and an available format. Otherwise we’ll use week numbers and a neutral layout. You can add a calendar or template in Settings.</p>
              </details>
              {error ? <p className="first-plan-error" role="alert">{error}</p> : null}
              <button className="first-plan-primary" type="submit" disabled={busy || !draft.state || !draft.grade || !draft.subject.trim()}>{busy ? <Loader2 className="animate-spin" size={16} /> : null}{busy ? 'Saving your class…' : 'Continue to my first week'}<ArrowRight size={17} /></button>
            </form>
          ) : (
            <form onSubmit={finish}>
              <button type="button" className="first-plan-back" disabled={busy} onClick={() => { record('step_back', 'preview'); update({ step: 'context' }) }}><ArrowLeft size={15} />Edit your class</button>
              <p className="eyebrow">2 of 2 · Your first week</p>
              <h2 id="first-plan-title" tabIndex={-1} ref={heading}>What are you teaching next?</h2>
              <p className="first-plan-lead">{courseLabel} · {gradeLabel(draft.grade)} grade{schoolLabel ? ` · ${schoolLabel}` : ''}</p>
              <label className="first-plan-field">Teaching week{weeks.length ? <select aria-label="Teaching week" value={weekNumber} onChange={(event) => update({ week: event.target.value })}>{weeks.map((week) => <option value={String(week.week)} key={week.week}>Week {week.week}{week.label || week.week_label ? ` · ${week.label || week.week_label}` : ''}</option>)}</select> : <input aria-label="Teaching week" type="number" min="1" max="53" value={weekNumber} onChange={(event) => update({ week: event.target.value })} required />}</label>
              {calendar.isPending ? <p role="status" className="text-xs text-ink-muted">Checking your teaching weeks…</p> : !weeks.length ? <p className="text-xs text-ink-muted">Plan by week number for now. Add your school calendar in Settings to use its dates.</p> : null}
              {calendar.isError ? <button type="button" className="btn mt-2" onClick={() => calendar.refetch()}>Retry calendar</button> : null}
              <label className="first-plan-field">Topic, text, or skill<textarea aria-label="Topic, text, or skill" rows={4} value={draft.topic} onChange={(event) => update({ topic: event.target.value })} placeholder="For example: comparing the arguments in two speeches, with a short written response on Friday." maxLength={4000} required /></label>
              <p className="text-xs text-ink-muted">A sentence is enough. Include a must-use text or an assessment if you have one.</p>
              <div className="first-plan-proof"><BookOpen size={18} aria-hidden="true" /><div><strong>{sampleSource ? 'A source from your course' : 'A plan you can inspect'}</strong>{sampleSource ? <><p>{sampleSource.code}: {sampleSource.description}</p><small>Example from your catalog. Your topic determines the standards used in the plan.</small></> : <p>Review the daily activities and any available standards citations before teaching.</p>}</div></div>
              <p className="first-plan-output"><FileText size={16} aria-hidden="true" />{supported ? 'You’ll get a first draft to revise and download. Templates and supporting files can come afterward.' : 'Your topic will be kept in the workspace. Plan generation becomes available when your course standards are supported.'}</p>
              {error ? <p className="first-plan-error" role="alert">{error}</p> : null}
              <button className="first-plan-primary" type="submit" disabled={busy || !draft.topic.trim() || calendar.isPending}>{busy ? <Loader2 className="animate-spin" size={16} /> : null}{busy ? 'Opening your workspace…' : supported ? 'Build my first plan' : 'Save my teaching context'}<ArrowRight size={17} /></button>
            </form>
          )}
          <p className="first-plan-saved" role="status">{draftSaved ? 'Your progress is saved on this browser.' : 'Browser storage is unavailable. Keep this page open until you finish.'}</p>
        </section>
      </div>
    </main>
  )
}
