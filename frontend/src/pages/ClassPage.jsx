import { motion, AnimatePresence } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import {
  Check,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  
  BookOpen,
  FileText,
  Loader2,
  
  Plus,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { api } from '../lib/api'
import { GRADES, DEFAULT_GRADE, gradeLabel, gradeSelectValue } from '../lib/grades'

import { useConfirm } from '../lib/confirmContext'
import { useToast } from '../lib/toastContext'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, NavLink, useNavigate, useParams } from 'react-router-dom'
import { qk } from '../lib/queryKeys'
import { useActiveClass, useCalendar } from '../hooks/useAppData'
import { errorParts } from '../lib/apiError'
import { FrameworkPicker } from '../components/FrameworkPicker'
import { SkeletonText } from '../components/Skeleton'
import { PendingCalendarReview } from '../components/PendingCalendarReview'
import { SchoolSelect } from '../components/SchoolSelect'
import { AccountMenu } from '../components/AccountMenu'
import { classColor } from '../lib/classColor'
import { findFramework, verifiedPct } from '../lib/frameworks'
import { shortRange } from '../lib/dates'
import { WEEK_STATUS, weekStatus } from '../lib/weekStatus'
import { unitSuffix } from '../lib/planShape'

/* Your classes.
 *
 * The page this replaces asked for Teacher, Course, Framework and Grade — per
 * class — then scrolled on through a pacing guide, the entire school calendar
 * and a diagnostics table. Three of those four fields said the same thing twice:
 * "11th Grade AP Lang" restates the framework and the grade, and the teacher's
 * name was retyped into every prep.
 *
 * Now: your name once, at the top. A class is two picks and names itself.
 * Everything reference-shaped is collapsed, so the screen ends where the work
 * ends.
 */


export const KIND_LABEL = {
  pacing_guide: 'Pacing guide',
  syllabus: 'Syllabus',
  curriculum_map: 'Curriculum map',
  other: 'Other',
}

/** Framework label without its adoption year — right in a picker, noise in a
 *  class name. */
const shortLabel = (fw, fallback) =>
  fw ? fw.label.split(' (')[0] : String(fallback || '').replace(/_/g, ' ')

/* ── add a class: two picks, inline ─────────────────────────────────────────
   The name is derived and shown so it can be corrected, not demanded up front. */
