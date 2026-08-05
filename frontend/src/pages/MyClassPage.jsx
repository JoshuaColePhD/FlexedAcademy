import { useEffect, useRef, useState } from 'react'
import { Calendar, FileText, Loader2, UploadCloud } from 'lucide-react'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'
import { useConfirm } from '../lib/confirmContext'
import { useAsync } from '../hooks/useAsync'
import { errorParts } from '../lib/apiError'
import { TopBar } from '../components/TopBar'
import { FrameworkPicker } from '../components/FrameworkPicker'
import { Field, Section, inputClass } from '../components/Field'
import { findFramework, verifiedPct } from '../lib/frameworks'
import fhsEvents from '../data/fhs_events.json'

/* Everything about the teacher's class, in the order they need it:
 *
 *   1. Who the plan is for      — goes in the .docx header
 *   2. Which standards           — decides what can be cited
 *   3. The pacing guide          — decides what "next week" means
 *   4. The school calendar       — reference, moved here off the empty state
 *   5. Diagnostics               — last, because it is for Josh, not for them
 *
 * The page used to be titled "Settings" while the nav called it "My Class",
 * and it opened on a form whose first control was a 72-item <select>.
 */

function gradeLabel(g) {
  if (g === 0) return 'Kindergarten'
  const suffix = g === 1 ? 'st' : g === 2 ? 'nd' : g === 3 ? 'rd' : 'th'
  return `${g}${suffix} grade`
}

const FIELDS = ['teacher', 'course', 'subject', 'grade']
const BLANK = { teacher: '', course: '', subject: 'ELA', grade: '11' }

