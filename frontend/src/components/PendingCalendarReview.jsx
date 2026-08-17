import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { qk } from '../lib/queryKeys'
import { useAuth } from '../lib/authContext'
import { useToast } from '../lib/toastContext'
import { CalendarPreview } from './CalendarPreview'

/* A school with a pending (unconfirmed) teacher-submitted calendar — the
 * submitter's own account already uses it (schoolcal.py's dispatcher lets a
 * pending submission through as a best-effort fallback), but nobody else
 * should treat it as real until an independent teacher has actually looked
 * at it. Shown wherever a school picker surfaces has_pending_calendar
 * (SettingsPage, ClassPage) — never auto-confirmed by just picking it.
 */
export function PendingCalendarReview({ schoolId, onDecided }) {
  const { user } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const [deciding, setDeciding] = useState(false)
  const { data: submission, isLoading } = useQuery({
    queryKey: ['schoolCalendarPending', schoolId],
    queryFn: () => api.getPendingSchoolCalendar(schoolId),
    enabled: !!schoolId,
    retry: false,
  })

  if (isLoading) return <p className="mt-2 text-xs text-ink-muted">Loading…</p>
  if (!submission) return null

  const isSubmitter = submission.submitted_by === user?.id

  const decide = async (action) => {
    setDeciding(true)
    try {
      if (action === 'confirm') {
        await api.confirmSchoolCalendar(submission.id)
        toast.success('Calendar confirmed', "It now counts as this school's real calendar.")
      } else {
        await api.rejectSchoolCalendar(submission.id)
        toast.success('Submission rejected')
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.schools }),
        qc.invalidateQueries({ queryKey: ['schoolCalendarPending', schoolId] }),
      ])
      onDecided?.()
    } catch (err) {
      toast.apiError('Could not save that', err)
    } finally {
      setDeciding(false)
    }
  }

  return (
    <div className="mt-2 max-w-sm rounded-lg bg-flag-tint p-3 text-xs">
      <p className="font-medium text-flag">Pending confirmation</p>
      <p className="mt-1 text-ink-soft">
        {isSubmitter
          ? "You submitted this calendar — a colleague at your school needs to confirm it before it's fully trusted."
          : 'A colleague submitted this calendar. Take a look and confirm it if it matches your school.'}
      </p>
      <div className="mt-2">
        <CalendarPreview weeks={submission.weeks} />
      </div>
      {!isSubmitter ? (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            disabled={deciding}
            onClick={() => decide('confirm')}
            className="btn text-2xs disabled:cursor-not-allowed disabled:opacity-50"
          >
            Looks right
          </button>
          <button
            type="button"
            disabled={deciding}
            onClick={() => decide('reject')}
            className="btn text-2xs disabled:cursor-not-allowed disabled:opacity-50"
          >
            Doesn't match
          </button>
        </div>
      ) : null}
    </div>
  )
}
