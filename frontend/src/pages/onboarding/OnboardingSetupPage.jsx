import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { qk } from '../../lib/queryKeys'
import { OnboardingWizard } from '../../components/OnboardingWizard'
import { BootScreen } from '../../components/BootScreen'

/* Route: /c/:classId/onboarding — rendered on its own, outside AppShell, so a
 * brand-new account never sees the sidebar/rail ("the IDE") behind a modal
 * before they've told us anything about themselves. WelcomePage.jsx sends a
 * teacher straight here after creating their first class; App.jsx's
 * ClassRoutes guard sends anyone else here too if `onboarding_seen_at` is
 * still unset, so there's no way to reach `/c/:classId` itself first.
 *
 * Same OnboardingWizard component AppShell uses for "take the tour again" —
 * just `variant="page"` instead of a dialog over an app that, for this
 * account, doesn't have anything in it yet.
 */
export function OnboardingSetupPage() {
  const { classId } = useParams()
  const navigate = useNavigate()
  const { data: classes = [], isLoading } = useQuery({ queryKey: qk.classes, queryFn: () => api.listClasses() })

  if (isLoading) return <BootScreen />

  const cls = classes.find((c) => c.id === classId) || classes[0]
  // No class at all (deep link with a stale/foreign id) — nothing to onboard
  // into, so send them to /welcome to create one rather than rendering a
  // wizard with nothing to confirm.
  if (!cls) return <Navigate to="/welcome" replace />

  return (
    <OnboardingWizard
      variant="page"
      open
      cls={cls}
      onClose={() => navigate(`/c/${cls.id}`, { replace: true })}
    />
  )
}
