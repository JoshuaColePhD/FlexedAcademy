import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, CheckCircle2, Loader2 } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { api } from '../../lib/api'
import { GENERIC_SCHOOL } from '../../lib/schools'
import { qk } from '../../lib/queryKeys'
import { useAuth } from '../../lib/authContext'
import { useToast } from '../../lib/toastContext'
import { FrameworkPicker } from '../../components/FrameworkPicker'
import { inferGradeFromQuery, matchesFramework } from '../../lib/frameworks'
import { GRADES, gradeLabel } from '../../lib/grades'
/* The one grade vocabulary. This file used to declare its own copy, with a
   comment explaining that the VALUE and the LABEL must stay apart because
   sending '11th' where '11' belongs made the first class a teacher ever
   created render as 'AP Language & Composition · NaNth'. The comment was
   right and the duplication is what let the same mistake survive in two
   other copies — see lib/grades.js and migration 38.

   Grade itself was dropped from this form at some point (a simplification
   pass) but the backend never stopped defaulting every new class to grade
   11 (routes/classes.py's ClassBody.grade) and using it directly to decide
   which standards are even eligible to ground a plan in (prompts.py's
   grounding_constraints) — so a K-8 teacher's very first class was silently
   mis-grounded to grade 11 language until they noticed and fixed it in My
   Classes. Restored here, one field, no new step. */

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