function ClassSetup({ frameworks, onCreated, onCancel }) {
  const toast = useToast()
  const [subject, setSubject] = useState('')
  const [grade, setGrade] = useState(DEFAULT_GRADE)
  const [saving, setSaving] = useState(false)

  const fw = findFramework(frameworks, subject)
  const preview = fw ? `${shortLabel(fw)} · ${gradeLabel(grade)}` : ''

  const submit = async (e) => {
    e.preventDefault()
    if (!subject) return
    setSaving(true)
    try {
      const created = await api.createClass({ subject, grade })
      toast.success(`Added ${created.name}`)
      onCreated(created)
    } catch (err) {
      toast.apiError('Could not add that class', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex h-full w-full items-center justify-center p-4 sm:p-8">
      <div className="w-full max-w-md">
        <h2 className="mb-6 text-2xl font-semibold tracking-tight text-ink">Set up a new class</h2>
        <form onSubmit={submit} className="flex flex-col gap-6 rounded-2xl bg-paper-sunken p-6 sm:p-8 shadow-sm">
          <div className="flex flex-col gap-2">
            <label htmlFor="new-class-framework" className="text-sm font-medium text-ink">
              Subject
            </label>
            <FrameworkPicker
              frameworks={frameworks}
              value={subject}
              onChange={setSubject}
              id="new-class-framework"
            />
          </div>
          
          <div className="flex flex-col gap-2">
            <label htmlFor="new-class-grade" className="text-sm font-medium text-ink">
              Grade Level
            </label>
            <select
              id="new-class-grade"
              value={grade}
              onChange={(e) => setGrade(e.target.value)}
              className="neo-select neo-inset rounded-xl bg-paper-raised py-3 pl-3 pr-8 text-sm text-ink w-full"
            >
              {GRADES.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
            </select>
          </div>

          <div className="mt-2 flex items-center justify-end gap-3 pt-4 border-t border-edge">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg px-4 py-2.5 text-sm font-medium text-ink-muted transition-colors hover:bg-paper-inset hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!subject || saving}
              className="fa-press neo-raised flex items-center justify-center gap-2 rounded-lg bg-paper-raised px-6 py-2.5 text-sm font-medium text-ink hover:bg-paper-sunken disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : null}
              Create Class
            </button>
          </div>
        </form>
        {preview ? (
          <p className="mt-4 text-center text-sm text-ink-muted">
            Will be called <span className="font-medium text-ink">{preview}</span>
          </p>
        ) : null}
      </div>
    </div>
  )
}

/* ── documents for one class ───────────────────────────────────────────────
   A class holds several: the old table allowed exactly one per framework, so
   uploading a syllabus silently deactivated the pacing guide. */
export function ClassDocuments({ cls, onChanged }) {
  const confirm = useConfirm()
  const toast = useToast()
  const fileRef = useRef(null)
  const [kind, setKind] = useState('pacing_guide')
  const [uploading, setUploading] = useState(false)
  // Removal calls the API then refetches — the row's actual disappearance
  // rides on that refetch's own timing, not a local splice. Same reasoning
  // as PlansPage/HistoryPage's deletingIds: flag it closing the moment
  // it's confirmed (fa-row-exit is already invisible/collapsed well before
  // the refetch lands), only ever cleared on failure.
  const [removingIds, setRemovingIds] = useState(new Set())
  const docs = useQuery({
    queryKey: qk.classDocuments(cls.id),
    queryFn: () => api.listClassDocuments(cls.id),
    retry: false,
  })

  const upload = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true)
    try {
      // classId and kind are what make the upload land where the list reads.
      const res = await api.uploadCurriculumMap(cls.subject, file, { classId: cls.id, kind })
      toast.success(
        `${KIND_LABEL[kind]} saved`,
        res?.weeks_parsed ? `${res.weeks_parsed} weeks read from it.` : undefined
      )
      docs.refetch()
      onChanged?.()
    } catch (err) {
      toast.apiError('Could not read that file', err)
    } finally {
      setUploading(false)
    }
  }

  const removeDoc = async (doc) => {
    const ok = await confirm({
      title: `Remove “${doc.original_name}”?`,
      body: 'Plans already built from it are unaffected.',
      confirmLabel: 'Remove',
      tone: 'danger',
    })
    if (!ok) return
    setRemovingIds((prev) => new Set(prev).add(doc.id))
    try {
      await api.deleteCurriculumMap(doc.id)
      docs.refetch()
      onChanged?.()
    } catch (err) {
      setRemovingIds((prev) => {
        const next = new Set(prev)
        next.delete(doc.id)
        return next
      })
      toast.apiError('Could not remove that document', err)
    }
  }

  const rows = docs.data || []

  return (
    <div className="mt-2 space-y-2">
      {rows.length ? (
        <ul className="neo-inset divide-y divide-edge overflow-hidden rounded-lg bg-paper-sunken">
          {rows.map((d) => (
            <li
              key={d.id}
              className={`flex items-center gap-2.5 px-3 py-2${removingIds.has(d.id) ? ' fa-row-exit' : ''}`}
            >
              <FileText size={14} aria-hidden="true" className="shrink-0 text-ink-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-ink">{d.original_name}</span>
                <span className="text-xs text-ink-muted">
                  {KIND_LABEL[d.kind] || d.kind} · {(d.chars || 0).toLocaleString()} characters
                </span>
              </span>
              <button
                type="button"
                className="btn-icon shrink-0"
                onClick={() => removeDoc(d)}
                aria-label={`Remove ${d.original_name}`}
                title="Remove this document"
              >
                <Trash2 size={13} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : docs.isLoading ? (
        <p className="text-xs text-ink-muted">Loading documents…</p>
      ) : docs.isError ? (
        /* Was indistinguishable from "no documents": rows fell back to [] on
           any error, so a failed request read as an empty class. */
        <p className="text-xs text-mark">
          Couldn’t load documents. {errorParts(docs.error).message}
        </p>
      ) : (
        <p className="text-xs text-ink-muted">
          No documents yet. A pacing guide lets plans follow your own sequence and unit names.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Document type"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className="neo-select neo-inset rounded-lg bg-paper-raised py-1.5 pl-2 pr-7 text-xs text-ink"
        >
          {Object.entries(KIND_LABEL).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="neo-raised inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:text-ink disabled:opacity-50"
        >
          {uploading ? (
            <Loader2 size={13} className="animate-spin" aria-hidden="true" />
          ) : (
            <Upload size={13} aria-hidden="true" />
          )}
          {uploading ? 'Reading…' : 'Add a document'}
        </button>
        <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md,.csv" hidden onChange={upload} />
      </div>
    </div>
  )
}

export function GlobalDocuments() {
  const confirm = useConfirm()
  const toast = useToast()
  const fileRef = useRef(null)
  const [kind, setKind] = useState('pacing_guide')
  const [uploading, setUploading] = useState(false)
  const [removingIds, setRemovingIds] = useState(new Set())
  const docs = useQuery({
    queryKey: ['globalDocuments'],
    queryFn: () => api.listGlobalDocuments(),
    retry: false,
  })

  const upload = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true)
    try {
      const res = await api.uploadCurriculumMap('GLOBAL', file, { isGlobal: true, kind })
      toast.success(
        `${KIND_LABEL[kind]} saved`,
        res?.weeks_parsed ? `${res.weeks_parsed} weeks read from it.` : undefined
      )
      docs.refetch()
    } catch (err) {
      toast.apiError('Could not read that file', err)
    } finally {
      setUploading(false)
    }
  }

  const removeDoc = async (doc) => {
    const ok = await confirm({
      title: `Remove “${doc.original_name}”?`,
      body: 'Plans already built from it are unaffected.',
      confirmLabel: 'Remove',
      tone: 'danger',
    })
    if (!ok) return
    setRemovingIds((prev) => new Set(prev).add(doc.id))
    try {
      await api.deleteCurriculumMap(doc.id)
      docs.refetch()
    } catch (err) {
      setRemovingIds((prev) => {
        const next = new Set(prev)
        next.delete(doc.id)
        return next
      })
      toast.apiError('Could not remove that document', err)
    }
  }

  const rows = docs.data || []

  return (
    <div className="mt-2 space-y-2">
      {rows.length ? (
        <ul className="neo-inset divide-y divide-edge overflow-hidden rounded-lg bg-paper-sunken">
          {rows.map((d) => (
            <li
              key={d.id}
              className={`flex items-center gap-2.5 px-3 py-2${removingIds.has(d.id) ? ' fa-row-exit' : ''}`}
            >
              <FileText size={14} aria-hidden="true" className="shrink-0 text-ink-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-ink">{d.original_name}</span>
                <span className="text-xs text-ink-muted">
                  {KIND_LABEL[d.kind] || d.kind} · {(d.chars || 0).toLocaleString()} characters
                </span>
              </span>
              <button
                type="button"
                className="btn-icon shrink-0"
                onClick={() => removeDoc(d)}
                aria-label={`Remove ${d.original_name}`}
                title="Remove this document"
              >
                <Trash2 size={13} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : docs.isLoading ? (
        <p className="text-xs text-ink-muted">Loading documents…</p>
      ) : docs.isError ? (
        <p className="text-xs text-mark">
          Couldn’t load documents. {errorParts(docs.error).message}
        </p>
      ) : (
        <p className="text-xs text-ink-muted">
          No global documents yet. Upload rubrics or general guidelines here to apply them to all your classes automatically.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Document type"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className="neo-select neo-inset rounded-lg bg-paper-raised py-1.5 pl-2 pr-7 text-xs text-ink"
        >
          {Object.entries(KIND_LABEL).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="neo-raised inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:text-ink disabled:opacity-50"
        >
          {uploading ? (
            <Loader2 size={13} className="animate-spin" aria-hidden="true" />
          ) : (
            <Upload size={13} aria-hidden="true" />
          )}
          {uploading ? 'Reading…' : 'Add a document'}
        </button>
        <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md,.csv" hidden onChange={upload} />
      </div>
    </div>
  )
}

function ClassStandards({ cls }) {
  const toast = useToast()
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef(null)
  
  const standards = useQuery({
    queryKey: ['globalStandards', cls.state, cls.subject, cls.grade],
    queryFn: () => api.getGlobalStandards(cls.state, cls.subject, cls.grade),
    retry: false,
    enabled: !!cls.state,
  })

  if (!cls.state) return null

  const upload = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true)
    try {
      const res = await api.uploadGlobalStandards(cls.state, cls.subject, cls.grade, file)
      toast.success('Standards mapped!', `${res.count} standards extracted.`)
      standards.refetch()
    } catch (err) {
      toast.apiError('Could not map standards from that PDF', err)
    } finally {
      setUploading(false)
    }
  }

  if (standards.isLoading) {
    return (
      <div className="neo-panel mt-4 rounded-xl bg-paper/60 p-4">
        <SkeletonText lines={1} className="w-1/3" />
      </div>
    )
  }

  const list = standards.data?.standards || []

  return (
    <div className="neo-panel mt-4 rounded-xl bg-paper/30 p-4 backdrop-blur-3xl saturate-[1.2] border border-white/5 shadow-inner shadow-white/5">
      <div className="mb-4 flex items-center justify-between border-b border-edge pb-2">
        <div>
          <h2 className="text-sm font-semibold text-ink">{cls.state} Standards</h2>
          <p className="text-xs text-ink-muted">For {cls.subject} · Grade {gradeLabel(cls.grade)}</p>
        </div>
      </div>

      {list.length === 0 ? (
        <div className="rounded-lg border border-dashed border-edge p-6 text-center">
          <FileText className="mx-auto mb-2 text-ink-muted" size={24} />
          <h3 className="text-sm font-medium text-ink">Be the first!</h3>
          <p className="mt-1 text-sm text-ink-muted">
            We don't have the {cls.state} {gradeLabel(cls.grade)} {cls.subject} standards yet. Upload your state's standards PDF, and our AI will map it for everyone.
          </p>
          <input
            type="file"
            accept="application/pdf"
            className="hidden"
            ref={fileRef}
            onChange={upload}
            disabled={uploading}
          />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="fa-press mt-4 inline-flex items-center gap-1.5 rounded-lg bg-paper-raised px-4 py-2 text-sm font-medium text-ink hover:bg-paper-sunken disabled:cursor-not-allowed disabled:opacity-50"
          >
            {uploading ? (
              <><Loader2 size={16} className="animate-spin" /> Mapping PDF...</>
            ) : (
              <><Upload size={16} /> Upload Standards PDF</>
            )}
          </button>
        </div>
      ) : (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
              {list.length} standards mapped
            </span>
          </div>
          <div className="max-h-48 overflow-y-auto rounded border border-edge bg-paper-raised p-2">
            {list.map((s, i) => (
              <div key={i} className="mb-2 last:mb-0 border-b border-edge/50 pb-2 last:border-0 last:pb-0">
                <span className="font-medium text-xs text-ink block">{s.code}</span>
                <span className="text-xs text-ink-muted">{s.description}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/* ── the semester, one row per week ────────────────────────────────────────
   Each week is a project: built or not, in the past or still ahead. This is
   the one thing GET /api/weeks always knew (plan_id, chat_id, is_current,
   is_past — db.week_board) with nowhere on screen it was shown as a whole —
   only two rows of it, on the Greeting screen's "Continue…" suggestions. */
function ClassWeeks({ cls }) {
  const { data: calendar, isLoading, isError } = useCalendar(cls.id)
  const currentRef = useRef(null)
  const weeks = calendar?.weeks || []

  // A school year is ~36 weeks; opening straight to the one that matters
  // beats scrolling from Week 01 every single time.
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'center' })
  }, [weeks.length])

  if (isLoading) return <p className="mt-2 text-xs text-ink-muted">Loading weeks…</p>
  if (isError) return <p className="mt-2 text-xs text-mark">Couldn’t load the calendar.</p>
  // Named, because "no school calendar on file" doesn't tell a teacher which
  // school's is missing — and the fix (add a calendar for THAT school)
  // depends entirely on knowing.
  if (!weeks.length) {
    return (
      <p className="mt-2 text-xs text-ink-muted">
        No calendar on file{calendar?.school?.name ? ` for ${calendar.school.name}` : ''}.
      </p>
    )
  }

  return (
    <ul className="neo-inset mt-2 max-h-72 divide-y divide-edge overflow-y-auto rounded-lg bg-paper-sunken">
      {weeks.map((w) => {
        const status = weekStatus(w)
        const { dot, label } = WEEK_STATUS[status]
        // Built weeks with an orphaned chat_id (written before chat_id was
        // tracked) fall back to plain text — nowhere to send that click.
        const openable = status === 'built' && w.chat_id
        const content = (
          <>
            <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-ink">
                Week {String(w.week).padStart(2, '0')}
                {unitSuffix(w.unit)}
              </span>
              <span className="block text-xs text-ink-muted">
                {/* No calendar on file yet for this school (schoolcal.py's
                    own synthetic weeks carry no start/end) — the status
                    alone, not a bare "· status" with no date before it. */}
                {shortRange(w.start, w.end) ? `${shortRange(w.start, w.end)} · ` : ''}
                {label}
              </span>
            </span>
          </>
        )
        return (
          <li key={w.week} ref={w.is_current ? currentRef : undefined}>
            {openable ? (
              <Link
                to={`/c/${cls.id}/chat/${w.chat_id}`}
                className="flex min-h-touch items-center gap-2.5 px-3 py-2 transition-colors hover:bg-paper-inset"
              >
                {content}
              </Link>
            ) : status === 'closed' || status === 'built' ? (
              // Closed weeks have nothing to open; built-but-orphaned weeks
              // (no chat_id) have a plan but nowhere for this click to go —
              // a "plan this week" link there would claim the week was
              // still open when it's already built.
              <div className="flex min-h-touch items-center gap-2.5 px-3 py-2 opacity-60">{content}</div>
            ) : (
              <Link
                to={`/c/${cls.id}?week=${w.week}`}
                className="flex min-h-touch items-center gap-2.5 px-3 py-2 transition-colors hover:bg-paper-inset"
              >
                {content}
              </Link>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function EditClassSettings({ cls, frameworks, onChanged }) {
  const toast = useToast()
  const [subject, setSubject] = useState(cls.subject)
  const [grade, setGrade] = useState(cls.grade)
  const [saving, setSaving] = useState(false)

  const isChanged = subject !== cls.subject || grade !== cls.grade

  const submit = async (e) => {
    e.preventDefault()
    if (!isChanged) return
    setSaving(true)
    try {
      const updated = await api.updateClass(cls.id, { subject, grade })
      toast.success('Class updated')
      onChanged?.(updated)
    } catch (err) {
      toast.apiError('Could not update class', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label htmlFor="edit-class-framework" className="text-sm font-medium text-ink">
          Subject
        </label>
        <FrameworkPicker
          frameworks={frameworks}
          value={subject}
          onChange={setSubject}
          id="edit-class-framework"
        />
      </div>
      
      <div className="flex flex-col gap-2">
        <label htmlFor="edit-class-grade" className="text-sm font-medium text-ink">
          Grade Level
        </label>
        <select
          id="edit-class-grade"
          value={grade}
          onChange={(e) => setGrade(e.target.value)}
          className="neo-select neo-inset rounded-xl bg-paper-raised py-3 pl-3 pr-8 text-sm text-ink w-full max-w-sm"
        >
          {GRADES.map((g) => (
            <option key={g.value} value={g.value}>
              {g.label}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-2">
        <button
          type="submit"
          disabled={!isChanged || saving}
          className="fa-press neo-raised flex items-center justify-center gap-2 rounded-lg bg-paper-raised px-6 py-2.5 text-sm font-medium text-ink hover:bg-paper-sunken disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : null}
          Save Changes
        </button>
      </div>
    </form>
  )
}

/* ── one class details (Right Pane) ────────────────────────────────────────── */
function ClassDetail({ cls, frameworks, onChanged }) {
  const confirm = useConfirm()
  const toast = useToast()
  const navigate = useNavigate()
  
  const fw = findFramework(frameworks, cls.subject)
  const verified = verifiedPct(fw)

  const remove = async () => {
    const ok = await confirm({
      title: `Remove ${cls.name}?`,
      body: 'Plans you built for it are kept — the class is archived, not deleted.',
      confirmLabel: 'Remove',
      tone: 'danger',
    })
    if (!ok) return
    try {
      await api.deleteClass(cls.id)
      toast.success(`${cls.name} removed`)
      onChanged?.()
      navigate('/', { replace: true })
    } catch (err) {
      toast.apiError('Could not remove that class', err)
    }
  }

  const [activeTab, setActiveTab] = useState('curriculum')

  return (
    <div className="w-full max-w-3xl flex flex-col gap-6 pb-16">
      
      <header className="mb-2">
        <div className="flex items-center gap-3">
          <span
            className="class-dot h-4 w-4 rounded-full"
            aria-hidden="true"
            style={{ '--class-dot-color': `rgb(${classColor(cls.id).rgb})`, backgroundColor: 'var(--class-dot-color)' }}
          />
          <h2 className="text-xl font-semibold text-ink">{cls.name}</h2>
        </div>
      </header>

      <div className="flex gap-6 border-b border-edge">
        <button 
          className={`pb-2 text-sm font-medium border-b-2 transition-colors ${activeTab === 'curriculum' ? 'border-ink text-ink' : 'border-transparent text-ink-muted hover:text-ink'}`}
          onClick={() => setActiveTab('curriculum')}
        >
          Curriculum & Standards
        </button>
        <button 
          className={`pb-2 text-sm font-medium border-b-2 transition-colors ${activeTab === 'history' ? 'border-ink text-ink' : 'border-transparent text-ink-muted hover:text-ink'}`}
          onClick={() => setActiveTab('history')}
        >
          Lesson Plan History
        </button>
        <button 
          className={`pb-2 text-sm font-medium border-b-2 transition-colors ${activeTab === 'settings' ? 'border-mark text-mark' : 'border-transparent text-ink-muted hover:text-ink'}`}
          onClick={() => setActiveTab('settings')}
        >
          Settings
        </button>
      </div>

      {activeTab === 'curriculum' && (
        <div className="flex flex-col gap-8 animate-in fade-in duration-200">
          <section className="flex flex-col gap-4">
            <div className="border-b border-edge pb-2">
              <h3 className="text-sm font-semibold text-ink">Documents</h3>
              <p className="text-xs text-ink-muted">Pacing guides and syllabi used to context-ground your plans.</p>
            </div>
            
            {verified !== null && verified < 100 ? (
              <p className="text-xs text-ink-muted">
                <span className="rounded-full bg-flag-tint px-1.5 py-0.5 font-medium text-flag">
                  {verified}% verified
                </span>{' '}
                of {shortLabel(fw)} word-for-word against the source PDF.
              </p>
            ) : null}
            
            <ClassDocuments cls={cls} onChanged={onChanged} />
            <ClassStandards cls={cls} />
          </section>
        </div>
      )}

      {activeTab === 'history' && (
        <div className="flex flex-col gap-8 animate-in fade-in duration-200">
          <section className="flex flex-col gap-4">
            <div className="border-b border-edge pb-2">
              <h3 className="text-sm font-semibold text-ink">Weeks</h3>
              <p className="text-xs text-ink-muted">School calendar and lesson plan history for this class.</p>
            </div>
            <ClassWeeks cls={cls} />
          </section>
        </div>
      )}

      {activeTab === 'settings' && (
        <div className="flex flex-col gap-8 animate-in fade-in duration-200">
          <section className="flex flex-col gap-4">
            <div className="border-b border-edge pb-2">
              <h3 className="text-sm font-semibold text-ink">Edit Class Details</h3>
              <p className="text-xs text-ink-muted">Change the subject or grade level for this class.</p>
            </div>
            <EditClassSettings cls={cls} frameworks={frameworks} onChanged={onChanged} />
          </section>

          <section className="flex flex-col gap-4 pt-4">
            <div className="border-b border-edge pb-2">
              <h3 className="text-sm font-semibold text-ink">Emergency Tools</h3>
            </div>
            <div>
              <button
                type="button"
                onClick={() => navigate(`/c/${cls.id}/chat/new`, { state: { autoPrompt: "I am sick today. Please generate an emergency 5-minute substitute teacher plan for today's lesson based on the pacing guide.", mode: "sub_plan" } })}
                className="neo-raised inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-paper-sunken"
              >
                Generate 5-Minute Sub Plan
              </button>
            </div>
          </section>

          <section className="flex flex-col gap-4">
            <div className="border-b border-edge pb-2">
              <h3 className="text-sm font-semibold text-mark">Danger Zone</h3>
            </div>
            <div>
              <button
                type="button"
                onClick={remove}
                className="neo-raised inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-mark transition-colors hover:bg-mark-tint"
              >
                <Trash2 size={14} aria-hidden="true" />
                Delete Class
              </button>
            </div>
          </section>
        </div>
      )}

    </div>
  )
}


function DashboardClassRow({ cls, frameworks, selected, onToggle, onUpdate, onNavigate }) {
  const [subject, setSubject] = useState(cls.subject || '')
  const [grade, setGrade] = useState(cls.grade || '')
  const [school, setSchool] = useState(cls.school || '')
  const [saving, setSaving] = useState(false)
  const toast = useToast()

  useEffect(() => {
    setSubject(cls.subject || '')
    setGrade(cls.grade || '')
    setSchool(cls.school || '')
  }, [cls.subject, cls.grade, cls.school])

  const handleUpdate = async (field, value) => {
    if (cls[field] === value) return
    const updateFn = field === 'subject' ? setSubject : field === 'grade' ? setGrade : setSchool
    updateFn(value)
    
    setSaving(true)
    try {
      await api.updateClass(cls.id, { [field]: value })
      onUpdate()
    } catch (err) {
      toast.apiError(`Could not update ${field}`, err)
      updateFn(cls[field])
    } finally {
      setSaving(false)
    }
  }

  return (
    <tr className="transition-colors hover:bg-paper-inset group">
      <td className="px-4 py-3 whitespace-nowrap w-12">
        <label className="flex cursor-pointer items-center">
          <input
            type="checkbox"
            className="sr-only"
            checked={selected}
            onChange={onToggle}
          />
          <div
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors ${
              selected ? 'border-accent bg-accent text-white' : 'border-edge bg-paper'
            }`}
          >
            {selected && <Check size={14} strokeWidth={3} />}
          </div>
        </label>
      </td>
      
      <td className="px-4 py-3 min-w-[150px]">
        <div className="flex items-center gap-2">
          <span
            className="class-dot h-3 w-3 shrink-0 rounded-full"
            aria-hidden="true"
            style={{ '--class-dot-color': `rgb(${classColor(cls.id).rgb})`, backgroundColor: 'var(--class-dot-color)' }}
          />
          <span className="font-semibold text-ink truncate block max-w-[180px]" title={cls.name}>{cls.name}</span>
          {saving && <Loader2 size={12} className="animate-spin text-ink-muted shrink-0" />}
        </div>
      </td>
      
      <td className="px-4 py-3 min-w-[200px] w-1/3">
        <FrameworkPicker
          frameworks={frameworks}
          value={subject}
          onChange={(val) => handleUpdate('subject', val)}
          id={`fw-${cls.id}`}
        />
      </td>
      
      <td className="px-4 py-3 min-w-[120px]">
        <select
          value={grade}
          onChange={(e) => handleUpdate('grade', e.target.value)}
          className="neo-select neo-inset w-full rounded-lg bg-paper-sunken py-2 pl-2.5 pr-8 text-sm text-ink transition-shadow"
        >
          <option value="">Grade</option>
          {GRADES.map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
        </select>
      </td>
      
      <td className="px-4 py-3 min-w-[160px]">
        <SchoolSelect
          value={school}
          onChange={(val) => handleUpdate('school', val)}
        />
      </td>
      
      <td className="px-4 py-3 text-right whitespace-nowrap">
        <button
           onClick={() => onNavigate(cls.id)}
           className="neo-raised inline-flex items-center gap-1.5 rounded-lg bg-paper-raised px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-paper-sunken"
         >
           Manage <ArrowRight size={14} />
        </button>
      </td>
    </tr>
  )
}

function GlobalClassDashboard({ classes, frameworks, onUpdated }) {
  const toast = useToast()
  const navigate = useNavigate()
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [archiving, setArchiving] = useState(false)
  const [showArchived, setShowArchived] = useState(false)

  const activeClasses = classes.filter((c) => !c.archived)
  const archivedClasses = classes.filter((c) => c.archived)
  
  const displayedClasses = showArchived ? archivedClasses : activeClasses

  const toggleSelectAll = () => {
    if (selectedIds.size === displayedClasses.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(displayedClasses.map((c) => c.id)))
    }
  }

  const toggleSelect = (id) => {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelectedIds(next)
  }

  const batchUpdate = async (isArchived) => {
    if (!selectedIds.size) return
    setArchiving(true)
    try {
      await Promise.all(
        Array.from(selectedIds).map((id) => api.updateClass(id, { archived: isArchived }))
      )
      toast.success(isArchived ? 'Classes archived' : 'Classes restored')
      setSelectedIds(new Set())
      onUpdated?.()
    } catch (err) {
      toast.apiError('Could not update classes', err)
    } finally {
      setArchiving(false)
    }
  }

  return (
    <div className="w-full max-w-6xl pb-16">
      <div className="mb-8">
        <h2 className="text-xl font-semibold text-ink border-b border-edge pb-2">Global Documents</h2>
        <GlobalDocuments />
      </div>

      <div className="mb-8 flex items-center justify-between border-b border-edge pb-4">
        <div>
          <h2 className="text-xl font-semibold text-ink">Class Dashboard</h2>
          <p className="text-sm text-ink-muted mt-1">Manage all your classes and assignments from one place.</p>
        </div>
        <div className="flex items-center gap-3">
          {selectedIds.size > 0 && (
            <button
              type="button"
              disabled={archiving}
              onClick={() => batchUpdate(!showArchived)}
              className="neo-raised flex items-center gap-1.5 rounded-lg bg-paper-inset px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-edge disabled:opacity-50"
            >
              {archiving ? <Loader2 size={14} className="animate-spin" /> : showArchived ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
              {showArchived ? 'Restore Selected' : 'Archive Selected'}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
               setShowArchived(!showArchived)
               setSelectedIds(new Set())
            }}
            className="text-sm font-medium text-accent hover:underline bg-accent/10 px-3 py-1.5 rounded-lg"
          >
            {showArchived ? 'View Active Classes' : `View Archived (${archivedClasses.length})`}
          </button>
        </div>
      </div>

      <div className="neo-panel rounded-xl bg-paper/30 backdrop-blur-3xl saturate-[1.2] border border-white/5 shadow-inner shadow-white/5 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-paper-sunken text-xs font-medium uppercase tracking-wider text-ink-muted border-b border-edge">
              <tr>
                <th scope="col" className="px-4 py-3 w-12">
                  <label className="flex cursor-pointer items-center">
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={displayedClasses.length > 0 && selectedIds.size === displayedClasses.length}
                      onChange={toggleSelectAll}
                    />
                    <div
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors ${
                        displayedClasses.length > 0 && selectedIds.size === displayedClasses.length
                          ? 'border-accent bg-accent text-white'
                          : 'border-edge bg-paper'
                      }`}
                    >
                      {displayedClasses.length > 0 && selectedIds.size === displayedClasses.length && (
                        <Check size={14} strokeWidth={3} />
                      )}
                    </div>
                  </label>
                </th>
                <th scope="col" className="px-4 py-3">Class</th>
                <th scope="col" className="px-4 py-3">Subject / Framework</th>
                <th scope="col" className="px-4 py-3">Grade</th>
                <th scope="col" className="px-4 py-3">School</th>
                <th scope="col" className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge">
              {displayedClasses.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-sm text-ink-muted">
                    {showArchived ? 'No archived classes.' : 'No active classes.'}
                  </td>
                </tr>
              ) : (
                displayedClasses.map((c) => (
                  <DashboardClassRow
                    key={c.id}
                    cls={c}
                    frameworks={frameworks}
                    selected={selectedIds.has(c.id)}
                    onToggle={() => toggleSelect(c.id)}
                    onUpdate={onUpdated}
                    onNavigate={(id) => navigate(`/c/${id}`)}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

/* ── Your classes layout (Master-Detail) ──────────────────────────────────── */

export function ClassPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { classes, activeClass, isLoading: classesLoading } = useActiveClass()

  const frameworksState = useQuery({
    queryKey: qk.frameworks,
    queryFn: () => api.getFrameworks(),
    staleTime: Infinity,
  })
  const frameworks = frameworksState.data || []

  const { classId } = useParams()
  const isNew = classId === 'new'
  const reloadClasses = () => qc.invalidateQueries({ queryKey: qk.classes })
  const list = (classes || []).filter(c => !c.archived)

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-paper/30 backdrop-blur-3xl saturate-[1.2] border border-white/5 shadow-inner shadow-white/5">
      
      {/* Left Sidebar (Master) */}
      <div className={`flex w-full md:w-64 shrink-0 flex-col border-r border-edge bg-paper-sunken ${activeClass ? 'hidden md:flex' : ''}`}>
        <header className="flex h-14 shrink-0 items-center gap-2 px-4">
          {/* "/", not `/c/${activeClass?.id}` — this renders while activeClass may
              still be null (nothing selected on mobile yet), and a bare `/c/`
              404s: only `/c/:classId/*` is a registered route. RootRedirect
              resolves "/" to the last-active class (or /welcome with none), so
              it's the one destination that's never broken. */}
          <Link
            to="/"
            aria-label="Back to Chat"
            className="rounded-md p-1.5 text-ink-muted transition-colors hover:bg-paper-inset hover:text-ink"
          >
            <ArrowLeft size={16} aria-hidden="true" />
          </Link>
          <div className="flex items-center gap-1.5">
            <BookOpen size={16} aria-hidden="true" className="text-ink-muted" />
            <h1 className="text-sm font-semibold text-ink">My Classes</h1>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto py-2">
          <div className="px-3 pb-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Your Classes</h2>
          </div>
          
          <nav className="flex flex-col px-2 gap-0.5">
            {list.length ? (
              list.map((c) => {
                const isActive = c.id === activeClass?.id
                return (
                  <Link
                    key={c.id}
                    to={`/c/${c.id}/class`}
                    className={`group flex items-center justify-between min-h-touch rounded-lg px-2 text-sm transition-colors ${
                      isActive 
                        ? 'bg-paper-inset font-medium text-ink' 
                        : 'text-ink-soft hover:bg-paper-inset hover:text-ink'
                    }`}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2.5">
                      <span
                        className="class-dot"
                        aria-hidden="true"
                        style={{ '--class-dot-color': `rgb(${classColor(c.id).rgb})` }}
                      />
                      <span className="truncate">{c.name}</span>
                    </div>
                  </Link>
                )
              })
            ) : classesLoading ? (
              <div className="px-2 py-2">
                <SkeletonText lines={2} />
              </div>
            ) : null}
          </nav>
          <div className="mt-4 px-3">
            <NavLink
              to="/c/new/class"
              onClick={(e) => {
                if (frameworksState.isLoading) e.preventDefault()
              }}
              className={({ isActive }) =>
                `flex min-h-touch w-full items-center gap-2 rounded-lg px-2 text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-paper-inset text-ink'
                    : 'text-ink-muted hover:bg-paper-inset hover:text-ink'
                } ${frameworksState.isLoading ? 'opacity-50 cursor-not-allowed' : ''}`
              }
            >
              <Plus size={14} aria-hidden="true" /> Add a class
            </NavLink>
            {frameworksState.isError ? (
              <p className="mt-2 text-xs text-mark">
                {errorParts(frameworksState.error).hint ||
                  errorParts(frameworksState.error).message}
              </p>
            ) : null}
          </div>
        </div>
        
        <div className="shrink-0 border-t border-edge">
          {/* Every plan this class has ever built, placed at the bottom near account settings. */}
          <NavLink
            to={activeClass ? `/c/${activeClass.id}/plans` : '/c/default/plans'}
            className={({ isActive }) =>
              `flex min-h-touch items-center gap-2.5 px-4 text-sm transition-colors ${
                isActive ? 'text-ink' : 'text-ink-soft hover:text-ink'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <FileText
                  size={15}
                  aria-hidden="true"
                  style={isActive ? { color: 'rgb(var(--rail-pop-rgb))' } : undefined}
                />
                Library
              </>
            )}
          </NavLink>
          <AccountMenu classPath={activeClass ? `/c/${activeClass.id}` : '/c/default'} />
        </div>
      </div>

      {/* Right Content Area (Detail) */}
      <div className={`flex-1 min-w-0 flex flex-col ${!activeClass ? 'hidden md:flex' : ''}`}>
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-edge bg-paper px-4 md:px-8 z-10">
          {/* "/", not "/c" — every route this page's sibling routes live under is
              "/c/:classId/*" (see App.jsx's ClassRoutes), so a bare "/c" was never
              a registered route and 404'd. There's no classless "list" URL to
              return to (the master list on the left IS this same route, just
              hidden on mobile once a class is selected), so "/" — the same
              fallback CommandPalette's "My Classes" already uses — is the
              nearest valid destination rather than inventing a new route. */}
          <Link
            to="/"
            className="md:hidden rounded-md p-1.5 text-ink-muted transition-colors hover:bg-paper-inset hover:text-ink"
            aria-label="Back to class list"
          >
            <ArrowLeft size={16} aria-hidden="true" />
          </Link>
          <div className="text-sm font-medium text-ink-muted">
            {activeClass ? 'Class Configuration' : isNew ? 'Add a class' : ''}
          </div>
        </header>

        {/* The loading skeleton is NOT a keyed child of this AnimatePresence,
            and the first render does not animate in. Both of those were what
            made this whole screen render at 9% opacity and stay there.
            The sequence: classes are loading, so the keyed child is
            'dashboard' and starts its 150ms entrance; the query resolves
            mid-flight; the key flips to the class id; mode="wait" holds the
            incoming child until the outgoing one has EXITED, and the exit
            interrupts an entrance that never finished. The state machine
            settled with opacity frozen at 0.09 — no error, no console
            warning, just a Class Configuration page that was there in the DOM
            (every field, every value) and invisible on screen.
            The skeleton -> content swap was never a transition worth
            animating; only moving BETWEEN classes is. initial={false} is the
            belt to that braces: an entrance animation is the only reason a
            stall here could hide content rather than merely fail to flourish
            it, so the first paint no longer depends on one completing. */}
        <div className="flex-1 overflow-y-auto px-4 md:px-8 py-8 overflow-x-hidden relative">
          {classesLoading && !activeClass ? (
            <div className="w-full max-w-3xl">
              <SkeletonText lines={5} />
            </div>
          ) : (
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={activeClass ? activeClass.id : isNew ? 'new' : 'dashboard'}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.15 }}
                className="w-full"
              >
                {activeClass ? (
                  <ClassDetail cls={activeClass} frameworks={frameworks} onChanged={reloadClasses} />
                ) : isNew ? (
                  <ClassSetup
                    frameworks={frameworks}
                    onCancel={() => navigate('/')}
                    onCreated={async (created) => {
                      await reloadClasses()
                      navigate(`/c/${created.id}/class`)
                    }}
                  />
                ) : (
                  <GlobalClassDashboard classes={classes} frameworks={frameworks} onUpdated={reloadClasses} />
                )}
              </motion.div>
            </AnimatePresence>
          )}
        </div>
      </div>

    </div>
  )
}
