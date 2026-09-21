import { useCallback, useEffect, useRef, useState } from 'react'
import { teachingApi } from '../lib/teachingApi'
import { describePlanChanges, samePlan, undoVersion } from '../lib/voicePlanChanges'

export function useVoicePlanFeedback(options) {
  const latest = useRef(options)
  latest.current = options
  const seen = useRef(null)
  const epoch = useRef(0)
  const inFlight = useRef(false)
  const [receipt, setReceipt] = useState(null)
  const [undoing, setUndoing] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    epoch.current += 1
    seen.current = latest.current.change?.id
    setReceipt(null)
    setError('')
    inFlight.current = false
    setUndoing(false)
    return () => {
      epoch.current += 1
      if (inFlight.current) latest.current.onUndoEnd()
      inFlight.current = false
    }
  }, [options.planId, options.chatId])
  useEffect(() => {
    seen.current = latest.current.change?.id
    setReceipt(null)
    setError('')
  }, [options.open])
  useEffect(() => {
    const { open, planId, change, plan, flash } = options
    if (!open || !planId || !change?.beforePlan || seen.current === change.id) return
    seen.current = change.id
    if (samePlan(change.beforePlan, plan)) return
    const next = { id: change.id, planId, before: change.beforePlan, after: plan, ...describePlanChanges(change.beforePlan, plan) }
    setReceipt(next)
    setError('')
    flash(next.keys)
  }, [options.open, options.planId, options.plan, options.change, options.flash])

  const undo = useCallback(async () => {
    const ctx = latest.current
    if (!receipt || inFlight.current || ctx.busy || receipt.planId !== ctx.planId || !samePlan(ctx.plan, receipt.after)) return
    inFlight.current = true
    setUndoing(true)
    setError('')
    const generation = epoch.current
    ctx.onUndoStart()
    try {
      const versions = await teachingApi.versions(receipt.planId)
      if (epoch.current !== generation) return
      const target = undoVersion(versions, receipt.before, receipt.after)
      // The server checks expectedRevision under a row lock. A newer write
      // between reading history and restoring is rejected, never overwritten.
      const row = await teachingApi.restore(receipt.planId, target.revision, target.expectedRevision)
      if (epoch.current !== generation) return
      ctx.onRestored(row, receipt.id)
      ctx.flash(receipt.keys)
      setReceipt(null)
    } catch (failure) {
      if (epoch.current === generation) setError(failure.message || 'That change could not be undone. Try again.')
    } finally {
      if (epoch.current === generation) {
        inFlight.current = false
        setUndoing(false)
        ctx.onUndoEnd()
      }
    }
  }, [receipt])
  useEffect(() => () => { epoch.current += 1 }, [])
  return { receipt, undo, undoing, error, blocked: options.busy }
}
