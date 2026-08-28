import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Loader2, Copy, FileText, ArrowRight, TriangleAlert } from 'lucide-react'
import { api } from '../lib/api'
import { qk } from '../lib/queryKeys'
import { useToast } from '../lib/toastContext'
import { useAuth } from '../lib/authContext'
import { LessonPlanTable } from '../components/LessonPlanTable'

export function SharedPlanPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const { user } = useAuth()
  
  const [forking, setForking] = useState(false)
  const [targetClassId, setTargetClassId] = useState('')

  const { data: plan, isLoading, error } = useQuery({
    queryKey: ['shared_plan', id],
    /* api.getSharedPlan, not api.client.get — there is no `client` on the api
       object, so this page threw on mount and every shared link landed on a
       crash. api.js's own request() already handles the base URL, the cookie,
       and turning a non-2xx into an ApiError with a readable hint. */
    queryFn: ({ signal }) => api.getSharedPlan(id, { signal }),
    retry: false
  })

  /* Keeps its own useQuery rather than useClasses() only because of `enabled`
     — this is a public share page, and an anonymous viewer must not fire an
     /api/classes that can only 401. The queryKey and queryFn are deliberately
     IDENTICAL to useClasses' (hooks/useAppData.js) so that when a signed-in
     teacher does land here it shares that one cache entry instead of racing a
     second, differently-shaped fetch onto the same key. */
  const { data: classes = [] } = useQuery({
    queryKey: qk.classes,
    queryFn: () => api.listClasses({ include_archived: true }),
    select: (rows) => (Array.isArray(rows) ? rows.filter((c) => !c.archived) : []),
    enabled: !!user,
    staleTime: 60_000,
  })

  const handleFork = async () => {
    if (!user) {
      toast.error('Sign in required', 'You need to be signed in to duplicate this plan.')
      return
    }
    
    setForking(true)
    try {
      const newPlan = await api.forkSharedPlan(id, targetClassId || null)
      
      toast.success('Plan duplicated', 'The plan has been copied to your account.')
      
      // Navigate to the newly forked plan
      if (targetClassId) {
        navigate(`/c/${targetClassId}/plans/${newPlan.id}`)
      } else {
        // If no class, just go to home or some library page
        navigate(`/`)
      }
    } catch (err) {
      toast.apiError('Could not duplicate plan', err)
    } finally {
      setForking(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-paper/30 backdrop-blur-3xl">
        <Loader2 className="animate-spin text-ink-muted" size={24} />
      </div>
    )
  }

  if (error || !plan) {
    return (
      <div className="flex h-screen w-full flex-col items-center justify-center bg-paper/30 backdrop-blur-3xl">
        <TriangleAlert size={48} className="text-mark mb-4" />
        <h1 className="text-xl font-bold text-ink mb-2">Plan not found</h1>
        <p className="text-sm text-ink-muted mb-6">This shared link is invalid or has expired.</p>
        <button onClick={() => navigate('/')} className="btn btn-primary">Go to Home</button>
      </div>
    )
  }

  return (
    <div className="flex h-screen w-full flex-col bg-paper/30 backdrop-blur-3xl overflow-hidden">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-edge bg-paper-sunken px-4 md:px-8">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
              <FileText size={16} />
            </div>
            <div>
              <h1 className="text-sm font-semibold text-ink">{plan.week_label || 'Lesson Plan'}</h1>
              <p className="text-xs text-ink-muted">Shared by a colleague</p>
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-2 md:gap-3">
          {user ? (
            <div className="flex items-center gap-2">
              {classes.length > 0 && (
                <select
                  value={targetClassId}
                  onChange={(e) => setTargetClassId(e.target.value)}
                  className="neo-select h-9 rounded-lg bg-paper px-2 md:px-3 text-xs md:text-sm max-w-[100px] sm:max-w-[150px] md:max-w-none truncate"
                >
                  <option value="">No specific class</option>
                  {classes.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              )}
              <button
                onClick={handleFork}
                disabled={forking}
                className="btn btn-primary flex items-center gap-2 px-2 md:px-3"
              >
                {forking ? <Loader2 size={16} className="animate-spin" /> : <Copy size={16} />}
                <span className="hidden sm:inline">Duplicate to My Classes</span>
                <span className="sm:hidden text-xs">Duplicate</span>
              </button>
            </div>
          ) : (
            <button
              onClick={() => navigate('/login', { state: { returnTo: `/shared/${id}` } })}
              className="btn btn-primary flex items-center gap-2 px-2 md:px-3"
            >
              <span className="hidden sm:inline">Sign in to duplicate</span>
              <span className="sm:hidden text-xs">Sign in</span>
              <ArrowRight size={16} className="hidden sm:block" />
            </button>
          )}
        </div>
      </header>

      <main className="flex-1 overflow-auto p-4 md:p-8">
        <div className="mx-auto max-w-5xl doc-sheet">
          <LessonPlanTable
            plan={plan.plan_json}
            planId={null}
            subject={plan.course}
            groundedCodes={new Set()}
            busy={false}
            view="print"
          />
        </div>
      </main>
    </div>
  )
}
