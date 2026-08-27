import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Loader2 } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { api } from '../../lib/api'
import { qk } from '../../lib/queryKeys'
import { useAuth } from '../../lib/authContext'
import { useToast } from '../../lib/toastContext'
import { FrameworkPicker } from '../../components/FrameworkPicker'
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

  const [subject, setSubject] = useState('')
  const [saving, setSaving] = useState(false)

  const { data: frameworks = [] } = useQuery({
    queryKey: qk.frameworks,
    queryFn: () => api.getFrameworks(),
    staleTime: Infinity,
  })

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
      const created = await api.createClass({ subject })
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

  /* h-app, not min-h-app: index.html's <body> is overflow-hidden — every
     page has to make its OWN content scrollable rather than relying on
     document scroll, same reasoning as AuthLayout.jsx. Without max-h-full
     + overflow-y-auto on the form itself, this card had no ceiling on its
     own height, so a tall form (the "school isn't listed" panel expanded)
     just clipped silently against the body's hard edge with no scrollbar
     and no way to reach the rest of it. */
  return (
    <div className="flex h-app w-full items-center justify-center bg-paper p-gutter">
      <AnimatePresence mode="wait">
        {saving ? (
          <motion.div
            key="saving"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="flex flex-col items-center gap-4 text-ink"
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
            className="flex max-h-full w-full max-w-[440px] flex-col gap-7 overflow-y-auto rounded-2xl border border-edge bg-paper-raised p-8 md:p-10"
          >
            <div>
              <h1 className="text-2xl font-semibold tracking-display text-ink">Let’s set up your year</h1>
              <p className="mt-1.5 text-sm text-ink-muted">
                What course do you teach? You can add more classes later.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-ink">Your first class</span>
              <span className="text-xs text-ink-muted">
                This selects the official standards to ground your lesson plans in.
              </span>
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
              disabled={!subject}
              className="flex min-h-touch-lg w-full items-center justify-center gap-2 rounded-lg bg-ink px-4 text-sm font-semibold text-ink-inverse transition-colors hover:bg-ink-soft disabled:cursor-not-allowed disabled:opacity-50"
            >
              Open my year
              <ArrowRight size={15} aria-hidden="true" />
            </button>
          </motion.form>
        )}
      </AnimatePresence>
    </div>
  )
}
