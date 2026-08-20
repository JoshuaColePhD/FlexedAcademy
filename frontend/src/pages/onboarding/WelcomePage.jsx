import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Loader2, Upload } from 'lucide-react'
import { api } from '../../lib/api'
import { qk } from '../../lib/queryKeys'
import { useAuth } from '../../lib/authContext'
import { useToast } from '../../lib/toastContext'
import { FrameworkPicker } from '../../components/FrameworkPicker'
import { CalendarPreview } from '../../components/CalendarPreview'
import { SchoolSelect } from '../../components/SchoolSelect'
/* The one grade vocabulary. This file used to declare its own copy, with a
   comment explaining that the VALUE and the LABEL must stay apart because
   sending '11th' where '11' belongs made the first class a teacher ever
   created render as 'AP Language & Composition · NaNth'. The comment was
   right and the duplication is what let the same mistake survive in two
   other copies — see lib/grades.js and migration 38. */

/* A REAL, working school id with NO real calendar behind it on purpose —
 * backend/schoolcal.py's own NO_CALENDAR_SCHOOL_ID returns week NUMBERS
 * only (Week 1, Week 2, ... no dates attached to any of them), so picking
 * this finishes onboarding and lets a teacher plan by week number instead
 * of stopping short. Not gated behind a `schools` table row: school_weeks()
 * /calendar_context() (backend/schoolcal.py, prompts.py) special-case this
 * id directly, and users.school isn't validated against that table either —
 * it only feeds the picker's OWN list and a display name, neither of which
 * this hardcoded option needs.
 *
 * Before this existed, a teacher at any school besides the one curated one
 * hit a real dead end here: get stuck, or pick a school that wasn't theirs
 * and silently generate against its calendar and holidays instead. This
 * unblocks them today with honest "no date" weeks rather than another
 * school's real dates wearing this teacher's name — which is exactly why
 * the nudge below asks for their real calendar, so their actual school can
 * replace this placeholder the same way the one curated school was added. */
const GENERIC_SCHOOL = 'generic'

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