// Not a real grade — GRADES/DEFAULT_GRADE (lib/grades.js) stay the single
// canonical vocabulary for what actually gets SAVED; this is a browse-only
// sentinel so a teacher isn't forced to guess a grade just to start
// looking. Never sent to the backend: submit() below blocks on it exactly
// like it already blocks on no subject chosen, so the grade-11-default
// correctness bug this session fixed can't sneak back in through here.
const ALL_GRADES = 'all'

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

  const [subject, setSubject] = useState('')
  const [grade, setGrade] = useState(ALL_GRADES)
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)
  // A sighted teacher SEES the grade select snap to "3rd" the moment they
  // type it — a screen-reader user, focused in the search box the whole
  // time, gets no signal that anything off-screen just changed unless
  // something announces it. Manual selection doesn't need this: the
  // native <select> already reports its own value change on interaction.
  const [gradeAnnouncement, setGradeAnnouncement] = useState('')

  const { data: frameworks = [] } = useQuery({
    queryKey: qk.frameworks,
    queryFn: () => api.getFrameworks(),
    staleTime: Infinity,
  })

  // The grade select otherwise only fed the class it creates on submit —
  // it sat right next to a browser full of courses and did nothing to it,
  // which reads as broken the moment someone actually tries it. Every
  // framework already carries its own grades[] (used for the "elementary"/
  // "middle"/"high" search synonyms in lib/frameworks.js), so filtering the
  // list the picker sees is a plain narrow, not a new capability.
  const gradeFilteredFrameworks = useMemo(
    () => (grade === ALL_GRADES ? frameworks : frameworks.filter((f) => (f.grades || []).includes(Number(grade)))),
    [frameworks, grade],
  )

  // A course chosen under one grade can fall outside the list the moment
  // the grade changes (e.g. AP Calculus picked at 11th, then grade dropped
  // to 3rd) — left alone, the footer would keep claiming a course as
  // "Selected" that's no longer even visible above it.
  useEffect(() => {
    if (subject && !gradeFilteredFrameworks.some((f) => f.id === subject)) {
      setSubject('')
    }
  }, [gradeFilteredFrameworks, subject])

  // The search box understands grade words too ("elementary", "3rd",
  // "high school" — see lib/frameworks.js's matchesFramework), which used
  // to just silently fight the grade select: leave grade on 11th and type
  // "elementary" and you'd get zero results with no hint why. A specific
  // number is unambiguous, so it snaps the select straight to that grade.
  // A band word ("elementary") spans several grades with no single right
  // answer, so it only clears the select back to "All grades" — and only
  // when the CURRENT grade actually conflicts with it; a grade already
  // inside the band is left alone rather than needlessly widened.
  useEffect(() => {
    const intent = inferGradeFromQuery(query)
    if (!intent) return
    if (intent.type === 'grade') {
      if (grade !== intent.grade) {
        setGrade(intent.grade)
        setGradeAnnouncement(`Grade set to ${gradeLabel(intent.grade) || intent.grade}.`)
      }
    } else if (intent.type === 'band') {
      if (grade !== ALL_GRADES && !intent.grades.includes(Number(grade))) {
        setGrade(ALL_GRADES)
        setGradeAnnouncement('Grade cleared to All grades.')
      }
    }
  }, [query, grade])

  // Auto-adjustment above resolves most grade/search conflicts before they
  // ever render — but a plain course-name search ("cybersecurity") isn't a
  // grade word, so it doesn't trigger that path, and can still come up
  // empty purely because the grade filter excludes every course that
  // matches. FrameworkPicker's own generic "No course matches" is accurate
  // for a genuine typo; this replaces it with the real reason specifically
  // when the search WOULD have hits under a different grade.
  const emptyMessage = useMemo(() => {
    if (!query.trim() || grade === ALL_GRADES) return undefined
    if (gradeFilteredFrameworks.some((f) => matchesFramework(f, query))) return undefined
    if (!frameworks.some((f) => matchesFramework(f, query))) return undefined
    return `No ${gradeLabel(grade) || grade} courses match “${query}” — try All grades.`
  }, [query, grade, gradeFilteredFrameworks, frameworks])

  const submit = async (e) => {
    e.preventDefault()
    if (!subject) {
      toast.error('Pick a course first', 'It decides which standards your plans are grounded in.')
      return
    }
    if (grade === ALL_GRADES) {
      toast.error('Pick a grade', 'It decides which standards and language fit your students.')
      return
    }
    setSaving(true)
    try {
      const patch = {}
      if (!user?.school) patch.school = GENERIC_SCHOOL
      if (Object.keys(patch).length) await api.updateMe(patch)
      const created = await api.createClass({ subject, grade })
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.classes }),
        refresh(),
      ])
      /* The dedicated onboarding page (App.jsx, OnboardingSetupPage.jsx), not
         the class itself — a brand-new account still has the school/course/
         materials wizard ahead of it, and that page's own job is to keep the
         app shell off screen until that's done. (App.jsx's ClassRoutes guard
         would bounce here anyway if this went straight to `/c/:classId`, but
         landing directly skips that extra redirect.) */
      navigate(`/c/${created.id}/onboarding`, { replace: true })
    } catch (err) {
      toast.apiError('Could not set that up', err)
      setSaving(false)
    }
  }

  const selectedFramework = gradeFilteredFrameworks.find((f) => f.id === subject)
  // First name only — "Let's set up your year, Joshua Cole" reads like a
  // mail-merge, not a greeting. Falls back to no name at all rather than
  // "there" or similar filler when a Google account has no name on file.
  const firstName = user?.name?.trim().split(/\s+/)[0] || ''

  /* h-app, not min-h-app: index.html's <body> is overflow-hidden — every
     page has to make its OWN content scrollable rather than relying on
     document scroll, same reasoning as AuthLayout.jsx.

     No longer a small centered card: the course picker used to run as a
     popover here, which meant the entire browsing experience — the
     category rail, the list — was hidden behind a click, in a box only as
     wide as the surrounding card allowed. Widening the card (previous
     pass) fixed the popover from clipping itself, but a teacher's actual
     first move on this page IS picking a course — that deserves to be the
     page, not a dropdown floating over one. FrameworkPicker's own
     variant="inline" mode (see its own comment) renders the exact same
     rail+list, permanently visible, filling this layout instead of
     popping over it. Header (course/grade context) and footer (the
     action) stay as slim bars so the browser gets the space. */
  return (
    <div className="flex h-app w-full flex-col overflow-hidden bg-paper">
      <AnimatePresence mode="wait">
        {saving ? (
          <motion.div
            key="saving"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="flex flex-1 flex-col items-center justify-center gap-4 p-gutter text-ink"
          >
            <Loader2 size={32} className="animate-spin text-accent" />
            <h2 className="text-xl font-medium tracking-tight">Setting up your AI planner...</h2>
            <p className="text-sm text-ink-muted">Tailoring your experience</p>
          </motion.div>
        ) : (
          <motion.form
            key="form"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            onSubmit={submit}
            className="flex h-full w-full flex-col overflow-hidden"
          >
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-edge bg-paper-raised px-6 py-5 md:px-10 md:py-6">
              <div>
                <h1 className="text-xl font-semibold tracking-display text-ink">
                  Let’s set up your year{firstName ? `, ${firstName}` : ''}
                </h1>
                <p className="text-xs text-ink-muted">
                  Tell us who and what you teach, and we’ll ground every plan in the right standards.
                </p>
              </div>
              {/* Same mark as the app's own sidebar (AppShell.jsx) — this
                  corner held the grade select, but grade now sits where a
                  teacher's eye actually goes first (beside the search box,
                  see below), so this becomes what every other header in the
                  app already puts here: whose screen this is. */}
              <svg viewBox="0 0 64 64" className="h-6 w-6 shrink-0 text-[#7c3aed] drop-shadow-sm" aria-hidden="true">
                <circle cx="32" cy="32" r="29" fill="transparent" className="land-seal-disc" />
                <circle cx="32" cy="32" r="30.5" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="1.6 3.4" className="land-seal-ticks" />
                <circle cx="32" cy="32" r="27" fill="none" stroke="currentColor" strokeWidth="2.5" className="land-seal-ring" />
                <path d="M20 33l8 8 16-18" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" className="land-seal-check" />
              </svg>
            </div>

            <span className="sr-only" role="status" aria-live="polite">{gradeAnnouncement}</span>

            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: 0.08 }}
              className="flex min-h-0 flex-1 flex-col overflow-hidden px-6 py-5 md:px-10 md:py-6"
            >
              <p className="mb-2 shrink-0 text-xs text-ink-muted">
                Showing {gradeFilteredFrameworks.length} course{gradeFilteredFrameworks.length === 1 ? '' : 's'}
                {grade === ALL_GRADES ? (
                  '.'
                ) : (
                  <>
                    {' '}
                    for <span className="font-medium text-ink">{gradeLabel(grade) || grade}</span>.
                  </>
                )}
              </p>
              <FrameworkPicker
                frameworks={gradeFilteredFrameworks}
                value={subject}
                onChange={setSubject}
                onQueryChange={setQuery}
                emptyMessage={emptyMessage}
                id="welcome-framework"
                variant="inline"
                beforeInput={
                  <label htmlFor="welcome-grade" className="flex shrink-0 items-center gap-1.5 text-sm">
                    <span className="sr-only">Grade</span>
                    <select
                      id="welcome-grade"
                      value={grade}
                      onChange={(e) => setGrade(e.target.value)}
                      className="neo-select min-h-touch rounded-lg border border-edge bg-paper py-2.5 pl-3 pr-7 text-sm font-medium text-ink outline-none focus:border-accent"
                    >
                      <option value={ALL_GRADES}>All grades</option>
                      {GRADES.map((g) => (
                        <option key={g.value} value={g.value}>
                          {g.label}
                        </option>
                      ))}
                    </select>
                  </label>
                }
              />
            </motion.div>

            <div className="flex shrink-0 items-center justify-between gap-4 border-t border-edge bg-paper-raised px-6 py-5 md:px-10 md:py-6">
              <AnimatePresence mode="wait">
                <motion.span
                  key={selectedFramework ? selectedFramework.id : 'none'}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.18 }}
                  className="flex min-w-0 items-center gap-1.5"
                >
                  {selectedFramework ? (
                    <motion.span
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={{ type: 'spring', stiffness: 400, damping: 15 }}
                      className="shrink-0"
                    >
                      <CheckCircle2 size={15} className="text-ok" aria-hidden="true" />
                    </motion.span>
                  ) : null}
                  <span className="min-w-0 truncate text-sm text-ink-muted">
                    {!selectedFramework
                      ? 'Choose a course above to continue.'
                      : grade === ALL_GRADES
                        ? `Nice pick — ${selectedFramework.label}. Now grab a grade too.`
                        : `Nice pick — ${selectedFramework.label} is ready to go.`}
                  </span>
                </motion.span>
              </AnimatePresence>
              <button
                type="submit"
                disabled={!subject || grade === ALL_GRADES}
                className="flex shrink-0 min-h-touch-lg items-center justify-center gap-2 rounded-lg bg-ink px-6 text-sm font-semibold text-ink-inverse transition-colors hover:bg-ink-soft disabled:cursor-not-allowed disabled:opacity-50"
              >
                Open my year
                <ArrowRight size={15} aria-hidden="true" />
              </button>
            </div>
          </motion.form>
        )}
      </AnimatePresence>
    </div>
  )
}