export function MyClassPage({ shell }) {
  const toast = useToast()
  const confirm = useConfirm()
  const { onToggleSidebar, settings, setSettings, settingsError, reloadSettings } = shell
  const [form, setForm] = useState(settings || BLANK)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (settings) setForm(settings)
  }, [settings])

  const [curriculumMap, setCurriculumMap] = useState(null)
  const [mapLoading, setMapLoading] = useState(false)
  const [mapUploading, setMapUploading] = useState(false)
  const [progress, setProgress] = useState(null)
  const fileInputRef = useRef(null)

  const refreshProgress = (subject) =>
    api
      .getCurriculumProgress(subject)
      .then(setProgress)
      .catch(() => setProgress(null))

  useEffect(() => {
    if (!form.subject) return undefined
    let cancelled = false
    setMapLoading(true)
    api
      .getCurriculumMap(form.subject)
      .then((m) => !cancelled && setCurriculumMap(m))
      .catch(() => !cancelled && setCurriculumMap(null))
      .finally(() => !cancelled && setMapLoading(false))
    refreshProgress(form.subject)
    return () => {
      cancelled = true
    }
  }, [form.subject])

  const handleMapFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setMapUploading(true)
    try {
      const result = await api.uploadCurriculumMap(form.subject, file)
      setCurriculumMap(result)
      toast.success(
        'Pacing guide saved',
        `${result.weeks_parsed} week${result.weeks_parsed === 1 ? '' : 's'} read, ` +
          `${result.chunks_embedded} section${result.chunks_embedded === 1 ? '' : 's'} indexed.`
      )
      refreshProgress(form.subject)
    } catch (err) {
      toast.apiError('Could not read that pacing guide', err)
    } finally {
      setMapUploading(false)
    }
  }

  const handleMapDelete = async () => {
    if (!curriculumMap) return
    // window.confirm was the only blocking browser dialog left in the app; the
    // rest of it already had a styled, focus-trapped confirm.
    const ok = await confirm({
      title: `Delete “${curriculumMap.original_name}”?`,
      body: 'Your plans are kept. You can upload the guide again at any time.',
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!ok) return
    try {
      await api.deleteCurriculumMap(curriculumMap.id)
      setCurriculumMap(null)
      setProgress(null)
      toast.success('Pacing guide deleted')
    } catch (err) {
      toast.apiError('Could not delete that pacing guide', err)
    }
  }

  const healthState = useAsync((signal) => api.health({ signal }), [])
  const frameworksState = useAsync((signal) => api.getFrameworks({ signal }), [])
  const health = healthState.data
  const frameworks = frameworksState.data || []
  const selectedFw = findFramework(frameworks, form.subject)
  const grades = selectedFw?.grades || [9, 10, 11, 12]

  const save = async (e) => {
    e.preventDefault()
    setSaving(true)
    try {
      const saved = await api.putSettings({
        teacher: (form.teacher || '').trim(),
        course: (form.course || '').trim(),
        // Not asked for — the settings column is NOT NULL, so it is sent empty.
        period: '',
        subject: (form.subject || '').trim(),
        grade: String(form.grade || '').trim(),
      })
      setSettings(saved)
      toast.success('Saved', 'New plans will use these details.')
    } catch (err) {
      toast.apiError('Could not save', err)
    } finally {
      setSaving(false)
    }
  }

  const dirty = FIELDS.some((k) => (form[k] ?? '') !== (settings?.[k] ?? ''))
  const verified = verifiedPct(selectedFw)

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-paper">
      <TopBar title="My class" collapsed={shell.collapsed} onToggleSidebar={onToggleSidebar} />

      <div className="w-full flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-measure-form px-4 pb-24 pt-6 md:px-8">
          <header>
            <h1 className="text-2xl font-semibold tracking-tight text-ink">My class</h1>
            <p className="mt-1.5 text-ink-muted">These details go on every plan you build.</p>
          </header>

          {settingsError ? (
            <div className="mt-6">
              <div
                className="rounded-xl border border-mark/25 bg-mark-tint p-4"
                role="alert"
              >
                <strong className="block text-sm font-semibold text-mark">
                  Couldn’t load your saved details
                </strong>
                <p className="mt-1 text-sm text-ink-soft">
                  {errorParts(settingsError).hint || errorParts(settingsError).message}
                </p>
                <button
                  type="button"
                  className="mt-2 text-sm font-medium text-mark underline underline-offset-4"
                  onClick={reloadSettings}
                >
                  Try again
                </button>
              </div>
            </div>
          ) : null}

          <form onSubmit={save}>
            <Section label="Your class">
              Printed in the header of the .docx, exactly as you write it here.
            </Section>

            <Field label="Teacher" htmlFor="teacher">
              <input
                id="teacher"
                className={inputClass}
                value={form.teacher}
                onChange={(e) => setForm({ ...form, teacher: e.target.value })}
                placeholder="Mr. Cole"
                required
              />
            </Field>

            <Field label="Course" htmlFor="course">
              <input
                id="course"
                className={inputClass}
                value={form.course}
                onChange={(e) => setForm({ ...form, course: e.target.value })}
                placeholder="11th Grade AP Lang"
                required
              />
            </Field>


            <Section label="Standards" className="mt-10">
              Every standard a plan cites is quoted from this framework rather than recalled from
              memory, and each one traces back to the page it came from. Change it and the next
              plan is written against the new one.
            </Section>

            <Field label="Framework" htmlFor="subject">
              {frameworksState.isError ? (
                <div className="rounded-xl border border-mark/25 bg-mark-tint p-3">
                  <p className="text-sm text-mark">
                    {errorParts(frameworksState.error).hint ||
                      errorParts(frameworksState.error).message}
                  </p>
                  <button
                    type="button"
                    className="mt-2 text-sm font-medium text-mark underline underline-offset-4"
                    onClick={frameworksState.run}
                  >
                    Try again
                  </button>
                </div>
              ) : (
                <FrameworkPicker
                  id="subject"
                  frameworks={frameworks}
                  value={form.subject}
                  disabled={frameworksState.isLoading}
                  onChange={async (subjectId) => {
                    const fw = findFramework(frameworks, subjectId)
                    const grade = fw?.grades?.includes(Number(form.grade))
                      ? form.grade
                      : String(fw?.grades?.[0] ?? '11')
                    setForm((prev) => ({ ...prev, subject: subjectId, grade }))
                    try {
                      const next = await api.getSettings({ subject: subjectId })
                      setForm(next)
                      setSettings(next)
                    } catch (err) {
                      toast.apiError('Could not load saved details for that framework', err)
                    }
                  }}
                />
              )}
            </Field>

            <Field label="Grade" htmlFor="grade">
              <select
                id="grade"
                className={inputClass}
                value={form.grade}
                onChange={(e) => setForm({ ...form, grade: e.target.value })}
              >
                {grades.map((g) => (
                  <option key={g} value={g}>
                    {gradeLabel(g)}
                  </option>
                ))}
              </select>
            </Field>

            {/* Not uniform across frameworks — ELA is 100%, Physical Education
                61% — and a teacher should see that before trusting a plan built
                on one. */}
            {verified !== null && verified < 100 ? (
              <div>
                <div className="marginalia text-sm">
                  <span className="marginalia-title">Worth knowing</span>
                  {verified}% of {selectedFw.label} was verified word-for-word against the source
                  PDF. The rest is from the state’s structured feed and may differ in formatting.
                </div>
              </div>
            ) : null}

            <div className="mt-8 flex flex-wrap items-center gap-4 border-t border-edge pt-6">
              <button
                type="submit"
                disabled={saving || !dirty}
                className="inline-flex min-w-[8rem] items-center justify-center gap-2 rounded-lg bg-ink px-5 py-2.5 text-sm font-medium text-ink-inverse transition-colors hover:bg-ink-soft disabled:cursor-not-allowed disabled:opacity-40"
              >
                {saving ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : null}
                {saving ? 'Saving' : dirty ? 'Save changes' : 'Saved'}
              </button>
              <button
                type="button"
                onClick={() => setForm(settings || BLANK)}
                className={`text-sm font-medium text-ink-muted transition-colors hover:text-ink ${
                  dirty ? 'opacity-100' : 'pointer-events-none opacity-0'
                }`}
              >
                Discard changes
              </button>
            </div>
          </form>

          {/* ── pacing guide ─────────────────────────────────────────────── */}
          <div className="mt-12">
            <Section label="Pacing guide">
              Upload your pacing guide or curriculum map and the app can tell which week comes next
              — and offer it on the start screen.
            </Section>

            <div className="mt-4">
              {mapLoading ? (
                <p className="note py-2">Checking for a saved guide…</p>
              ) : curriculumMap ? (
                <div className="flex flex-col justify-between gap-4 rounded-xl bg-paper-sunken p-4 md:flex-row md:items-center">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="rounded-lg bg-paper-raised p-2">
                      <FileText size={17} className="text-ink-soft" aria-hidden="true" />
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium text-ink">
                        {curriculumMap.original_name}
                      </span>
                      <span className="text-xs text-ink-muted">
                        Uploaded {new Date(curriculumMap.uploaded_at).toLocaleDateString()} ·{' '}
                        {curriculumMap.chars.toLocaleString()} characters
                      </span>
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-4">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={mapUploading}
                      className="text-sm font-medium text-accent-text transition-colors hover:underline disabled:opacity-50"
                    >
                      {mapUploading ? 'Replacing…' : 'Replace'}
                    </button>
                    <button
                      type="button"
                      onClick={handleMapDelete}
                      disabled={mapUploading}
                      className="text-sm font-medium text-mark transition-colors hover:underline disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={mapUploading}
                  className="group flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-edge py-6 text-ink transition-colors hover:border-edge-strong hover:bg-paper-sunken"
                >
                  <UploadCloud
                    size={18}
                    aria-hidden="true"
                    className="text-ink-muted"
                  />
                  <span className="text-sm font-medium">
                    {mapUploading ? 'Uploading…' : 'Upload a pacing guide (.pdf, .docx)'}
                  </span>
                </button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.docx,.txt,.md,.csv"
                hidden
                onChange={handleMapFile}
              />

              {progress?.map && progress.weeks?.length ? (
                <div className="mt-5">
                  <p className="mb-3 text-sm text-ink-soft">
                    {progress.summary?.on_pace ? (
                      <>
                        On pace — {progress.summary.done} of {progress.summary.total} weeks planned.
                      </>
                    ) : (
                      <>
                        <span className="font-medium text-flag">
                          {progress.summary?.behind} week
                          {progress.summary?.behind === 1 ? '' : 's'} past their target date
                        </span>{' '}
                        with no plan yet.
                      </>
                    )}
                  </p>
                  <ul className="divide-y divide-edge overflow-hidden rounded-xl bg-paper-sunken">
                    {progress.weeks.map((w, i) => (
                      <li
                        className="flex items-center justify-between gap-4 p-3 transition-colors hover:bg-paper-inset"
                        key={i}
                      >
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-sm font-medium text-ink">
                            {w.week_label || w.unit || `Row ${i + 1}`}
                          </span>
                          <span className="text-xs text-ink-muted">
                            {w.target_start || '?'} – {w.target_end || '?'}
                          </span>
                        </span>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold tracking-caps ${
                            w.status === 'done'
                              ? 'bg-ok-tint text-ok'
                              : w.status === 'behind'
                                ? 'bg-flag-tint text-flag'
                                : w.status === 'current'
                                  ? 'bg-accent-tint text-accent-text'
                                  : 'text-ink-muted'
                          }`}
                        >
                          {w.status}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : progress?.map ? (
                <p className="note mt-4">
                  The guide is saved, but no week-by-week schedule could be read out of it.
                </p>
              ) : null}
            </div>
          </div>

          {/* ── school calendar — reference, off the start screen ─────────── */}
          <div className="mt-12">
            <Section label="School calendar">
              Florence High School, 2026–2027. Not used when building plans — it’s here so you don’t
              have to go looking for it.
            </Section>
            <div className="mt-4">
              <details className="overflow-hidden rounded-xl bg-paper-sunken">
                <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-medium text-ink transition-colors hover:bg-paper-inset">
                  <Calendar size={15} aria-hidden="true" className="text-ink-muted" />
                  {fhsEvents.length} dates
                </summary>
                <ul className="max-h-72 divide-y divide-edge overflow-y-auto border-t border-edge">
                  {fhsEvents.map((evt, i) => (
                    <li className="flex gap-4 px-4 py-2.5" key={i}>
                      <span className="w-28 shrink-0 text-xs font-semibold tracking-caps text-ink-muted">
                        {evt.date}
                      </span>
                      <span className="text-sm leading-snug text-ink">{evt.event}</span>
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          </div>

          {/* ── diagnostics, last ────────────────────────────────────────── */}
          <div className="mt-12">
            <Section label="Diagnostics">
              For troubleshooting. Nothing here needs your attention day to day.
            </Section>
            <div className="mt-4">
              {healthState.isError ? (
                <div className="flex items-center justify-between gap-4 rounded-xl border border-mark/25 bg-mark-tint p-3">
                  <small className="text-sm font-medium text-mark">
                    Status unavailable — {errorParts(healthState.error).message}
                  </small>
                  <button
                    type="button"
                    className="text-xs font-medium text-mark underline underline-offset-4"
                    onClick={healthState.run}
                  >
                    Try again
                  </button>
                </div>
              ) : !health ? (
                <p className="note">Checking…</p>
              ) : (
                <dl className="grid grid-cols-1 gap-x-8 md:grid-cols-2">
                  {[
                    ['Model', health.model],
                    ['Template', health.builder_template],
                    ['Standards indexed', `${health.chunks} (${health.chroma_count} embedded)`],
                    ['Relevance floor', health.retrieval_floor],
                    ['API key', health.api_key_set ? 'set' : 'missing'],
                  ].map(([k, v]) => (
                    <div
                      className="flex items-center justify-between gap-4 border-b border-dashed border-edge py-2"
                      key={k}
                    >
                      <dt className="text-sm text-ink-muted">{k}</dt>
                      <dd className="truncate font-mono text-xs text-ink">{String(v)}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
