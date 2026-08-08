import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Check, ChevronsUpDown, Plus } from 'lucide-react'
import { classColor } from '../lib/classColor'

/* Which prep you're planning for. Sits at the top of the rail because it scopes
   everything under it — the year, the week, the chats, and the class a new plan
   is stamped with. Hidden entirely until a teacher has two classes: a switcher
   with one option is furniture.

   It NAVIGATES now rather than calling a setState handed down from App. The old
   version wrote `activeClassId` into localStorage, and so did a radio button on
   My Class — one hidden global, two writers, no URL. Switching class is a
   navigation, which means it is linkable and the back button undoes it.

   The selected row is --paper-inset with an --ok check, not --accent. Rule 4
   reserves blue for "something is waiting for you"; the class you are already
   looking at is not waiting for anything, and spending accent here is part of
   why the blue had stopped meaning anything. */
export function ClassSwitcher({ classes, activeClass, classPath }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    if (!open) return undefined
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

  if (!classes?.length) return null

  if (classes.length === 1) {
    return (
      <p className="flex items-center gap-2 truncate px-3 pb-1 text-sm font-medium text-ink" title={classes[0].name}>
        <span
          className="class-dot"
          aria-hidden="true"
          style={{ '--class-dot-color': `rgb(${classColor(classes[0].id).rgb})` }}
        />
        <span className="min-w-0 flex-1 truncate">{classes[0].name}</span>
      </p>
    )
  }

  /* Switching class keeps you on the same KIND of screen — if you were looking
     at the year for AP Lang, you get the year for ENG 101, not thrown home.
     Week numbers deliberately do not carry across: week 12 of another prep is a
     different plan, and landing on it silently would be a lie. */
  const targetFor = (id) => {
    const tail = location.pathname.split('/').slice(3).join('/')
    /* Only `class` survives a class switch. It used to fall back to `calendar`
       — a route that no longer exists — so switching class from the DEFAULT
       landing screen (/c/A, where `tail` is empty) went straight to a 404.

       A chat id deliberately does not carry either: a conversation belongs to
       one class, and re-labelling it under another would show the wrong prep's
       transcript beneath the new class's heading. Everything else lands on the
       class root, which is where you start a plan anyway. */
    return tail === 'class' ? `/c/${id}/class` : `/c/${id}`
  }

  return (
    <div className="relative px-2 pb-1" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex min-h-touch w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-paper-inset"
      >
        {activeClass ? (
          <span
            className="class-dot"
            aria-hidden="true"
            style={{ '--class-dot-color': `rgb(${classColor(activeClass.id).rgb})` }}
          />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
          {activeClass?.name || 'Choose a class'}
        </span>
        <ChevronsUpDown size={14} aria-hidden="true" className="shrink-0 text-ink-faint" />
      </button>

      {open ? (
        <ul
          role="listbox"
          aria-label="Your classes"
          className="absolute left-2 right-2 z-50 mt-1 overflow-hidden rounded-lg border border-edge-strong bg-paper-raised py-1 shadow-pop"
        >
          {classes.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                role="option"
                aria-selected={c.id === activeClass?.id}
                onClick={() => {
                  setOpen(false)
                  navigate(targetFor(c.id))
                }}
                className={`flex min-h-touch w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
                  c.id === activeClass?.id
                    ? 'bg-paper-inset text-ink'
                    : 'text-ink-soft hover:bg-paper-sunken'
                }`}
              >
                <span
                  className="class-dot"
                  aria-hidden="true"
                  style={{ '--class-dot-color': `rgb(${classColor(c.id).rgb})` }}
                />
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                {c.id === activeClass?.id ? (
                  <Check size={13} aria-hidden="true" className="shrink-0 text-ok" />
                ) : null}
              </button>
            </li>
          ))}
          <li>
            <Link
              to={`${classPath}/class`}
              onClick={() => setOpen(false)}
              className="flex min-h-touch items-center gap-2 border-t border-edge px-3 py-1.5 text-sm text-ink-muted transition-colors hover:bg-paper-sunken hover:text-ink"
            >
              <Plus size={13} aria-hidden="true" /> Add a class
            </Link>
          </li>
        </ul>
      ) : null}
    </div>
  )
}
