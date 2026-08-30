import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { CalendarPreview } from './CalendarPreview'

/* A school with a pending (unconfirmed) teacher-submitted calendar — the
 * submitter's own account already uses it (schoolcal.py's dispatcher lets a
 * pending submission through as a best-effort fallback), but nobody else
 * should treat it as real until an independent teacher has actually looked
 * at it. Shown wherever a school picker surfaces has_pending_calendar
 * (SettingsPage, ClassPage) — never auto-confirmed by just picking it.
 */
export function PendingCalendarReview({ schoolId }) {
  const { data: submission, isLoading } = useQuery({
    queryKey: ['schoolCalendarPending', schoolId],
    queryFn: () => api.getPendingSchoolCalendar(schoolId),
    enabled: !!schoolId,
    retry: false,
  })

  if (isLoading) return <p className="mt-2 text-xs text-ink-muted">Loading…</p>
  if (!submission) return null

  return (
    <div className="mt-2 max-w-sm rounded-lg bg-flag-tint p-3 text-xs">
      <p className="font-medium text-flag">Pending confirmation</p>
      <p className="mt-1 text-ink-soft">
        This school calendar is awaiting administrator review. It will not become the trusted
        calendar for the school until an administrator approves it.
      </p>
      <div className="mt-2">
        <CalendarPreview weeks={submission.weeks} />
      </div>
    </div>
  )
}
