/* Classifies one week from GET /api/weeks (backend/db.py's week_board) into
 * a single status a UI can render a dot + label for.
 *
 * One definition, shared by ClassPage.jsx's Weeks panel and ArtifactRail.jsx's
 * "Other weeks" — a week is either built, missed, current, or upcoming from
 * both places, and two separate copies of that rule is how they'd quietly
 * disagree the first time one of them changes.
 */

// `tone` picks the status chip's color in ArtifactDetailPanel's calendar
// view (.detail-status-chip.is-{tone} in base.css) — same ok/accent/flag
// mapping the dot already uses, so "Built" reads as a positive green chip
// and "Not built" a warning one instead of every status sharing one color.
export const WEEK_STATUS = {
  closed: { dot: 'bg-ink-faint', label: 'No school', tone: 'neutral' },
  built: { dot: 'bg-ok', label: 'Built', tone: 'ok' },
  current: { dot: 'bg-accent', label: 'This week', tone: 'accent' },
  missed: { dot: 'bg-flag', label: 'Not built', tone: 'flag' },
  upcoming: { dot: 'bg-ink-faint', label: 'Upcoming', tone: 'neutral' },
}

export function weekStatus(w) {
  if (w.no_school) return 'closed'
  if (w.has_plan) return 'built'
  if (w.is_current) return 'current'
  if (w.is_past) return 'missed'
  return 'upcoming'
}
