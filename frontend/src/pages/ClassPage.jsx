import { useEffect, useRef, useState } from 'react'
import {
  ArrowDown,
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

const GRADES = [9, 10, 11, 12]

// Grade is nullable — a class saved before grade was collected has none.
// Number(null) coerces to NaN, so this used to print "NaNth" instead of
// leaving the grade off the label.
function gradeLabel(g) {
  const n = Number(g)
  if (!Number.isFinite(n)) return null
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
            className="neo-raised inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2.5 text-sm font-medium text-ink-inverse hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
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
                {shortRange(w.start, w.end)} · {label}
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

/* ── one class ─────────────────────────────────────────────────────────────── */
function ClassRow({ cls, frameworks, isActive, onChanged, onMove, canMoveUp, canMoveDown }) {
  const toast = useToast()
  const confirm = useConfirm()
  const navigate = useNavigate()
  // Which panel is open below the row, if any — mutually exclusive, all
  // toggled the same way "Documents" alone used to be.
  const [panel, setPanel] = useState(null)
  const [name, setName] = useState(cls.name)
  // The framework and grade a class is created with used to be locked in
  // forever — PATCH /api/classes/{id} already accepted subject/grade, the
  // frontend just never sent them. Draft state so Cancel can discard a
  // half-made pick without touching the class until Save commits it.
  const [editSubject, setEditSubject] = useState(cls.subject)
  const [editGrade, setEditGrade] = useState(cls.grade || '11')
  // '' (not cls.school itself) for a class with none set — a class from
  // before migration 25 has no school row value at all, and the account
  // default it currently falls back to (db.class_school) isn't necessarily
  // what the teacher would pick for THIS class specifically, so the select
  // starts genuinely unset rather than silently pre-choosing for them. See
  // its own "not set" option below.
  const [editSchool, setEditSchool] = useState(cls.school || '')
  const [savingDetails, setSavingDetails] = useState(false)
  // Same list the account-level SchoolPicker reads (qk.schools) — one fetch
  // either way, since React Query dedupes by key.
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
  // What POST /api/classes would have named this class. See the row below.
  const grade = gradeLabel(cls.grade)
  const derivedLabel = grade ? `${shortLabel(fw, cls.subject)} · ${grade}` : shortLabel(fw, cls.subject)

  /* One save for the whole panel — name, framework and grade together. The
     name used to commit on its own, on blur, from the row's input; now that
     it's a field in this panel it belongs to this panel's Save, or Cancel
     couldn't honestly discard it.

     An emptied name falls back to the class's current one rather than
     writing blank: the field is pre-filled, so clearing it reads as "start
     over", not "call this class nothing". */
  const saveDetails = async () => {
    if (!editSubject) return
    const nextName = name.trim() || cls.name
    setSavingDetails(true)
    try {
      await api.updateClass(cls.id, {
        name: nextName,
        subject: editSubject,
        grade: editGrade,
        // Omitted entirely, not sent as '', while still "not set" — the
        // backend's ClassPatch treats a present `school` as a real change to
        // validate against the schools table, and '' matches no school id.
        // This also means a school can't be CLEARED back to unset from here,
        // same as name/subject/grade already can't be — consistent, not a
        // new gap.
        ...(editSchool ? { school: editSchool } : {}),
      })
      setName(nextName)
      onChanged?.()
      setPanel(null)
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
      /* Removing the class you are currently IN leaves the URL pointing at a
         class that no longer exists — nothing guards an unknown :classId, so
         the switcher read "Choose a class", the queries kept asking about a
         dead id, and RememberClass had already written it to localStorage.
         Send them back through RootRedirect, which picks a live class or
         onboarding. */
      if (isActive) navigate('/', { replace: true })
    } catch (err) {
      toast.apiError('Could not remove that class', err)
    }
  }

  return (
    <li className="border-b border-edge last:border-b-0">
      {/* flex-wrap + the name's own basis-full below 480px: six fixed-width
          controls (arrows, pencil, Weeks, Documents, trash) sharing one
          non-wrapping row left the name almost no space at phone width —
          "AP Language & Composition" truncated to "AP …" even though nothing
          else on the row was fighting for room a second line couldn't give
          it. Above sm the row is one line exactly as it always was. */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        {/* A check, not a radio. This shows which class you are IN — the URL
            decides that, and the rail switcher is the one control that changes
            it. The radio that used to be here was a second writer of the same
            hidden global, which is how the sidebar and this page could end up
            claiming different active classes. */}
        <span
          aria-hidden={!isActive}
          aria-label={isActive ? 'Currently open' : undefined}
          className={`grid h-5 w-5 shrink-0 place-items-center ${
            isActive ? 'text-ok' : 'text-transparent'
          }`}
        >
          <Check size={13} />
        </span>

        {/* The same per-class colour the rail dot and the artifact rail's own
            tile already use (lib/classColor.js) — this list is the one place
            every class a teacher has sits in a single column, which is
            exactly the "tell two preps apart at a glance" job that palette
            exists for. Decoration, not the only signal: the name is still
            the text right beside it. */}
        <span
          className="class-dot"
          aria-hidden="true"
          style={{ '--class-dot-color': `rgb(${classColor(cls.id).rgb})` }}
        />

        {/* Clicking the name SWITCHES to that class; it no longer edits it.
            It was a bare text input, so the row's most obvious click target
            was a rename nobody was asking for, and the one thing a list of
            classes should do — let you pick one — wasn't on the row at all.
            Renaming moved into the pencil's panel below, alongside the
            framework and grade, which is where "edit this class" already
            lived.

            Points at this same settings route rather than the class root, so
            selecting a class STAYS here. The :classId in the URL is what
            makes a class active (see the check above), so /c/<id>/class
            switches and keeps the page — sending them to /c/<id> would have
            made picking a class in a list also mean leaving the screen they
            were working on. */}
        <Link
          to={`/c/${cls.id}/class`}
          aria-current={isActive ? 'true' : undefined}
          title={isActive ? `${cls.name} — already selected` : `Switch to ${cls.name}`}
          className="min-w-0 basis-full truncate rounded-md px-1.5 py-1 text-sm font-medium text-ink no-underline transition-colors hover:bg-paper-sunken sm:basis-0 sm:flex-1"
        >
          {cls.name}
        </Link>

        {/* Only when it adds something. POST /api/classes auto-names a class
            from exactly these two fields, so an unrenamed class printed
            "AP English Language and Composition · 11th" in the input and then
            again right beside it. The label earns its place the moment the
            teacher renames the class to "3rd period" — and not before. */}
        {cls.name.trim() === derivedLabel ? null : (
          <span className="hidden shrink-0 text-xs text-ink-muted sm:block">{derivedLabel}</span>
        )}

        {/* Left flat on purpose while everything around them was embossed:
            these two are 11px icons stacked with no gap, so a raised shadow
            on each would bleed into the other and read as one smudge. */}
        <div className="flex shrink-0 flex-col">
          <button
            type="button"
            onClick={() => onMove?.(-1)}
            disabled={!canMoveUp}
            aria-label={`Move ${cls.name} up`}
            className="rounded-sm p-0.5 text-ink-faint transition-colors hover:bg-paper-sunken hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
          >
            <ArrowUp size={11} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => onMove?.(1)}
            disabled={!canMoveDown}
            aria-label={`Move ${cls.name} down`}
            className="rounded-sm p-0.5 text-ink-faint transition-colors hover:bg-paper-sunken hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
          >
            <ArrowDown size={11} aria-hidden="true" />
          </button>
        </div>

        <button
          type="button"
          onClick={() => setPanel((p) => (p === 'edit' ? null : 'edit'))}
          aria-expanded={panel === 'edit'}
          aria-label={`Rename ${cls.name} or change its framework and grade`}
          /* Pressed in while its panel is open — the same "selected is
             inset" the rail's active row uses, and it saves these three
             from needing a background tint to say which one is showing. */
          className={`shrink-0 rounded-md p-1.5 text-ink-faint transition-colors hover:text-ink ${
            panel === 'edit' ? 'neo-inset' : 'neo-raised'
          }`}
        >
          <Pencil size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => setPanel((p) => (p === 'weeks' ? null : 'weeks'))}
          aria-expanded={panel === 'weeks'}
          className={`shrink-0 rounded-md px-2 py-1 text-xs font-medium text-ink-muted transition-colors hover:text-ink ${
            panel === 'weeks' ? 'neo-inset' : 'neo-raised'
          }`}
        >
          {panel === 'weeks' ? 'Done' : 'Weeks'}
        </button>
        <button
          type="button"
          onClick={() => setPanel((p) => (p === 'documents' ? null : 'documents'))}
          aria-expanded={panel === 'documents'}
          className={`shrink-0 rounded-md px-2 py-1 text-xs font-medium text-ink-muted transition-colors hover:text-ink ${
            panel === 'documents' ? 'neo-inset' : 'neo-raised'
          }`}
        >
          {panel === 'documents' ? 'Done' : 'Documents'}
        </button>
        <button
          type="button"
          onClick={remove}
          aria-label={`Remove ${cls.name}`}
          className="neo-raised shrink-0 rounded-md p-1.5 text-ink-faint transition-colors hover:bg-mark-tint hover:text-mark"
        >
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </div>

      {panel === 'edit' ? (
        <div className="fa-rise flex flex-col gap-2 px-3 pb-3 pl-10">
          {/* Renaming lives here now, not on the row itself — the row's name
              is how you switch class. Draft state like the two pickers
              beside it, so Cancel discards a half-typed name the same way it
              discards a half-made pick. */}
          <label className="block">
            <span className="mb-1 block text-xs text-ink-muted">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveDetails()
                if (e.key === 'Escape') setName(cls.name)
              }}
              placeholder={derivedLabel}
              className="neo-inset w-full rounded-lg bg-paper-raised px-3 py-2 text-sm text-ink outline-none focus:ring-1 focus:ring-accent"
            />
          </label>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <FrameworkPicker
              frameworks={frameworks}
              value={editSubject}
              onChange={setEditSubject}
              id={`edit-framework-${cls.id}`}
            />
          </div>
          <select
            aria-label={`Grade for ${cls.name}`}
            value={editGrade}
            onChange={(e) => setEditGrade(e.target.value)}
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
              type="button"
              onClick={saveDetails}
              disabled={!editSubject || savingDetails}
              className="neo-raised inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2.5 text-sm font-medium text-ink-inverse hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              {savingDetails ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setName(cls.name)
                setEditSubject(cls.subject)
                setEditGrade(cls.grade || '11')
                setEditSchool(cls.school || '')
                setPanel(null)
              }}
              className="neo-raised rounded-lg px-3 py-2.5 text-sm font-medium text-ink-muted transition-colors hover:text-ink"
            >
              Cancel
            </button>
          </div>
          </div>
          {/* Its own row, not squeezed into the framework/grade one — this
              answers a different question ("which calendar does this class
              follow", migration 25) from those two ("what does it teach").
              Only shown once there's more than one school to actually pick
              between: a solo-school account has nothing here worth asking. */}
          {schools.length > 1 ? (
            <label className="block max-w-xs">
              <span className="mb-1 block text-xs text-ink-muted">School</span>
              <select
                aria-label={`School for ${cls.name}`}
                value={editSchool}
                onChange={(e) => setEditSchool(e.target.value)}
                className="neo-select neo-inset w-full rounded-lg bg-paper-raised py-2 pl-3 pr-8 text-sm text-ink"
              >
                {/* Genuinely absent for a class predating migration 25, not
                    pre-filled with the account default — see editSchool's
                    own comment on why guessing here would be dishonest. */}
                {!editSchool ? (
                  <option value="" disabled>
                    Not set — using account default
                  </option>
                ) : null}
                {schools.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.has_calendar === false ? ' — no calendar yet' : ''}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : panel === 'weeks' ? (
        <div className="fa-rise px-3 pb-3 pl-10">
          <ClassWeeks cls={cls} />
        </div>
      ) : panel === 'documents' ? (
        <div className="fa-rise px-3 pb-3 pl-10">
          {/* Verification is not uniform — ELA is 100%, PE 61% — and it matters
              before trusting a plan built on this framework. */}
          {verified !== null && verified < 100 ? (
            /* A tinted chip on the number, prose around it — the same
               fill/text pair the rail and detail cards use for is-flag, so
               the one number that actually matters here (61%, not 100) is
               what catches the eye first instead of a uniform line of small
               amber text. */
            <p className="mb-2 text-xs text-ink-muted">
              <span className="rounded-full bg-flag-tint px-1.5 py-0.5 font-medium text-flag">
                {verified}% verified
              </span>{' '}
              of {shortLabel(fw)} word-for-word against the source PDF.
            </p>
          ) : null}
          <ClassDocuments cls={cls} onChanged={onChanged} />
        </div>
      ) : null}
    </li>
  )
}

