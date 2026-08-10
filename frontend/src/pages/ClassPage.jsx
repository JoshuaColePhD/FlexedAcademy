import { useEffect, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Check,
  CreditCard,
  FileText,
  Loader2,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'
import { useConfirm } from '../lib/confirmContext'
import { useAuth } from '../lib/authContext'
import { useBilling } from '../lib/billingContext'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { qk } from '../lib/queryKeys'
import { useActiveClass, useCalendar } from '../hooks/useAppData'
import { errorParts } from '../lib/apiError'
import { FrameworkPicker } from '../components/FrameworkPicker'
import { SkeletonText } from '../components/Skeleton'
import { findFramework, verifiedPct } from '../lib/frameworks'
import { shortRange } from '../lib/dates'

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

  return (
    <form onSubmit={submit} className="rounded-xl border border-accent/30 bg-accent-tint/40 p-3">
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
          className="rounded-lg border border-edge bg-paper-raised px-2.5 py-2.5 text-sm text-ink outline-none focus:border-accent sm:w-24"
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
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2.5 text-sm font-medium text-ink-inverse transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
            Add
          </button>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel"
            className="rounded-lg p-2.5 text-ink-muted transition-colors hover:bg-paper-sunken hover:text-ink"
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
    try {
      await api.deleteCurriculumMap(doc.id)
      docs.refetch()
      onChanged?.()
    } catch (err) {
      toast.apiError('Could not remove that document', err)
    }
  }

  const rows = docs.data || []

  return (
    <div className="mt-2 space-y-2">
      {rows.length ? (
        <ul className="divide-y divide-edge overflow-hidden rounded-lg bg-paper-sunken">
          {rows.map((d) => (
            <li key={d.id} className="flex items-center gap-2.5 px-3 py-2">
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
          className="rounded-lg border border-edge bg-paper-raised px-2 py-1.5 text-xs text-ink outline-none focus:border-accent"
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
          className="inline-flex items-center gap-1.5 rounded-lg border border-edge px-2.5 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:border-edge-strong hover:bg-paper-sunken hover:text-ink disabled:opacity-50"
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
const WEEK_STATUS = {
  closed: { dot: 'bg-ink-faint', label: 'No school' },
  built: { dot: 'bg-ok', label: 'Built' },
  current: { dot: 'bg-accent', label: 'This week' },
  missed: { dot: 'bg-flag', label: 'Not built' },
  upcoming: { dot: 'bg-ink-faint', label: 'Upcoming' },
}

function weekStatus(w) {
  if (w.no_school) return 'closed'
  if (w.has_plan) return 'built'
  if (w.is_current) return 'current'
  if (w.is_past) return 'missed'
  return 'upcoming'
}

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
  if (!weeks.length) {
    return <p className="mt-2 text-xs text-ink-muted">No school calendar on file.</p>
  }

  return (
    <ul className="mt-2 max-h-72 divide-y divide-edge overflow-y-auto rounded-lg bg-paper-sunken">
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
                {w.unit ? ` — ${w.unit}` : ''}
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

/* ── change password ───────────────────────────────────────────────────────
   Hidden for a Google-only account (no password_hash — see /api/auth/me's
   has_password) rather than shown and left to fail on "current password":
   there's nothing correct to type into that field, and the real recovery
   path for those accounts is the Google button on /login, not this form. */
function ChangePassword() {
  const toast = useToast()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (next.length < 8) {
      toast.error('Use at least 8 characters for the new password.')
      return
    }
    if (next !== confirm) {
      toast.error('Those two don’t match.')
      return
    }
    setSaving(true)
    try {
      await api.changePassword(current, next)
      toast.success('Password changed')
      setCurrent('')
      setNext('')
      setConfirm('')
    } catch (err) {
      toast.apiError('Could not change your password', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="mt-2 flex flex-wrap items-end gap-2">
      <div className="min-w-0 flex-1 basis-40">
        <label className="mb-1 block text-xs text-ink-muted" htmlFor="current-password">
          Current password
        </label>
        <input
          id="current-password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          className="w-full rounded-lg border border-edge bg-paper-raised px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent"
        />
      </div>
      <div className="min-w-0 flex-1 basis-40">
        <label className="mb-1 block text-xs text-ink-muted" htmlFor="new-password-settings">
          New password
        </label>
        <input
          id="new-password-settings"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          className="w-full rounded-lg border border-edge bg-paper-raised px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent"
        />
      </div>
      <div className="min-w-0 flex-1 basis-40">
        <label className="mb-1 block text-xs text-ink-muted" htmlFor="confirm-password-settings">
          Confirm new password
        </label>
        <input
          id="confirm-password-settings"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="w-full rounded-lg border border-edge bg-paper-raised px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent"
        />
      </div>
      <button
        type="submit"
        disabled={saving || !current || !next}
        className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-ink-inverse transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
      >
        {saving ? 'Saving…' : 'Change password'}
      </button>
    </form>
  )
}

function formatRenewal(iso) {
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch {
    return null
  }
}

/* Subscription state and usage, pulled onto the settings page rather than left
 * only in the avatar-menu popover (AccountMenu.jsx) — the same entitlement, the
 * same subscribe()/manage() calls, just room for a usage bar and a renewal
 * date beside them instead of one line in a dropdown. Hidden entirely while
 * billing is unconfigured, same reasoning as AccountMenu's own version. */
function BillingSection() {
  const { entitlement, billingEnabled, openPaywall, manage, busy } = useBilling()

  if (!billingEnabled || !entitlement) return null

  const pct = entitlement.token_cap
    ? Math.min(100, Math.round((entitlement.tokens_used / entitlement.token_cap) * 100))
    : 0
  const renews = entitlement.subscribed && entitlement.period_end ? formatRenewal(entitlement.period_end) : null

  return (
    <div className="mt-5">
      <h2 className="text-sm font-semibold text-ink">Billing</h2>
      <div className="mt-2 rounded-xl border border-edge bg-paper-raised p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium text-ink">
              {entitlement.subscribed ? 'Subscribed' : 'Free'}
            </p>
            {renews ? <p className="text-xs text-ink-muted">Renews {renews}</p> : null}
          </div>
          <button
            type="button"
            onClick={entitlement.subscribed ? manage : openPaywall}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-ink-inverse transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {entitlement.subscribed ? (
              <CreditCard size={14} aria-hidden="true" />
            ) : (
              <Sparkles size={14} aria-hidden="true" />
            )}
            {busy ? 'Opening…' : entitlement.subscribed ? 'Manage subscription' : 'Subscribe'}
          </button>
        </div>

        <div className="mt-3">
          <div className="flex items-center justify-between text-xs text-ink-muted">
            <span>
              {entitlement.tokens_used.toLocaleString()} / {entitlement.token_cap.toLocaleString()} tokens
              this week
            </span>
            {!entitlement.may_generate ? <span className="text-mark">Limit reached</span> : null}
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-paper-sunken">
            <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>
    </div>
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
  const [savingDetails, setSavingDetails] = useState(false)

  useEffect(() => setName(cls.name), [cls.name])
  useEffect(() => {
    setEditSubject(cls.subject)
    setEditGrade(cls.grade || '11')
  }, [cls.subject, cls.grade])

  const fw = findFramework(frameworks, cls.subject)
  const verified = verifiedPct(fw)
  // What POST /api/classes would have named this class. See the row below.
  const grade = gradeLabel(cls.grade)
  const derivedLabel = grade ? `${shortLabel(fw, cls.subject)} · ${grade}` : shortLabel(fw, cls.subject)

  const commitName = async () => {
    const next = name.trim()
    if (!next || next === cls.name) return setName(cls.name)
    try {
      await api.updateClass(cls.id, { name: next })
      onChanged?.()
    } catch (err) {
      toast.apiError('Could not rename that class', err)
      setName(cls.name)
    }
  }

  const saveDetails = async () => {
    if (!editSubject) return
    setSavingDetails(true)
    try {
      await api.updateClass(cls.id, { subject: editSubject, grade: editGrade })
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
      <div className="flex items-center gap-2 px-3 py-2">
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

        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') setName(cls.name)
          }}
          aria-label={`Name of ${cls.name}`}
          className="min-w-0 flex-1 truncate rounded-md bg-transparent px-1.5 py-1 text-sm font-medium text-ink outline-none transition-colors hover:bg-paper-sunken focus:bg-paper-sunken"
        />

        {/* Only when it adds something. POST /api/classes auto-names a class
            from exactly these two fields, so an unrenamed class printed
            "AP English Language and Composition · 11th" in the input and then
            again right beside it. The label earns its place the moment the
            teacher renames the class to "3rd period" — and not before. */}
        {cls.name.trim() === derivedLabel ? null : (
          <span className="hidden shrink-0 text-xs text-ink-muted sm:block">{derivedLabel}</span>
        )}

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
          aria-label={`Edit ${cls.name}’s framework and grade`}
          className="shrink-0 rounded-md p-1.5 text-ink-faint transition-colors hover:bg-paper-sunken hover:text-ink"
        >
          <Pencil size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => setPanel((p) => (p === 'weeks' ? null : 'weeks'))}
          aria-expanded={panel === 'weeks'}
          className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-ink-muted transition-colors hover:bg-paper-sunken hover:text-ink"
        >
          {panel === 'weeks' ? 'Done' : 'Weeks'}
        </button>
        <button
          type="button"
          onClick={() => setPanel((p) => (p === 'documents' ? null : 'documents'))}
          aria-expanded={panel === 'documents'}
          className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-ink-muted transition-colors hover:bg-paper-sunken hover:text-ink"
        >
          {panel === 'documents' ? 'Done' : 'Documents'}
        </button>
        <button
          type="button"
          onClick={remove}
          aria-label={`Remove ${cls.name}`}
          className="shrink-0 rounded-md p-1.5 text-ink-faint transition-colors hover:bg-mark-tint hover:text-mark"
        >
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </div>

      {panel === 'edit' ? (
        <div className="flex flex-col gap-2 px-3 pb-3 pl-10 sm:flex-row sm:items-start">
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
            className="rounded-lg border border-edge bg-paper-raised px-2.5 py-2.5 text-sm text-ink outline-none focus:border-accent sm:w-24"
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
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2.5 text-sm font-medium text-ink-inverse transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              {savingDetails ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setEditSubject(cls.subject)
                setEditGrade(cls.grade || '11')
                setPanel(null)
              }}
              className="rounded-lg px-3 py-2.5 text-sm font-medium text-ink-muted transition-colors hover:bg-paper-sunken"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : panel === 'weeks' ? (
        <div className="px-3 pb-3 pl-10">
          <ClassWeeks cls={cls} />
        </div>
      ) : panel === 'documents' ? (
        <div className="px-3 pb-3 pl-10">
          {/* Verification is not uniform — ELA is 100%, PE 61% — and it matters
              before trusting a plan built on this framework. */}
          {verified !== null && verified < 100 ? (
            <p className="mb-2 text-xs text-flag">
              {verified}% of {shortLabel(fw)} was verified word-for-word against the source PDF.
            </p>
          ) : null}
          <ClassDocuments cls={cls} onChanged={onChanged} />
        </div>
      ) : null}
    </li>
  )
}

/* Sign out of all devices — the one control this needs today. Export/delete
 * land in later work; this section is where they'll join it. */
function AccountSafety() {
  const { signOutEverywhere } = useAuth()
  const confirm = useConfirm()
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const doSignOutEverywhere = async () => {
    const ok = await confirm({
      title: 'Sign out of every device?',
      body: 'This ends every session on every device signed into this account — including this one. You’ll need to log in again here too.',
      confirmLabel: 'Sign out everywhere',
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      await signOutEverywhere()
    } catch (err) {
      toast.apiError('Could not sign out of your other devices', err)
      setBusy(false)
    }
    // On success there is no "finally" to reach — signOutEverywhere() flips
    // auth status to anon, which unmounts this whole page.
  }

  return (
    <div className="mt-5">
      <h2 className="text-sm font-semibold text-ink">Account safety</h2>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-edge bg-paper-raised p-3">
        <div>
          <p className="text-sm font-medium text-ink">Sign out of all devices</p>
          <p className="text-xs text-ink-muted">
            Forgot a shared computer, or think someone else has access? This ends every session at once.
          </p>
        </div>
        <button
          type="button"
          onClick={doSignOutEverywhere}
          disabled={busy}
          className="shrink-0 rounded-lg px-3 py-2 text-sm font-medium text-mark transition-colors hover:bg-mark-tint disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Signing out…' : 'Sign out everywhere'}
        </button>
      </div>
    </div>
  )
}

/* For whoever is debugging the app, not for a teacher planning a week — and it
   is a teacher who was being shown the model name, the plans directory, the
   builder's path on disk and whether the API key is set. "Shut by default" is
   not the same as "not there".

   Dev builds only. In production the same payload is one authenticated curl of
   /api/health, which is where a person debugging the app actually is; the
   unauthenticated answer is now liveness alone (see routes/misc.py). */
function Diagnostics() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => api.health(),
    retry: false,
    enabled: import.meta.env.DEV,
  })
  const h = health.data

  if (!import.meta.env.DEV) return null

  return (
    <details className="mt-2 overflow-hidden rounded-xl border border-edge">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-paper-sunken">
        Diagnostics
      </summary>
      <div className="border-t border-edge px-3 py-2">
        {health.isError ? (
          <p className="text-sm text-mark">{errorParts(health.error).message}</p>
        ) : !h ? (
          <p className="text-sm text-ink-muted">Checking…</p>
        ) : (
          <dl className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
            {[
              ['Model', h.model],
              ['Template', h.builder_template],
              ['Standards indexed', h.chunks],
              ['Relevance floor', h.retrieval_floor],
              ['Database', h.database],
              ['API key', h.api_key_set ? 'set' : 'missing'],
            ].map(([k, v]) => (
              <div className="flex items-center justify-between gap-3 py-1" key={k}>
                <dt className="text-xs text-ink-muted">{k}</dt>
                <dd className="truncate font-mono text-xs text-ink">{String(v)}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </details>
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
 *     contradict school_calendar.md, the file both the prompt and the week board
 *     read. Deleted along with the JSON.
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

  const meState = useQuery({ queryKey: qk.me, queryFn: () => api.me() })
  const reloadClasses = () => qc.invalidateQueries({ queryKey: qk.classes })

  const [adding, setAdding] = useState(false)
  const [teacher, setTeacher] = useState('')
  const [savedName, setSavedName] = useState('')

  // users.name is where the teacher's name lives now.
  useEffect(() => {
    const n = meState.data?.name || ''
    setTeacher(n)
    setSavedName(n)
  }, [meState.data])

  const commitTeacher = async () => {
    const next = teacher.trim()
    if (!next || next === savedName) return setTeacher(savedName)
    try {
      await api.updateMe(next)
      setSavedName(next)
      toast.success('Saved')
      qc.invalidateQueries({ queryKey: qk.me })
    } catch (err) {
      toast.apiError('Could not save your name', err)
      setTeacher(savedName)
    }
  }

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
          {/* ── your name, once ─────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <label htmlFor="teacher" className="text-sm text-ink-muted">
              Plans are signed
            </label>
            <input
              id="teacher"
              value={teacher}
              onChange={(e) => setTeacher(e.target.value)}
              onBlur={commitTeacher}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') setTeacher(savedName)
              }}
              placeholder="Mr. Cole"
              className="min-w-0 flex-1 rounded-md bg-transparent px-1.5 py-1 text-sm font-medium text-ink outline-none transition-colors placeholder:text-ink-faint hover:bg-paper-sunken focus:bg-paper-sunken"
            />
          </div>

          {/* ── password ─────────────────────────────────────────────────── */}
          {meState.data && meState.data.has_password ? (
            <div className="mt-5">
              <h2 className="text-sm font-semibold text-ink">Password</h2>
              <ChangePassword />
            </div>
          ) : meState.data ? (
            <p className="mt-5 text-xs text-ink-muted">
              This account signs in with Google — there’s no password to change here.
            </p>
          ) : null}

          {/* ── billing ──────────────────────────────────────────────────── */}
          <BillingSection />

          {/* ── the classes ─────────────────────────────────────────────── */}
          <div className="mt-5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="text-sm font-semibold text-ink">Your classes</h2>
            {list.length > 1 ? (
              <span className="text-xs text-ink-muted">
                The checked one is what new plans are built for
              </span>
            ) : null}
          </div>

          <ul className="mt-2 overflow-hidden rounded-xl border border-edge bg-paper-raised">
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
                className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-accent transition-colors hover:bg-accent-tint disabled:opacity-50"
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
              year, alongside school_calendar.md (which the prompt quotes and the
              week board reads). Three sources, two of which could drift. The
              year now lives on the calendar page, where it is the point. */}

          <AccountSafety />

          <Diagnostics />
        </div>
      </div>
    </div>
  )
}
