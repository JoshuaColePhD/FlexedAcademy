import { useEffect, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  FileText,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'
import { useConfirm } from '../lib/confirmContext'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { qk } from '../lib/queryKeys'
import { useActiveClass, useCalendar } from '../hooks/useAppData'
import { errorParts } from '../lib/apiError'
import { FrameworkPicker } from '../components/FrameworkPicker'
import { SkeletonText } from '../components/Skeleton'
import { PendingCalendarReview } from '../components/PendingCalendarReview'
import { SchoolSelect } from '../components/SchoolSelect'
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

// 0 is Kindergarten (backend/scripts/01d_ingest_alcos_case.py's own
// grade_from_level() convention — "K" in the CASE feed, 0 in the corpus and
// on the wire) — widened from 9-12 once the K-8 Alabama Course of Study
// standards actually had real chunks behind them (2026-08-17 ingest).
const GRADES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

// Grade is nullable — a class saved before grade was collected has none.
// Number(null) coerces to NaN, so this used to print "NaNth" instead of
// leaving the grade off the label.
function gradeLabel(g) {
  const n = Number(g)
  if (!Number.isFinite(n)) return null
  if (n === 0) return 'K'
  const suffix = n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'
  return `${n}${suffix}`
}

const KIND_LABEL = {
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
function AddClass({ frameworks, onCreated, onCancel }) {
  const toast = useToast()
  const [subject, setSubject] = useState('')
  const [grade, setGrade] = useState('11')
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

  // The accent hairline went with the emboss: a border and a soft shadow
  // describing the same edge read as two outlines, and the tint alone still
  // says "this is the new thing".
  return (
    <form onSubmit={submit} className="neo-panel rounded-xl bg-accent-tint/40 p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <FrameworkPicker
            frameworks={frameworks}
            value={subject}
            onChange={setSubject}
            id="new-class-framework"
          />
        </div>
        <select
          aria-label="Grade"
          value={grade}
          onChange={(e) => setGrade(e.target.value)}
          className="neo-select neo-inset rounded-lg bg-paper-raised py-2.5 pl-2.5 pr-8 text-sm text-ink sm:w-24"
        >
          {GRADES.map((g) => (
            <option key={g} value={g}>
              {gradeLabel(g)}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1">
          <button
            type="submit"
            disabled={!subject || saving}
            className="fa-press neo-raised inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2.5 text-sm font-medium text-ink-inverse hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
            Add
          </button>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel"
            className="neo-raised rounded-lg p-2.5 text-ink-muted transition-colors hover:text-ink"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      </div>
      {preview ? (
        <p className="mt-2 text-xs text-ink-muted">
          Will be called <span className="font-medium text-ink">{preview}</span> — rename it any
          time.
        </p>
      ) : null}
    </form>
  )
}

/* ── documents for one class ───────────────────────────────────────────────
   A class holds several: the old table allowed exactly one per framework, so
   uploading a syllabus silently deactivated the pacing guide. */
function ClassDocuments({ cls, onChanged }) {
  const toast = useToast()
  const confirm = useConfirm()
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
          No documents yet. A pacing guide lets the week board name your units.
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

/* ── one class details (Right Pane) ────────────────────────────────────────── */
function ClassDetail({ cls, frameworks, onChanged }) {
  const toast = useToast()
  const confirm = useConfirm()
  const navigate = useNavigate()
  
  const [name, setName] = useState(cls.name)
  const [editSubject, setEditSubject] = useState(cls.subject)
  const [editGrade, setEditGrade] = useState(cls.grade || '11')
  const [editSchool, setEditSchool] = useState(cls.school || '')
  const [savingDetails, setSavingDetails] = useState(false)
  
  const schoolsState = useQuery({ queryKey: qk.schools, queryFn: () => api.listSchools() })
  const schools = schoolsState.data || []

  useEffect(() => setName(cls.name), [cls.name])
  useEffect(() => {
    setEditSubject(cls.subject)
    setEditGrade(cls.grade || '11')
    setEditSchool(cls.school || '')
  }, [cls.subject, cls.grade, cls.school])

  const fw = findFramework(frameworks, cls.subject)
  const verified = verifiedPct(fw)

  const hasChanges =
    name.trim() !== cls.name ||
    editSubject !== cls.subject ||
    editGrade !== (cls.grade || '11') ||
    editSchool !== (cls.school || '')

  const saveDetails = async () => {
    if (!editSubject) return
    const nextName = name.trim() || cls.name
    setSavingDetails(true)
    try {
      await api.updateClass(cls.id, {
        name: nextName,
        subject: editSubject,
        grade: editGrade,
        ...(editSchool ? { school: editSchool } : {}),
      })
      setName(nextName)
      onChanged?.()
    } catch (err) {
      toast.apiError('Could not update that class', err)
    } finally {
      setSavingDetails(false)
    }
  }

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

  return (
    <div className="mx-auto w-full max-w-3xl flex flex-col gap-10 pb-16">
      
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

      {/* General Settings */}
      <section className="flex flex-col gap-4">
        <div className="border-b border-edge pb-2">
          <h3 className="text-sm font-semibold text-ink">General</h3>
          <p className="text-xs text-ink-muted">Basic details and standards framework for this class.</p>
        </div>
        
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 items-end">
          <label className="block sm:col-span-2 lg:col-span-3">
            <span className="mb-1 block text-xs text-ink-muted">Class Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveDetails()
                if (e.key === 'Escape') setName(cls.name)
              }}
              className="neo-inset w-full rounded-lg bg-paper-raised px-3 py-2.5 text-sm text-ink outline-none focus:ring-1 focus:ring-accent"
            />
          </label>

          <div className="block sm:col-span-2">
            <span className="mb-1 block text-xs text-ink-muted">Subject / Framework</span>
            <FrameworkPicker
              frameworks={frameworks}
              value={editSubject}
              onChange={setEditSubject}
              id={`edit-framework-${cls.id}`}
            />
          </div>

          <label className="block">
            <span className="mb-1 block text-xs text-ink-muted">Grade Level</span>
            <select
              aria-label={`Grade for ${cls.name}`}
              value={editGrade}
              onChange={(e) => setEditGrade(e.target.value)}
              className="neo-select neo-inset w-full rounded-lg bg-paper-raised py-2.5 pl-2.5 pr-8 text-sm text-ink"
            >
              {GRADES.map((g) => (
                <option key={g} value={g}>
                  {gradeLabel(g)}
                </option>
              ))}
            </select>
          </label>
          
          {schools.length > 1 ? (
            <label className="block sm:col-span-2 lg:col-span-3">
              <span className="mb-1 block text-xs text-ink-muted">School</span>
              <SchoolSelect
                ariaLabel={`School for ${cls.name}`}
                schools={schools}
                value={editSchool}
                onChange={setEditSchool}
                className="w-full max-w-xs"
                emptyOption={{ value: '', label: 'Not set — using account default' }}
              />
              {schools.find((s) => s.id === editSchool)?.has_pending_calendar ? (
                <PendingCalendarReview schoolId={editSchool} onDecided={() => schoolsState.refetch()} />
              ) : null}
            </label>
          ) : null}
        </div>

        {hasChanges && (
          <div className="flex items-center gap-2 mt-2">
            <button
              type="button"
              onClick={saveDetails}
              disabled={!editSubject || savingDetails}
              className="fa-press neo-raised inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-ink-inverse hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              {savingDetails ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
              Save Changes
            </button>
            <button
              type="button"
              onClick={() => {
                setName(cls.name)
                setEditSubject(cls.subject)
                setEditGrade(cls.grade || '11')
                setEditSchool(cls.school || '')
              }}
              className="neo-raised rounded-lg px-4 py-2 text-sm font-medium text-ink-muted transition-colors hover:text-ink"
            >
              Cancel
            </button>
          </div>
        )}
      </section>

      {/* Documents */}
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
      </section>

      {/* Weeks */}
      <section className="flex flex-col gap-4">
        <div className="border-b border-edge pb-2">
          <h3 className="text-sm font-semibold text-ink">Weeks</h3>
          <p className="text-xs text-ink-muted">School calendar and lesson plan history for this class.</p>
        </div>
        <ClassWeeks cls={cls} />
      </section>

      {/* Danger Zone */}
      <section className="flex flex-col gap-4 mt-8">
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
  )
}


function GlobalClassDashboard({ classes, onUpdated }) {
  const toast = useToast()
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
    <div className="mx-auto w-full max-w-3xl pb-16">
      <div className="mb-8 flex items-center justify-between border-b border-edge pb-4">
        <div>
          <h2 className="text-lg font-semibold text-ink">Class Management</h2>
          <p className="text-sm text-ink-muted">Batch archive older classes to keep your sidebar clean.</p>
        </div>
        <button
          type="button"
          onClick={() => {
             setShowArchived(!showArchived)
             setSelectedIds(new Set())
          }}
          className="text-sm font-medium text-accent hover:underline"
        >
          {showArchived ? 'View Active Classes' : `View Archived (${archivedClasses.length})`}
        </button>
      </div>

      <div className="neo-panel rounded-xl bg-paper">
        <div className="flex items-center justify-between rounded-t-xl border-b border-edge bg-paper-sunken px-4 py-3">
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={displayedClasses.length > 0 && selectedIds.size === displayedClasses.length}
              onChange={toggleSelectAll}
              className="h-4 w-4 rounded border-edge text-accent focus:ring-accent"
            />
            <span className="text-sm font-medium text-ink-muted">
              {selectedIds.size} selected
            </span>
          </div>
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
        </div>

        <ul className="divide-y divide-edge">
          {displayedClasses.length === 0 ? (
            <li className="px-4 py-8 text-center text-sm text-ink-muted">
              {showArchived ? 'No archived classes.' : 'No active classes.'}
            </li>
          ) : (
            displayedClasses.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-paper-inset">
                <input
                  type="checkbox"
                  checked={selectedIds.has(c.id)}
                  onChange={() => toggleSelect(c.id)}
                  className="h-4 w-4 rounded border-edge text-accent focus:ring-accent"
                />
                <div>
                  <p className="text-sm font-medium text-ink">{c.name}</p>
                  <p className="text-xs text-ink-muted">{c.subject} · Grade {c.grade}</p>
                </div>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  )
}

/* ── Your classes layout (Master-Detail) ──────────────────────────────────── */

export function ClassPage() {
  const toast = useToast()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { classes, activeClass, isLoading: classesLoading } = useActiveClass()

  const frameworksState = useQuery({
    queryKey: qk.frameworks,
    queryFn: () => api.getFrameworks(),
    staleTime: Infinity,
  })
  const frameworks = frameworksState.data || []

  const reloadClasses = () => qc.invalidateQueries({ queryKey: qk.classes })
  const [adding, setAdding] = useState(false)
  const list = (classes || []).filter(c => !c.archived)

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-paper">
      
      {/* Left Sidebar (Master) */}
      <div className="flex w-64 shrink-0 flex-col border-r border-edge bg-paper-sunken">
        <header className="flex h-14 shrink-0 items-center gap-2 px-4">
          <Link
            to={`/c/${activeClass?.id || ''}`}
            aria-label="Back to Chat"
            className="rounded-md p-1.5 text-ink-muted transition-colors hover:bg-paper-inset hover:text-ink"
          >
            <ArrowLeft size={16} aria-hidden="true" />
          </Link>
          <h1 className="text-sm font-semibold text-ink">My Classes</h1>
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
            {adding ? (
              <div className="neo-panel rounded-xl bg-paper p-2">
                <AddClass
                  frameworks={frameworks}
                  onCancel={() => setAdding(false)}
                  onCreated={async (created) => {
                    setAdding(false)
                    await reloadClasses()
                    navigate(`/c/${created.id}/class`)
                  }}
                />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAdding(true)}
                disabled={frameworksState.isLoading}
                className="flex min-h-touch w-full items-center gap-2 rounded-lg px-2 text-sm font-medium text-ink-muted transition-colors hover:bg-paper-inset hover:text-ink disabled:opacity-50"
              >
                <Plus size={14} aria-hidden="true" /> Add a class
              </button>
            )}
            {frameworksState.isError ? (
              <p className="mt-2 text-xs text-mark">
                {errorParts(frameworksState.error).hint ||
                  errorParts(frameworksState.error).message}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {/* Right Content Area (Detail) */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="flex h-14 shrink-0 items-center border-b border-edge bg-paper/80 px-8 backdrop-blur-sm">
          <div className="text-sm font-medium text-ink-muted">
            {activeClass ? 'Class Configuration' : ''}
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-8 py-8">
          {activeClass ? (
            <ClassDetail cls={activeClass} frameworks={frameworks} onChanged={reloadClasses} />
          ) : classesLoading ? (
            <div className="mx-auto w-full max-w-3xl">
              <SkeletonText lines={5} />
            </div>
          ) : (
            <GlobalClassDashboard classes={classes} onUpdated={reloadClasses} />
          )}
        </div>
      </div>

    </div>
  )
}
