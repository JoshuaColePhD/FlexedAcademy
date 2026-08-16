import { Link } from 'react-router-dom'
import { ChevronRight, User } from 'lucide-react'
import { useAuth } from '../lib/authContext'

/* The rail footer, and the home of the control that did not exist.
 *
 * AuthProvider has exposed `logout` since the multi-tenant work and nothing has
 * ever called it: there was no way to sign out of this app. On a single-user
 * tool that was merely odd. On a product other teachers log into it is a bug
 * with a privacy shape — a shared staffroom machine keeps the last teacher's
 * session for thirty days.
 *
 * It goes next to the teacher's own name because that is where people already
 * look for it.
 *
 * Was a popover (identity, usage, My classes/Settings/Admin, Log out) —
 * replaced on request with a real page (AccountPage.jsx): clicking here now
 * navigates instead of opening a menu, and AppShell.jsx slides the rail shut
 * while that page is open, the same "drill in, then come back" shape a
 * phone's own Settings uses rather than a menu stacked over a still-visible
 * chat. This component is just the trigger now — everything it used to hold
 * lives on that page. */
export function AccountMenu({ classPath }) {
  const { user } = useAuth()
  const name = user?.name || user?.email || 'Signed in'

  return (
    <Link
      to={`${classPath}/account`}
      className="flex min-w-0 items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-paper-inset"
    >
      <span
        aria-hidden="true"
        className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-paper-inset text-ink-muted"
      >
        <User size={13} />
      </span>
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink-soft">{name}</span>
      <ChevronRight size={13} aria-hidden="true" className="shrink-0 text-ink-faint" />
    </Link>
  )
}
