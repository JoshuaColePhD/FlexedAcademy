import { SplitLayout } from "../components/SplitLayout"
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import {
  Check,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BookOpen,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  FileText,
  GraduationCap,
  Loader2,
  MapPin,
  Trash2,
  Upload,
  Settings,
  Database,
  Sparkles,
  AlertTriangle,
  Zap,
  Plus,
} from 'lucide-react'
import { api } from '../lib/api'
import { GRADES, DEFAULT_GRADE, gradeLabel, gradeSelectValue } from '../lib/grades'

import { useConfirm } from '../lib/confirmContext'
import { useToast } from '../lib/toastContext'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { qk } from '../lib/queryKeys'
import { useActiveClass, useCalendar } from '../hooks/useAppData'
import { errorParts } from '../lib/apiError'
import { FrameworkPicker } from '../components/FrameworkPicker'
import { ClassSwitcher } from '../components/ClassSwitcher'
import { SkeletonText } from '../components/Skeleton'
import { SchoolSelect } from '../components/SchoolSelect'
import { classColor } from '../lib/classColor'
import { findFramework, verifiedPct } from '../lib/frameworks'

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


import { KIND_LABEL } from '../components/documentKinds'

const ClassDocuments = lazy(() => import('../components/ClassDocuments.jsx').then((module) => ({ default: module.ClassDocuments })))

/** Framework label without its adoption year — right in a picker, noise in a
 *  class name. */
const shortLabel = (fw, fallback) =>
  fw ? fw.label.split(' (')[0] : String(fallback || '').replace(/_/g, ' ')

// Same cap as SettingsPage's account-wide field (backend/routes/classes.py's
// ClassPatch mirrors PATCH /api/me's MeBody).
const CLASS_CUSTOM_INSTRUCTIONS_MAX = 2000

/* The per-class layer on top of the account-wide Custom Instructions field on
 * SettingsPage — same shape (own save button, optimistic update, char
 * counter), scoped to one class instead of every plan on the account. See
 * backend/prompts.py's _class_custom_instructions_block: additive to the
 * global field, not a replacement — a teacher's account-wide preferences
 * still apply here too. */
