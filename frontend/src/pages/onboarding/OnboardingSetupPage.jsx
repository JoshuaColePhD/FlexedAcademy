import { useRef } from 'react'
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../lib/authContext'
import { useClasses } from '../../hooks/useAppData'
import { FirstPlanSetup } from '../../components/onboarding/FirstPlanSetup'
import { BootScreen } from '../../components/BootScreen'
import { readFirstPlanDraft } from '../../lib/firstPlanSetup'
import { safeReturnTo } from '../../lib/returnTo'

export function OnboardingSetupPage() {
  const { classId } = useParams()
  const { user } = useAuth()
  // Completion refreshes the account before the wizard navigates. Once this
  // page has admitted a setup session, only its explicit handoff may leave it.
  const enteredSetup = useRef(!user?.onboarding_seen_at || Boolean(readFirstPlanDraft(user?.id)))
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const returnTo = safeReturnTo(params.get('next'))
  const { data: classes = [], isLoading, isError, refetch } = useClasses()
  if (isLoading) return <BootScreen />
  if (isError) return <main className="flex h-full w-full items-center justify-center bg-paper p-6"><div role="alert"><h1 className="text-lg font-semibold">Your classes couldn’t load</h1><p className="note mt-2">Retry before setting up another class.</p><button className="btn mt-4" type="button" onClick={() => refetch()}>Try again</button></div></main>
  const saved = readFirstPlanDraft(user?.id)
  const targetId = classId || saved?.classId
  // A deleted draft class must not silently select and overwrite another class.
  const cls = targetId ? classes.find((item) => item.id === targetId) || null : classes[0] || null
  // The draft also protects the handoff while refresh() publishes the completed
  // account: redirecting here first would discard the requested first prompt.
  if (!enteredSetup.current && user?.onboarding_seen_at && cls && !saved) return <Navigate to={returnTo || `/c/${cls.id}`} replace />

  return <FirstPlanSetup key={user.id} cls={cls} onClose={(finishedClass, options = {}) => {
    const target = finishedClass?.id || cls?.id
    if (!target) { navigate('/', { replace: true }); return }
    // A shared destination is preserved unless the teacher asks to build in their own class.
    const dest = options.autoPrompt ? `/c/${target}?week=${options.weekNumber}` : returnTo || `/c/${target}`
    navigate(dest, { replace: true, state: options.autoPrompt
      ? { autoPrompt: options.autoPrompt, onboardingFirstPlan: true }
      : options.prefill ? { prefill: options.prefill } : undefined })
  }} />
}
