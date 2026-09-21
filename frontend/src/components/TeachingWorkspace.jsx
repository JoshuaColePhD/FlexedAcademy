import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, Check, Clock, History, Loader2, RotateCcw, TriangleAlert } from 'lucide-react'
import { teachingApi } from '../lib/teachingApi'
import { invalidatePlanViews } from '../lib/planQueries'
import { useToast } from '../lib/toastContext'
import { initialDayIndex } from '../lib/planShape'
import { CitedText } from './Citation'
import { useAuth } from '../lib/authContext'
import { displaySourceDocument } from '../lib/displaySourceDocument'
import '../styles/teaching.css'

const reviews = [
  ['alignment', 'The activities and assessment match the learning target'],
  ['materials', 'The readings, links, and materials are ready'],
  ['timing', 'The sequence fits my class period'],
]

function DeliveryForm({ planId, index, revision, record, readOnly, onSaved }) {
  const toast = useToast()
  const [status, setStatus] = useState(record?.outdated ? 'planned' : record?.status || 'planned')
  const [notes, setNotes] = useState(record?.notes || '')
  const [checks, setChecks] = useState(record?.outdated ? {} : record?.review_checks || {})
  const save = useMutation({
    mutationFn: () => teachingApi.saveDay(planId, index, { revision, status, notes, review_checks: checks }),
    onSuccess: () => { onSaved(); toast.success('Teaching notes saved') },
    onError: (error) => toast.apiError('Could not save your notes', error),
  })
  return <form className="teaching-record" onSubmit={(event) => { event.preventDefault(); save.mutate() }}>
    <div className="teaching-section-title"><Check size={17} /><h3>Ready to teach?</h3></div>
    <p className="text-sm text-ink-muted">Your review matters. These checks do not certify instructional quality or student mastery.</p>
    {record?.outdated && <p role="status" className="text-sm text-ink-muted">This lesson changed since your last review. Check the updated plan before saving.</p>}
    <fieldset disabled={readOnly || save.isPending} className="teaching-checks">
      <legend className="sr-only">Review this lesson</legend>
      {reviews.map(([key, label]) => <label key={key}><input type="checkbox" checked={Boolean(checks[key])} onChange={(event) => setChecks({ ...checks, [key]: event.target.checked })} /><span>{label}</span></label>)}
      <label className="teaching-select-label" htmlFor={`delivery-${index}`}>Lesson progress</label>
      <select id={`delivery-${index}`} value={status} onChange={(event) => setStatus(event.target.value)}>
        <option value="planned">Planned</option><option value="taught">Taught</option><option value="assessed">Assessed</option><option value="skipped">Skipped / carry forward</option>
      </select>
      <label className="teaching-select-label" htmlFor={`reflection-${index}`}>What should next week take into account?</label>
      <textarea id={`reflection-${index}`} rows={3} maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="What worked, what needs another lesson, or what you did not get to. Keep student names out of these notes." />
      <button type="submit" className="btn">{save.isPending ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}Save teaching notes</button>
    </fieldset>
    {readOnly && <p className="text-sm text-ink-muted">This demo is read-only. Your own workspace saves progress and reflections.</p>}
  </form>
}

function VersionHistory({ planId, classId, revision, onPlanRevised, readOnly, busy }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [selected, setSelected] = useState(null)
  const versions = useQuery({ queryKey: ['plan-versions', planId], queryFn: ({ signal }) => teachingApi.versions(planId, signal) })
  const restore = useMutation({
    mutationFn: (version) => teachingApi.restore(planId, version.revision, revision),
    onSuccess: (row) => {
      onPlanRevised?.(row)
      invalidatePlanViews(qc, classId)
      qc.invalidateQueries({ queryKey: ['teaching', planId] })
      qc.invalidateQueries({ queryKey: ['plan-versions', planId] })
      qc.invalidateQueries({ queryKey: ['document-status', planId] })
      setSelected(null)
      toast.success('Version restored. The document is being rebuilt.')
    },
    onError: (error) => toast.apiError('Could not restore this version', error),
  })
  if (versions.isPending) return <p role="status">Loading saved versions…</p>
  if (versions.isError) return <div role="alert"><p>Could not load version history.</p><button className="btn" onClick={() => versions.refetch()}>Try again</button></div>
  return <div className="teaching-history">
    <p className="text-sm text-ink-muted">Restoring creates a new saved version. Your current version remains in this history. History begins when version tracking was enabled.</p>
    {(versions.data || []).map((version) => <div key={version.revision} className="teaching-version">
      <button type="button" aria-expanded={selected?.revision === version.revision} onClick={() => setSelected(selected?.revision === version.revision ? null : version)}>
        <History size={16} /><span>Version {version.revision}{version.revision === revision ? ' · current' : ''}</span>
        <time>{new Date(version.saved_at).toLocaleString()}</time>
      </button>
      {selected?.revision === version.revision && <div className="teaching-version-preview">
        {(version.plan_json?.days || []).map((day, index) => <div key={index}><strong>{day.name}</strong><p>{day.learning_targets || (day.no_school ? 'No school' : '')}</p><p>{day.during}</p><p>{day.assessment}</p></div>)}
        {version.revision !== revision && <button type="button" className="btn" disabled={readOnly || busy || restore.isPending} onClick={() => restore.mutate(version)}><RotateCcw size={15} />Restore version {version.revision}</button>}
      </div>}
    </div>)}
  </div>
}

