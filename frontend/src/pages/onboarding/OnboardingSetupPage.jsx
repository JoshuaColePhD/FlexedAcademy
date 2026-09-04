import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { qk } from '../../lib/queryKeys'
import { useClasses } from '../../hooks/useAppData'
import { OnboardingWizard } from '../../components/OnboardingWizard'
import { BootScreen } from '../../components/BootScreen'
import { safeReturnTo } from '../../lib/returnTo'

/* Routes: /onboarding and /c/:classId/onboarding — rendered on their own,
 * outside AppShell, so a brand-new account never sees the sidebar/rail ("the
 * IDE") behind a modal before they've told us anything about themselves.
 *
 * /onboarding is the first run and has NO class: the wizard's first two steps
 * (profile, course) don't need one, and the course step creates it. That
 * replaces WelcomePage, which existed only to create the class up front and
 * whose existence is why course and grade used to be asked twice.
 *
 * /c/:classId/onboarding is where App.jsx's ClassRoutes guard sends an account
 * that has a class but no `onboarding_seen_at`, and where a reload mid-first-run
 * lands once a class exists. So there is no way to reach `/c/:classId` itself
 * with setup outstanding.
 *
 * Same OnboardingWizard component AppShell uses for "take the tour again" —
 * just `variant="page"` instead of a dialog over an app that, for this
 * account, doesn't have anything in it yet.
 */
export function OnboardingSetupPage() {
  const { classId } = useParams()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const returnTo = safeReturnTo(params.get('next'))
  const { data: classes = [], isLoading } = useClasses()
  /* Prefetched here, not just inside OnboardingWizard: the wizard's own
   * WelcomeStep counts "N quick things" from whether the teacher's school
   * needs a template, which this same query (qk.schools) answers — and that
   * query is async. Fetching it only once the wizard itself mounted meant
   * the very first paint promised one count (school status still unknown)
   * and then corrected itself a beat later once it resolved. staleTime:
   * Infinity means this shares one cache entry with the wizard's own query,
   * so gating the page's loading screen on it too means the wizard never
   * mounts until the school data it needs to count correctly is already in
   * hand — the count is right from its very first paint, not corrected into
   * being right. */
  const { isLoading: schoolsLoading } = useQuery({
    queryKey: qk.schools,
    queryFn: () => api.listSchools(),
    staleTime: Infinity,
  })

  if (isLoading || schoolsLoading) return <BootScreen />

  /* Undefined on /onboarding, and that is the normal first-run case rather
     than an error. It used to redirect to /welcome when no class matched,
     which was also how a stale or foreign :classId was handled; that case now
     falls back to the account's first class, and failing that runs the
     first-run flow, which creates one. Either way the teacher ends up
     somewhere that works instead of on a wizard with nothing to confirm. */
  const cls = (classId ? classes.find((c) => c.id === classId) : null) || classes[0] || null

  return (
    <OnboardingWizard
      variant="page"
      open
      cls={cls}
      /* The class may not exist when this mounts, so the close destination is
         resolved at click time from whatever the wizard created. */
      onClose={(finishedClass, opts) => {
        const target = finishedClass?.id || cls?.id
        const dest = returnTo || (target ? `/c/${target}` : '/')
        navigate(dest, { replace: true, state: opts?.prefill ? { prefill: opts.prefill } : undefined })
      }}
    />
  )
}
