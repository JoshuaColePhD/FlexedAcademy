import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Loader2 } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { api } from '../../lib/api'
import { qk } from '../../lib/queryKeys'
import { useAuth } from '../../lib/authContext'
import { useToast } from '../../lib/toastContext'
import { FrameworkPicker } from '../../components/FrameworkPicker'
import { GRADES, DEFAULT_GRADE } from '../../lib/grades'
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

  const [subject, setSubject] = useState('')
  const [grade, setGrade] = useState(DEFAULT_GRADE)
  const [saving, setSaving] = useState(false)

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
    () => frameworks.filter((f) => (f.grades || []).includes(Number(grade))),
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

  const submit = async (e) => {
    e.preventDefault()
    if (!subject) {
      toast.error('Pick a course first', 'It decides which standards your plans are grounded in.')
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
            <div className="flex shrink-0 flex-col gap-3 border-b border-edge bg-paper-raised px-6 py-4 sm:flex-row sm:items-center sm:justify-between md:px-10">
              <div>
                <h1 className="text-xl font-semibold tracking-display text-ink">Let’s set up your year</h1>
                <p className="text-xs text-ink-muted">
                  Pick the course you teach — it decides which standards ground every plan.
                </p>
              </div>
              <label htmlFor="welcome-grade" className="flex items-center gap-2 text-sm">
                <span className="font-medium text-ink">Grade</span>
                <select
                  id="welcome-grade"
                  value={grade}
                  onChange={(e) => setGrade(e.target.value)}
                  className="neo-select min-h-touch rounded-lg border border-edge bg-paper py-2 pl-3 pr-7 text-sm text-ink outline-none focus:border-accent"
                >
                  {GRADES.map((g) => (
                    <option key={g.value} value={g.value}>
                      {g.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-6 py-4 md:px-10">
              <FrameworkPicker
                frameworks={gradeFilteredFrameworks}
                value={subject}
                onChange={setSubject}
                id="welcome-framework"
                variant="inline"
              />
            </div>

            <div className="flex shrink-0 items-center justify-between gap-4 border-t border-edge bg-paper-raised px-6 py-4 md:px-10">
              <span className="min-w-0 truncate text-sm text-ink-muted">
                {selectedFramework ? `Selected: ${selectedFramework.label}` : 'Choose a course above to continue.'}
              </span>
              <button
                type="submit"
                disabled={!subject}
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