/* Your classes.
 *
 * Reads from the query cache and the URL instead of a `shell` prop. Two things
 * are gone from this page and both were duplicate pathways:
 *
 *   - The active-class radio button. "Which class am I planning for" is the
 *     :classId in the URL now, set by the one switcher in the rail. Two controls
 *     writing one hidden global is what made it possible for the sidebar and
 *     this page to disagree.
 *
 *   - The collapsed "School calendar" list, which rendered src/data/fhs_events
 *     .json — a hardcoded THIRD index of the school year that could silently
 *     contradict the school's own calendar file (backend/context/calendars/),
 *     the one both the prompt and the week board read. Deleted along with the
 *     JSON.
 */
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

  const list = classes || []

  // Writes canonical sort_order values from the list's CURRENT position
  // (index), rather than trusting the two rows' stored values verbatim —
  // classes created before sort_order existed all default to 0, and
  // swapping two equal stored values would do nothing. list's order already
  // came from db.list_classes' own `ORDER BY sort_order, created_at`, so
  // index is a faithful stand-in and self-heals that legacy duplicate case
  // the first time a teacher reorders anything.
  const moveClass = async (index, dir) => {
    const other = list[index + dir]
    const cur = list[index]
    if (!other) return
    try {
      await Promise.all([
        api.updateClass(cur.id, { sort_order: index + dir }),
        api.updateClass(other.id, { sort_order: index }),
      ])
      reloadClasses()
    } catch (err) {
      toast.apiError('Could not reorder your classes', err)
    }
  }

  return (
    <div className="column">
      <header className="flex h-14 shrink-0 items-center px-gutter">
        <h1 className="text-sm font-semibold text-ink">My classes</h1>
      </header>

      <div className="page scroll-y">
        <div className="mx-auto w-full max-w-measure-form">
          {/* ── the classes ─────────────────────────────────────────────── */}
          <div className="mt-5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="text-sm font-semibold text-ink">Your classes</h2>
            {list.length > 1 ? (
              <span className="text-xs text-ink-muted">
                The checked one is what new plans are built for
              </span>
            ) : null}
          </div>

          <ul className="neo-panel mt-2 overflow-hidden rounded-xl bg-paper-raised">
            {list.length ? (
              list.map((c, i) => (
                <ClassRow
                  key={c.id}
                  cls={c}
                  frameworks={frameworks}
                  isActive={c.id === activeClass?.id}
                  onChanged={reloadClasses}
                  onMove={(dir) => moveClass(i, dir)}
                  canMoveUp={i > 0}
                  canMoveDown={i < list.length - 1}
                />
              ))
            ) : classesLoading ? (
              /* Was the empty state. useClasses deliberately has no
                 placeholderData, so a hard refresh here told a teacher with
                 five preps that they had none, for the whole round trip. */
              <li className="px-3 py-4">
                <SkeletonText lines={2} />
              </li>
            ) : (
              <li className="px-3 py-4 text-sm text-ink-muted">
                No classes yet. Add one — its standards framework decides what your plans can cite.
              </li>
            )}
          </ul>

          <div className="mt-2">
            {adding ? (
              <AddClass
                frameworks={frameworks}
                onCancel={() => setAdding(false)}
                onCreated={async (created) => {
                  setAdding(false)
                  await reloadClasses()
                  // Selecting a class is a navigation now, not a setState.
                  navigate(`/c/${created.id}/class`)
                }}
              />
            ) : (
              <button
                type="button"
                onClick={() => setAdding(true)}
                disabled={frameworksState.isLoading}
                className="neo-raised inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-accent transition-colors hover:bg-accent-tint disabled:opacity-50"
              >
                <Plus size={15} aria-hidden="true" /> Add a class
              </button>
            )}
            {frameworksState.isError ? (
              <p className="mt-2 text-xs text-mark">
                {errorParts(frameworksState.error).hint ||
                  errorParts(frameworksState.error).message}
              </p>
            ) : null}
          </div>

          {/* The "School calendar" list that used to sit here rendered
              src/data/fhs_events.json — a hardcoded third copy of the school
              year, alongside the school's own calendar file under
              backend/context/calendars/ (which the prompt quotes and the week
              board reads). Three sources, two of which could drift. The
              year now lives on the calendar page, where it is the point.

              Account-level settings (name, school default, custom
              instructions, password, billing, sign-out-everywhere, delete
              account) moved to SettingsPage.jsx — this page is just the
              class list now, matching the "My classes" link in the account
              menu (AccountMenu.jsx) being a separate item from "Settings". */}
        </div>
      </div>
    </div>
  )
}
