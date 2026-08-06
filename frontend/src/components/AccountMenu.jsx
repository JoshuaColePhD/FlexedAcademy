import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { LogOut, Settings, User } from 'lucide-react'
import { useAuth } from '../lib/authContext'
import { ThemeToggle } from './ThemeToggle'

/* The rail footer, and the home of the control that did not exist.
 *
 * AuthProvider has exposed `logout` since the multi-tenant work and nothing has
 * ever called it: there was no way to sign out of this app. On a single-user
 * tool that was merely odd. On a product other teachers log into it is a bug
 * with a privacy shape — a shared staffroom machine keeps the last teacher's
 * session for thirty days.
 *
 * It goes next to the teacher's own name because that is where people already
 * look for it. */
export function AccountMenu({ classPath }) {
  const { user, logout } = useAuth()
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const name = user?.name || user?.email || 'Signed in'

  return (
    <div className="relative flex items-center gap-1 px-2 py-2" ref={ref}>
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-paper-inset"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span
          aria-hidden="true"
          className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-paper-inset text-ink-muted"
        >
          <User size={13} />
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink-soft">{name}</span>
      </button>

      <ThemeToggle />

      {open ? (
        <div
          role="menu"
          className="absolute bottom-full left-2 right-2 z-50 mb-1 overflow-hidden rounded-lg border border-edge bg-paper-raised py-1 shadow-lg"
        >
          {user?.email ? (
            <p className="truncate px-3 py-1.5 text-2xs text-ink-faint">{user.email}</p>
          ) : null}
          <Link
            to={`${classPath}/class`}
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex min-h-touch items-center gap-2 px-3 py-2 text-xs text-ink-soft transition-colors hover:bg-paper-sunken"
          >
            <Settings size={14} aria-hidden="true" /> Classes &amp; settings
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              logout()
            }}
            className="flex min-h-touch w-full items-center gap-2 px-3 py-2 text-left text-xs text-ink-soft transition-colors hover:bg-paper-sunken"
          >
            <LogOut size={14} aria-hidden="true" /> Sign out
          </button>
        </div>
      ) : null}
    </div>
  )
}