export function WelcomePage() {
  const { user, refresh } = useAuth()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()

  const [name, setName] = useState(user?.name || '')
  const [school, setSchool] = useState(user?.school || '')
  const [subject, setSubject] = useState('')
  const [saving, setSaving] = useState(false)

  const { data: frameworks = [] } = useQuery({
    queryKey: qk.frameworks,
    queryFn: () => api.getFrameworks(),
    staleTime: Infinity,
  })
  const { data: schools = [] } = useQuery({
    queryKey: qk.schools,
    queryFn: () => api.listSchools(),
    staleTime: Infinity,
  })

  const usingGeneric = school === GENERIC_SCHOOL

  // Uploading a real calendar switches `school` away from GENERIC_SCHOOL to
  // the newly created/matched school's own id (calSubmission.school.id) —
  // so finishing onboarding stamps the account with a real, pending
  // calendar instead of the dateless fallback it started on.
  const [calSchoolName, setCalSchoolName] = useState('')
  const [calFile, setCalFile] = useState(null)
  const [calUrl, setCalUrl] = useState('')
  const [calUploading, setCalUploading] = useState(false)
  const [calSubmission, setCalSubmission] = useState(null)
  const calFileRef = useRef(null)

  const [templateFile, setTemplateFile] = useState(null)
  const templateFileRef = useRef(null)


  const uploadCalendar = async (e) => {
    e.preventDefault()
    if (!calSchoolName.trim()) {
      toast.error('Name your school first', "We'll need something to call it.")
      return
    }
    if (!calFile && !calUrl.trim()) {
      toast.error('Add a file or a link', 'Upload the calendar, or paste a link to it.')
      return
    }
    setCalUploading(true)
    try {

      const res = await api.uploadSchoolCalendar(calSchoolName.trim(), {
        file: calFile || undefined,
        sourceUrl: calUrl.trim() || undefined,
      })
      if (templateFile) {
        await api.uploadSchoolTemplate(res.school.id, { file: templateFile })
      }

      setCalSubmission(res)
      setSchool(res.school.id)
      qc.invalidateQueries({ queryKey: qk.schools })
      toast.success(
        'Calendar submitted',
        'Pending confirmation from a colleague at your school — you can use it right away.'
      )
    } catch (err) {
      toast.apiError('Could not read that calendar', err)
    } finally {
      setCalUploading(false)
    }
  }

  const submit = async (e) => {
    e.preventDefault()
    if (!school) {
      toast.error('Pick a school first', 'It decides which calendar your plans are built against.')
      return
    }
    if (!subject) {
      toast.error('Pick a course first', 'It decides which standards your plans are grounded in.')
      return
    }
    setSaving(true)
    try {
      // Combined into one call, not two: api.updateMe takes an object
      // ({name, customInstructions, school}) and destructures it — passing
      // a bare string here (the old code) sent `name: undefined`, so the
      // name field has silently never saved.
      const patch = {}
      if (name.trim() && name.trim() !== user?.name) patch.name = name.trim()
      if (school !== user?.school) patch.school = school
      if (Object.keys(patch).length) await api.updateMe(patch)
      const created = await api.createClass({ subject })
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

  /* h-app, not min-h-app: index.html's <body> is overflow-hidden — every
     page has to make its OWN content scrollable rather than relying on
     document scroll, same reasoning as AuthLayout.jsx. Without max-h-full
     + overflow-y-auto on the form itself, this card had no ceiling on its
     own height, so a tall form (the "school isn't listed" panel expanded)
     just clipped silently against the body's hard edge with no scrollbar
     and no way to reach the rest of it. */
  return (
    <div className="flex h-app w-full items-center justify-center bg-paper p-gutter">
      <form
        onSubmit={submit}
        className="flex max-h-full w-full max-w-measure-form flex-col gap-7 overflow-y-auto rounded-2xl border border-edge bg-paper-raised p-8 md:p-10"
      >
        <div>
          <h1 className="text-2xl font-semibold tracking-display text-ink">Let’s set up your year</h1>
          <p className="mt-1.5 text-sm text-ink-muted">
            A few things, then your calendar is ready. You can add more classes later.
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

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-ink">Which school is this for?</span>
          <span className="text-xs text-ink-muted">
            Sets your school calendar — which weeks are teaching weeks and which days are closed.
          </span>
          <SchoolSelect
            ariaLabel="School"
            id="welcome-school"
            schools={schools}
            value={school}
            onChange={setSchool}
            genericValue={GENERIC_SCHOOL}
            emptyOption={{ value: '', label: 'Choose a school' }}
            inputClassName="mt-1 min-h-touch w-full rounded-lg border border-edge bg-paper py-2.5 pl-3.5 pr-8 text-sm text-ink outline-none focus:border-accent"
          />
        </label>

        {/* Doesn't block anything below it — this is a real, working
            choice (see its own comment above), just a dateless one until
            a calendar is uploaded and submitted below. */}
        {usingGeneric ? (
          <div className="rounded-lg border border-edge bg-paper-sunken p-4 text-sm text-ink-soft">
            {calSubmission ? (
              <div className="flex flex-col gap-2">
                <p>
                  <span className="font-medium text-ink">{calSubmission.school.name}</span> submitted —
                  pending confirmation from a colleague at your school. You can plan against it right
                  away in the meantime.
                </p>
                <CalendarPreview weeks={calSubmission.submission.weeks} />
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <p>
                  You can still plan by week number — Week 1, Week 2, and so on — but there's no real
                  calendar behind it yet. Upload your school's real teaching calendar (a PDF, a Word
                  doc, or a link to where it's published) and we'll parse it — a colleague at your
                  school can then confirm it's right.
                </p>
                <input
                  type="text"
                  value={calSchoolName}
                  onChange={(e) => setCalSchoolName(e.target.value)}
                  placeholder="Your school's name"
                  aria-label="Your school's name"
                  className="rounded-lg border border-edge bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-accent"
                />
                <input
                  type="url"
                  value={calUrl}
                  onChange={(e) => setCalUrl(e.target.value)}
                  placeholder="Or paste a link to your district's published calendar"
                  aria-label="Link to your district's published calendar"
                  className="rounded-lg border border-edge bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-accent"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => calFileRef.current?.click()}
                    className="neo-raised inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:text-ink"
                  >
                    <Upload size={13} aria-hidden="true" />
                    {calFile ? calFile.name : 'Choose a file'}
                  </button>
                  <input
                    ref={calFileRef}
                    type="file"
                    accept=".pdf,.docx,.txt,.md"
                    hidden
                    onChange={(e) => setCalFile(e.target.files?.[0] || null)}
                  />
                  <button
                    type="button"
                    onClick={uploadCalendar}
                    disabled={calUploading}
                    className="btn inline-flex items-center gap-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {calUploading ? (
                      <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                    ) : null}
                    {calUploading ? 'Reading…' : 'Submit calendar'}
                  </button>
                </div>
                <div className="mt-2 pt-4 border-t border-edge flex flex-col gap-3">
                  <p>
                    <strong>Lesson Plan Template:</strong> If your school has a specific format for lesson plans (e.g. a blank Word Doc), upload it here. We will train our AI to export to your exact format!
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => templateFileRef.current?.click()}
                      className="neo-raised inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:text-ink"
                    >
                      <Upload size={13} aria-hidden="true" />
                      {templateFile ? templateFile.name : 'Choose blank template'}
                    </button>
                    <input
                      ref={templateFileRef}
                      type="file"
                      accept=".docx,.pdf"
                      hidden
                      onChange={(e) => setTemplateFile(e.target.files?.[0] || null)}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-ink">Your first class</span>
          <span className="text-xs text-ink-muted">
            The course decides which standards get retrieved. It names itself from these two.
          </span>
          {/* Stacked, not sm:flex-row beside the grade select: FrameworkPicker's
              own dropdown panel is only ever as wide as ITS column (a shared
              component used on ClassPage too, so it isn't scoped to a wider
              ancestor here) — side-by-side with the grade select left it
              narrower than the "Open my year" button below, so the open panel
              didn't fully cover that button and a sliver of it stayed visible
              and legible through the gap. Full width top-to-bottom, the panel
              exactly matches the button beneath it. */}
          <div className="mt-1 flex flex-col gap-2">
            <div className="min-w-0">
              <FrameworkPicker
                frameworks={frameworks}
                value={subject}
                onChange={setSubject}
                id="welcome-framework"
              />
            </div>
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
