import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Check, ChevronsUpDown, Plus } from 'lucide-react'
import { classColor } from '../lib/classColor'
import { useExitTransition } from '../hooks/useExitTransition'

/* Which prep you're planning for. Rendered inline in the chat's top bar,
   directly left of WeekPicker (ChatPage.jsx) — the two controls together
   scope the whole conversation: which class, which week. `inline` is what
   picks that compact pill shape over the original full-width rail row;
   both still navigate the same way and share the same popup. Hidden
   entirely until a teacher has two classes: a switcher with one option is
   furniture.

   It NAVIGATES now rather than calling a setState handed down from App. The old
   version wrote `activeClassId` into localStorage, and so did a radio button on
   My Class — one hidden global, two writers, no URL. Switching class is a
   navigation, which means it is linkable and the back button undoes it.

   The selected row is --paper-inset with an --ok check, not --accent. Rule 4
   reserves blue for "something is waiting for you"; the class you are already
   looking at is not waiting for anything, and spending accent here is part of
   why the blue had stopped meaning anything. */
export function ClassSwitcher({ classes, activeClass, classPath, inline = false }) {
  const [open, setOpen] = useState(false)
  // The menu used to unmount the instant `open` went false — a hard cut, the
  // one thing every other neo-panel overlay in the app (toasts, the confirm
  // dialog, attachment chips) already avoids with a matched exit.
  const { mounted, closing } = useExitTransition(open, 150)
  const ref = useRef(null)
  const navigate = useNavigate()
  const location = useLocation()

  // The backend now refuses to create or rename a class onto a name another
  // one of the same account's classes already has (routes/classes.py) — but
  // this still has to cope with the ones that got in before that existed: a
  // production account was found with two classes both auto-named "English
  // Language Arts · 6th," and switching between them looked like switching
  // did nothing, since the trigger button and the dropdown both show
  // `c.name` verbatim and nothing else about them differed on screen. This
  // doesn't rename anything server-side — it's purely what gets displayed,
  // computed fresh from whichever classes actually collide right now, so a
  // teacher can still tell two same-named preps apart if one ever slips
  // through (a genuine race between two near-simultaneous creates isn't
  // fully closed by a check-then-insert guard either).
  const displayName = useMemo(() => {
    const counts = new Map()
    for (const c of classes) {
      const key = c.name.trim().toLowerCase()
      counts.set(key, (counts.get(key) || 0) + 1)
    }
    const seen = new Map()
    const map = new Map()
    for (const c of classes) {
      const key = c.name.trim().toLowerCase()
      if (counts.get(key) > 1) {
        const n = (seen.get(key) || 0) + 1
        seen.set(key, n)
        map.set(c.id, `${c.name} (${n})`)
      } else {
        map.set(c.id, c.name)
      }
    }
    return map
  }, [classes])

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
      <p
        className={
          inline
            ? 'chat-week min-w-0 max-w-xs shrink truncate normal-case tracking-normal'
            : 'flex items-center gap-2 truncate px-3 pb-1 text-sm font-medium text-ink'
        }
        title={classes[0].name}
      >
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

  /* Two very different homes for the same control: full-width and left-
     anchored in the rail (the original shape), or a compact inline pill
     sitting beside WeekPicker in the chat top bar — same `.chat-week`
     caption language that pill already uses, so the two read as one row
     instead of two different controls bolted together. The popup itself
     stays a fixed-width card either way; only the trigger's shape and the
     popup's anchoring edge change. */
  return (
    <div className={inline ? 'relative min-w-0 shrink' : 'relative px-2 pb-1'} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={
          inline
            ? // w-full, not just max-w-[9rem]: the wrapping div above is the
              // actual flex-shrinking item (it carries `shrink`), and a plain
              // <button> inside it sizes itself by its OWN content up to its
              // own max-width regardless of how far its parent shrank —
              // nothing ties the two together without this. Under real space
              // pressure (a long class name sharing the row with WeekPicker)
              // the button rendered at its full 144px cap anyway, spilling
              // its text out over WeekPicker's own icon and label rather than
              // truncating. w-full makes it fill whatever width the parent's
              // shrink actually leaves it, so `truncate` on the name span
              // below has a real, definite box to ellipsize against.
              //
              // tap-target: px-1 py-0.5 keeps this pill visually compact
              // (the whole point of `inline`, sitting flush beside WeekPicker
              // in the header), but that same tightness left its actual tap
              // area well under the touch minimum on phone — tap-target
              // widens the hit area via an invisible ::before, same trick
              // Composer's own icon buttons already use.
              'chat-week tap-target min-w-0 w-full max-w-xs shrink rounded-md bg-paper-raised px-1 py-0.5 normal-case tracking-normal transition-colors hover:bg-paper-sunken'
            : 'flex min-h-touch w-full items-center gap-2 rounded-lg bg-paper-raised px-2 py-1.5 text-left transition-colors hover:bg-paper-sunken'
        }
      >
        {activeClass ? (
          <span
            className="class-dot"
            aria-hidden="true"
            style={{ '--class-dot-color': `rgb(${classColor(activeClass.id).rgb})` }}
          />
        ) : null}
        {/* flex-1 in both branches now — inline was missing it, which left
            this span at its default flex-basis:auto/no-grow. Harmless while
            the button above had no real width ceiling of its own (auto just
            meant "take your content's width"), but now that the button is
            w-full this span needs flex-1 to actually claim the space that
            leaves it, rather than sizing off its own (untruncated) content
            again. */}
        <span className={inline ? 'min-w-0 flex-1 truncate' : 'min-w-0 flex-1 truncate text-sm font-medium text-ink'}>
          {(activeClass && displayName.get(activeClass.id)) || 'Choose a class'}
        </span>
        <ChevronsUpDown size={inline ? 12 : 14} aria-hidden="true" className="shrink-0 text-ink-faint" />
      </button>

      {mounted ? (
        <ul
          role="listbox"
          aria-label="Your classes"
          /* Inline: matches the trigger's own width (text + caret) exactly —
             w-full of this relative wrapper, whose only in-flow child is
             that trigger button — rather than a fixed 224px box that
             dangled far past a compact pill. The non-inline (full sidebar
             row) trigger still gets the fixed w-56 via left/right insets;
             that one has room to be a real menu width. */
          className={`neo-panel fa-card-drop absolute z-50 mt-1 overflow-hidden rounded-2xl bg-paper-raised py-1 ${
            inline ? 'left-0 w-full' : 'left-2 right-2 w-56'
          }${closing ? ' fa-chip-exit' : ''}`}
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
                /* The selected row's own fill/ink stays exactly what the
                   comment above the component argues for (--paper-inset +
                   --ok, never --accent). This border is additive, not a
                   replacement for that logic — a class-coloured edge so a
                   teacher with three preps can place each one before reading
                   the name, same job the rail's own dot already does. */
                style={{ borderLeft: `3px solid rgb(${classColor(c.id).rgb} / 0.7)` }}
                className={`flex min-h-touch w-full items-center gap-2 py-1.5 pl-2.5 pr-3 text-left text-sm transition-colors ${
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
                <span className="min-w-0 flex-1 truncate">{displayName.get(c.id)}</span>
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