export default function TeachingWorkspace({ plan, planId, classId, subject, state, groundedCodes, onPlanRevised, busy }) {
  const qc = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [tab, setTab] = useState('teach')
  const days = plan?.days || []
  const [active, setActive] = useState(() => initialDayIndex(days, plan?.week_of))
  const workflow = useQuery({ queryKey: ['teaching', planId], queryFn: ({ signal }) => teachingApi.workflow(planId, signal), enabled: Boolean(planId) })
  // Changed content requires a fresh revision number before saving notes/restoring.
  useEffect(() => { qc.invalidateQueries({ queryKey: ['teaching', planId] }); qc.invalidateQueries({ queryKey: ['plan-versions', planId] }) }, [plan, planId, qc])
  const handoff = useMutation({
    mutationFn: () => teachingApi.handoff(planId),
    onSuccess: ({ prompt, week_number: week }) => navigate(`/c/${classId}${week > 0 && week <= 53 ? `?week=${week}` : ''}`, { state: { autoPrompt: prompt, teachingNextWeek: true } }),
    onError: (error) => toast.apiError('Could not prepare next week', error),
  })
  const dayIndex = Math.min(active, Math.max(0, days.length - 1))
  const day = days[dayIndex]
  const record = workflow.data?.days?.find((item) => item.day_index === dayIndex)
  const check = workflow.data?.readiness?.find((item) => item.day_index === dayIndex)
  const readOnly = Boolean(user?.read_only || user?.is_read_only)
  return <div className="teaching-workspace">
    <div className="teaching-toolbar">
      <div className="teaching-tabs" aria-label="Teaching workspace views">
        <button type="button" aria-pressed={tab === 'teach'} onClick={() => setTab('teach')}>Teach this week</button>
        <button type="button" aria-pressed={tab === 'history'} onClick={() => setTab('history')}><History size={15} />Version history</button>
      </div>
      <button type="button" className="btn" disabled={readOnly || busy || handoff.isPending || workflow.isError} onClick={() => handoff.mutate()}>Plan next week <ArrowRight size={15} /></button>
    </div>
    {workflow.isError ? <div className="teaching-notice" role="alert">Teaching records could not load. Your plan is still available.<button type="button" className="btn" onClick={() => workflow.refetch()}>Try again</button></div> : null}
    {tab === 'history' ? (workflow.data ? <VersionHistory planId={planId} classId={classId} revision={workflow.data.revision} onPlanRevised={onPlanRevised} readOnly={readOnly} busy={busy} /> : <p role="status">Loading saved version…</p>) : <>
      <div className="teaching-day-tabs" aria-label="Choose a teaching day">{days.map((item, index) => <button type="button" key={index} aria-pressed={index === dayIndex} onClick={() => setActive(index)}>{item.name}</button>)}</div>
      {day && <article className="teaching-day">
        <div className="teaching-day-heading"><span className="eyebrow">{plan.course}</span><h2>{day.name}</h2><span>{day.no_school ? 'No school' : record?.outdated ? 'Review updated lesson' : record?.status || 'Planned'}</span></div>
        {day.no_school ? <p>No lesson is scheduled for this day.</p> : <>
          <div className="teaching-target"><span className="eyebrow">Learning target</span><p>{day.learning_targets || 'Add a learning target in the document.'}</p></div>
          {check?.explicit_minutes ? <p className="teaching-time"><Clock size={15} />{check.explicit_minutes} minutes explicitly scheduled</p> : null}
          {check?.issues?.length ? <div className="teaching-notice"><TriangleAlert size={18} /><div><strong>Check before teaching</strong><ul>{check.issues.map((issue) => <li key={issue.code}>{issue.message}</li>)}</ul></div></div> : null}
          {(workflow.data?.warnings || []).length ? <details className="teaching-warnings"><summary>Review {workflow.data.warnings.length} plan warning{workflow.data.warnings.length === 1 ? '' : 's'}</summary><ul>{workflow.data.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details> : null}
          <div className="teaching-sequence">{[['Start', 'do_now'], ['Learning sequence', 'during'], ['Check for understanding', 'assessment']].map(([label, key], index) => <section key={key}><span className="teaching-sequence-number">{index + 1}</span><div><h3>{label}</h3><p>{day[key] || 'Add this part of the lesson in the document.'}</p></div></section>)}</div>
          <div className="teaching-standards"><h3>Standards behind this lesson</h3><CitedText text={day.standards || ''} groundedCodes={groundedCodes} subject={subject} state={state} /></div>
          <details className="teaching-warnings">
            <summary>Sources saved with this version</summary>
            {workflow.data?.provenance?.sources?.length ? <>
              <p className="text-sm text-ink-muted">These excerpts were saved when this version was generated. Review their relevance to the lesson above.</p>
              {workflow.data.provenance.sources.map((source, index) => <div className="teaching-version-preview" key={source.id || index}>
                <strong>{source.metadata?.code || source.id}</strong>
                <p>{displaySourceDocument(source.metadata?.source_document || source.metadata?.source)}</p>
                <p>{source.text || source.metadata?.description || 'No excerpt was saved.'}</p>
              </div>)}
            </> : <p className="text-sm text-ink-muted">No source snapshot is available for this older version. You can still inspect its standards above.</p>}
          </details>
          {workflow.data && <DeliveryForm key={`${planId}-${dayIndex}-${workflow.data.revision}-${record?.updated_at || ''}`} planId={planId} index={dayIndex} revision={workflow.data.revision} record={record} readOnly={readOnly || busy} onSaved={() => { qc.invalidateQueries({ queryKey: ['teaching', planId] }); invalidatePlanViews(qc, classId) }} />}
        </>}
      </article>}
    </>}
  </div>
}
