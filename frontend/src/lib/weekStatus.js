/* Classifies one week from GET /api/weeks (backend/db.py's week_board) into
 * a single status a UI can render a dot + label for.
 *
 * One definition, shared by ClassPage.jsx's Weeks panel and ArtifactRail.jsx's
 * "Other weeks" — a week is either built, missed, current, or upcoming from
 * both places, and two separate copies of that rule is how they'd quietly
 * disagree the first time one of them changes.
 */

export const WEEK_STATUS = {
  closed: { dot: 'bg-ink-faint', label: 'No school' },
  built: { dot: 'bg-ok', label: 'Built' },
  current: { dot: 'bg-accent', label: 'This week' },
  missed: { dot: 'bg-flag', label: 'Not built' },
  upcoming: { dot: 'bg-ink-faint', label: 'Upcoming' },
}

export function weekStatus(w) {
  if (w.no_school) return 'closed'
  if (w.has_plan) return 'built'
  if (w.is_current) return 'current'
  if (w.is_past) return 'missed'
  return 'upcoming'
}