function ClassCustomInstructions({ cls, onChanged }) {
  const toast = useToast()
  const [text, setText] = useState(cls.custom_instructions || '')
  const [saved, setSaved] = useState(cls.custom_instructions || '')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setText(cls.custom_instructions || '')
    setSaved(cls.custom_instructions || '')
  }, [cls.id, cls.custom_instructions])

  const dirty = text !== saved

  const save = async () => {
    setSaving(true)
    const previousSaved = saved
    setSaved(text)
    try {
      const updated = await api.updateClass(cls.id, { custom_instructions: text })
      toast.success('Saved')
      onChanged?.(updated)
    } catch (err) {
      setSaved(previousSaved)
      toast.apiError('Could not save this class’s instructions', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <h3 className="text-sm font-semibold text-ink">Custom instructions for this class</h3>
      <p className="mt-1 text-xs text-ink-muted">
        On top of your account-wide instructions (Settings), not instead of them — add only
        what's specific to {cls.name}: a tone, a reading level, a format quirk this class needs
        that others don't.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={CLASS_CUSTOM_INSTRUCTIONS_MAX}
        rows={4}
        placeholder="e.g. This is a co-taught section — keep vocabulary concrete and check for understanding often."
        className="neo-inset mt-2 w-full resize-y rounded-lg bg-paper-raised/60 backdrop-blur-2xl px-3 py-2 text-sm text-ink outline-none focus:ring-1 focus:ring-accent"
      />
      <div className="mt-1 flex items-center justify-between">
        <span className="text-2xs text-ink-muted">
          {text.length} / {CLASS_CUSTOM_INSTRUCTIONS_MAX}
        </span>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className="fa-press neo-raised rounded-lg bg-paper-raised px-3 py-2 text-sm font-medium text-ink hover:bg-paper-sunken focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-edge outline-none disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

/* ── add a class ────────────────────────────────────────────────────────────
   A class is defined by its course of study and grade. The generated name is
   previewed so the teacher understands what will be created without typing a
   second, potentially conflicting name. */
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
        <div className="mb-6">
          <p className="eyebrow mb-2">Class management</p>
          <h2 className="text-2xl font-semibold tracking-tight text-ink">Add a class</h2>
          <p className="mt-2 text-sm leading-6 text-ink-muted">
            Choose the course and grade you teach. FlexEd will load the matching standards and name the class for you.
          </p>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-6 rounded-2xl bg-paper-sunken p-6 sm:p-8 shadow-sm">
          <div className="flex flex-col gap-2">
            <label htmlFor="new-class-framework" className="text-sm font-medium text-ink">
              Course of Study
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
              className="neo-select neo-inset w-full rounded-lg bg-paper-raised py-2.5 pl-3 pr-8 text-sm text-ink"
            >
              {GRADES.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
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

function EditClassSettings({ cls, frameworks, onChanged }) {
  const toast = useToast()
  const [subject, setSubject] = useState(cls.subject)
  const [grade, setGrade] = useState(gradeSelectValue(cls.grade))
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setSubject(cls.subject)
    setGrade(gradeSelectValue(cls.grade))
  }, [cls.id, cls.subject, cls.grade])

  const selectedFramework = findFramework(frameworks, subject)
  const courseLabel = selectedFramework ? shortLabel(selectedFramework) : shortLabel(null, subject)
  const generatedName = courseLabel && gradeLabel(grade)
    ? `${courseLabel} · ${gradeLabel(grade)}`
    : courseLabel || cls.name || 'Choose a course of study'
  const isChanged = subject !== cls.subject || grade !== gradeSelectValue(cls.grade)

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
          Course of Study
        </label>
        <p className="text-xs text-ink-muted">
          Choose the course you teach. Its standards and class name update together.
        </p>
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
          className="neo-select neo-inset w-full rounded-lg bg-paper-sunken py-2.5 pl-3 pr-8 text-sm text-ink transition-shadow"
        >
          {GRADES.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-ink-muted">
          This sets the grade-specific standards used for the class.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-ink">Class Name</span>
        <div
          aria-readonly="true"
          className="neo-inset w-full rounded-lg bg-paper-sunken px-3 py-2 text-sm text-ink-muted"
        >
          {generatedName}
        </div>
        <p className="text-xs text-ink-muted">
          The name is generated from the selected course of study and grade.
        </p>
      </div>

      <div className="mt-2">
        <button
          type="submit"
          disabled={!isChanged || saving}
          className="fa-press neo-raised flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-6 py-2.5 text-sm font-medium text-white hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : null}
          Save Changes
        </button>
      </div>
    </form>
  )
}

function ClassStatusItem({ icon: Icon, label, value, detail, tone = 'neutral' }) {
  const toneClasses = {
    ready: 'bg-ok-tint text-ok',
    attention: 'bg-flag-tint text-flag',
    neutral: 'bg-paper-sunken text-ink-muted',
  }

  return (
    <div className="min-w-0 rounded-xl border border-edge/50 bg-paper-raised/55 p-3">
      <div className="flex items-center gap-2">
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${toneClasses[tone] || toneClasses.neutral}`}>
          <Icon size={14} aria-hidden="true" />
        </span>
        <span className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">{label}</span>
      </div>
      <p className="mt-2 truncate text-sm font-semibold text-ink" title={value}>{value}</p>
      <p className="mt-0.5 truncate text-xs text-ink-muted" title={detail}>{detail}</p>
    </div>
  )
}

/* ── one class details (Right Pane) ────────────────────────────────────────── */
function ClassDetail({ cls, classes, frameworks, onChanged }) {
  const confirm = useConfirm()
  const toast = useToast()
  const navigate = useNavigate()

  const fw = findFramework(frameworks, cls.subject)
  const verified = verifiedPct(fw)
  const calendar = useCalendar(cls.id)
  const documents = useQuery({
    queryKey: qk.classDocuments(cls.id),
    queryFn: ({ signal }) => api.listClassDocuments(cls.id, { signal }),
    retry: false,
  })
  const documentRows = documents.data || []
  const hasPacingGuide = documentRows.some((doc) => doc.kind === 'pacing_guide')
  const calendarWeeks = calendar.data?.weeks || []
  const hasCalendar = Boolean(calendar.data && !calendar.isError && calendarWeeks.length)
  const schoolName = calendar.data?.school?.name || cls.school || 'Not set'
  const standardsTone = fw ? 'ready' : 'attention'
  const calendarTone = calendar.isLoading ? 'neutral' : hasCalendar ? 'ready' : 'attention'
  const pacingTone = documents.isLoading ? 'neutral' : hasPacingGuide ? 'ready' : 'attention'

  // Guards a double-click: the button had no disabled state and this had no
  // reentrancy check, so two fast clicks after confirming sent two
  // DELETE /classes/{id}.
  const [removing, setRemoving] = useState(false)
  const remove = async () => {
    if (removing) return
    const ok = await confirm({
      title: `Remove ${cls.name}?`,
      body: 'Plans you built for it are kept — the class is archived, not deleted.',
      confirmLabel: 'Remove',
      tone: 'danger',
    })
    if (!ok) return
    setRemoving(true)
    try {
      await api.deleteClass(cls.id)
      toast.success(`${cls.name} removed`)
      onChanged?.()
      navigate('/', { replace: true })
    } catch (err) {
      toast.apiError('Could not remove that class', err)
      setRemoving(false)
    }
  }

  return (
    <div className="w-full max-w-5xl flex flex-col gap-6">

      <div className="flex flex-col gap-6 fa-rise">
        <section id="section-core" className="scroll-mt-8 rounded-2xl border border-edge/60 bg-paper/45 p-5 shadow-sm backdrop-blur-md md:p-6" aria-labelledby="class-summary-title">
          <div className="flex flex-col gap-4 border-b border-edge/50 pb-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <p className="eyebrow mb-2">Current class</p>
              <div className="flex items-center gap-3">
                <span
                  className="class-dot h-4 w-4 shrink-0 rounded-full"
                  aria-hidden="true"
                  style={{ '--class-dot-color': `rgb(${classColor(cls.id).rgb})`, backgroundColor: 'var(--class-dot-color)' }}
                />
                <h2 id="class-summary-title" className="truncate text-xl font-semibold tracking-tight text-ink">{cls.name}</h2>
              </div>
              <p className="mt-2 max-w-2xl text-sm text-ink-muted">The course context FlexEd uses when you build lesson plans for this class.</p>
            </div>
            <div className="flex w-full shrink-0 items-center gap-2 lg:w-auto">
              <div className="min-w-0 flex-1 lg:w-64 lg:flex-none">
                <ClassSwitcher classes={classes} activeClass={cls} classPath={`/c/${cls.id}`} />
              </div>
              <Link
                to="/c/new/class"
                className="fa-press neo-raised inline-flex min-h-touch shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent/90"
              >
                <Plus size={15} aria-hidden="true" />
                Add class
              </Link>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <ClassStatusItem icon={BookOpen} label="Course" value={shortLabel(fw, cls.subject) || 'Not set'} detail="Course of study" tone={fw ? 'ready' : 'attention'} />
            <ClassStatusItem icon={GraduationCap} label="Grade" value={gradeLabel(gradeSelectValue(cls.grade)) || 'Not set'} detail="Grade level" tone={cls.grade ? 'ready' : 'attention'} />
            <ClassStatusItem icon={MapPin} label="School" value={schoolName} detail={cls.school ? 'Class school' : 'Choose a school'} tone={cls.school ? 'ready' : 'attention'} />
            <ClassStatusItem icon={CheckCircle2} label="Standards" value={fw ? 'Ready' : 'Not set'} detail={fw && verified !== null ? `${verified}% verified` : 'Choose a course'} tone={standardsTone} />
            <ClassStatusItem icon={CalendarDays} label="Calendar" value={calendar.isLoading ? 'Checking…' : hasCalendar ? 'Ready' : 'Not set'} detail={hasCalendar ? `${calendarWeeks.length} weeks loaded` : 'Add in School & Templates'} tone={calendarTone} />
            <ClassStatusItem icon={FileText} label="Pacing guide" value={documents.isLoading ? 'Checking…' : hasPacingGuide ? 'Ready' : 'Not set'} detail={hasPacingGuide ? 'Available to the AI' : 'Upload a guide below'} tone={pacingTone} />
          </div>

          <details className="mt-5 border-t border-edge/50 pt-4">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-ink [&::-webkit-details-marker]:hidden">
              <Settings size={15} aria-hidden="true" className="text-ink-muted" />
              Edit class details
              <ChevronDown size={15} aria-hidden="true" className="ml-auto details-chevron" />
            </summary>
            <div className="mt-4 max-w-2xl rounded-xl border border-edge/50 bg-paper-sunken/35 p-4">
              <EditClassSettings cls={cls} frameworks={frameworks} onChanged={onChanged} />
            </div>
          </details>
        </section>

        <section id="section-docs" className="flex scroll-mt-8 flex-col rounded-2xl border border-edge/60 bg-paper/40 p-5 shadow-sm backdrop-blur-md md:p-6">
          <div className="mb-4 flex flex-col justify-between gap-3 border-b border-edge/50 pb-4 md:flex-row md:items-center">
            <div>
              <div className="flex items-center gap-2">
                <Database size={18} className="text-ink-muted" />
                <h3 className="text-base font-semibold text-ink">Documents for this class</h3>
              </div>
              <p className="mt-1 text-xs text-ink-muted">The source material FlexEd can use when building plans.</p>
            </div>
            {verified !== null && verified < 100 ? (
              <span className="shrink-0 rounded-full bg-flag-tint px-2 py-1 text-[11px] font-medium text-flag">
                {verified}% standards verified
              </span>
            ) : null}
          </div>

          <Suspense fallback={<div className="py-8 text-sm text-ink-muted">Loading documents…</div>}>
            <ClassDocuments cls={cls} onChanged={onChanged} />
          </Suspense>
        </section>

        <section id="section-ai" className="flex scroll-mt-8 flex-col gap-4 rounded-2xl border border-edge/60 bg-paper/40 p-5 shadow-sm backdrop-blur-md md:p-6">
          <div className="flex items-center gap-2 border-b border-edge/50 pb-3">
            <Sparkles size={18} className="text-accent" />
            <div>
              <h3 className="text-base font-semibold text-ink">Class-specific instructions</h3>
              <p className="mt-0.5 text-xs text-ink-muted">Extra guidance for this class only.</p>
            </div>
          </div>
          <ClassCustomInstructions cls={cls} onChanged={onChanged} />
        </section>

        <section id="section-actions" className="rounded-2xl border border-edge/60 bg-paper/35 p-4 shadow-sm backdrop-blur-md scroll-mt-8" aria-labelledby="class-actions-title">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 id="class-actions-title" className="text-sm font-semibold text-ink">Quick actions</h3>
              <p className="mt-1 text-xs text-ink-muted">Start a focused workflow for this class.</p>
            </div>
            <button
              type="button"
              onClick={() => navigate(`/c/${cls.id}/chat/new`, { state: { autoPrompt: "I am sick today. Please generate an emergency 5-minute substitute teacher plan for today's lesson based on the pacing guide.", mode: "sub_plan" } })}
              className="neo-raised inline-flex items-center justify-center gap-2 rounded-lg border border-edge px-3 py-2 text-sm font-medium text-ink shadow-sm transition-colors hover:bg-paper-sunken"
            >
              <Zap size={15} className="text-amber-500" />
              Make a 5-minute sub plan
            </button>
          </div>
        </section>

        <details id="section-danger" className="scroll-mt-8 rounded-2xl border border-mark/20 bg-mark/5 shadow-sm">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 text-sm font-semibold text-mark [&::-webkit-details-marker]:hidden">
            <span className="flex items-center gap-2"><AlertTriangle size={16} aria-hidden="true" /> Danger zone</span>
            <ChevronDown size={16} aria-hidden="true" className="transition-transform details-chevron" />
          </summary>
          <div className="border-t border-mark/15 px-4 pb-4 pt-3">
            <p className="text-sm text-mark/80">Archiving a class hides it from the sidebar, but preserves all associated lesson plans and data.</p>
            <button
              type="button"
              onClick={remove}
              disabled={removing}
              className="neo-raised mt-3 inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-mark transition-colors hover:bg-mark-tint disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Trash2 size={14} aria-hidden="true" />
              Archive class
            </button>
          </div>
        </details>
      </div>
    </div>
  )
}


function DashboardClassRow({ cls, frameworks, schools, selected, onToggle, onUpdate, onNavigate }) {
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
          schools={schools}
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
  const schoolsState = useQuery({
    queryKey: qk.schools,
    queryFn: ({ signal }) => api.listSchools({ signal }),
    staleTime: 5 * 60_000,
  })
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [archiving, setArchiving] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const schools = schoolsState.data || []

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
          <Link
            to="/c/new/class"
            className="fa-press neo-raised inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-accent/90"
          >
            <Plus size={14} aria-hidden="true" />
            Add a class
          </Link>
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
                    schools={schools}
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

const CLASS_TABS = [
  { id: 'core', label: 'Overview' },
  { id: 'ai', label: 'Instructions' },
  { id: 'docs', label: 'Documents' },
  { id: 'danger', label: 'More' },
]

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

  // When no active class or loading, just show the dashboard/setup centered (or we could wrap it in SplitLayout without tabs).
  // But if there is an active class, we use SplitLayout with tabs.
  if (classesLoading && !activeClass) {
    return (
      <div className="flex h-full w-full overflow-hidden bg-transparent items-center justify-center">
        <div className="w-full max-w-3xl flex flex-col py-8 px-8">
          <SkeletonText lines={5} />
        </div>
      </div>
    )
  }

  if (isNew) {
    return (
      <div className="flex h-full w-full overflow-hidden bg-transparent items-center justify-center">
        <div className="w-full max-w-3xl flex flex-col py-8 px-8">
          <ClassSetup
            frameworks={frameworks}
            onCancel={() => navigate('/')}
            /* Navigate FIRST, then refresh the list. This used to await
               reloadClasses() before navigating — and ClassSetup's own
               spinner has already stopped by then (its finally runs when the
               create resolves), so there was a dead window with no indicator
               at all while a full class-list refetch blocked the transition.
               The destination route resolves the list itself; nothing here
               needs to wait for it, and the invalidate still happens. */
            onCreated={(created) => {
              navigate(`/c/${created.id}/class`)
              reloadClasses()
            }}
          />
        </div>
      </div>
    )
  }

  if (!activeClass) {
    return (
      <div className="flex h-full w-full overflow-hidden bg-transparent items-center justify-center">
        <div className="w-full max-w-3xl flex flex-col py-8 px-8">
          <GlobalClassDashboard classes={classes} frameworks={frameworks} onUpdated={reloadClasses} />
        </div>
      </div>
    )
  }

  return (
    <SplitLayout
      title="Class"
      icon={BookOpen}
      tabs={CLASS_TABS}
      backPath="/"
    >
      <ClassDetail cls={activeClass} classes={classes} frameworks={frameworks} onChanged={reloadClasses} />
    </SplitLayout>
  )
}
