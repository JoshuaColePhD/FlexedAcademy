import { useMemo, useRef, useState } from 'react'
import { useExitTransition } from '../hooks/useExitTransition'
import { Link, NavLink, useLocation, useNavigate, useParams } from 'react-router-dom'
import { ChevronRight, FileText, PanelLeft, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useActiveClass, useChats, useDeleteChat, useRenameChat } from '../hooks/useAppData'
import { ShellContext } from '../lib/shellContext'
import { useConfirm } from '../lib/confirmContext'
import { useToast } from '../lib/toastContext'
import { NARROW, useMediaQuery } from '../hooks/useMediaQuery'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { ClassSwitcher } from './ClassSwitcher'
import { AccountMenu } from './AccountMenu'
import { SkeletonText } from './Skeleton'

/* The frame. A chat client's shape, which is what this is now.
 *
 * The rail is a plain flex column, not a resizable <Panel> — that is what forced
 * two nested PanelGroups with two fighting layout ids, and nobody resizes a
 * 264px nav. The one PanelGroup left splits the chat from the plan.
 */

function ChatRow({ chat, classId, onDelete }) {
  const rename = useRenameChat()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(chat.title)

  const commit = () => {
    const next = draft.trim()
    setEditing(false)
    if (next && next !== chat.title) rename.mutate({ id: chat.id, title: next })
    else setDraft(chat.title)
  }

  if (editing) {
    return (
      <li className="px-2">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              setDraft(chat.title)
              setEditing(false)
            }
          }}
          aria-label={`Rename ${chat.title}`}
          className="w-full rounded-md bg-paper-inset px-2 py-1.5 text-sm text-ink outline-none"
        />
      </li>
    )
  }

  return (
    <li className="group relative px-2">
      <NavLink
        to={`/c/${classId}/chat/${chat.id}`}
        className={({ isActive }) =>
          /* neo-inset, not a background tint — "pressed in" is what already
             means "selected" in this world (see every neo-raised button's
             own :active state), so the active row reads as a permanent
             version of that same press instead of a third, unrelated
             signal. */
          `flex min-h-touch items-center rounded-md px-2 pr-14 text-sm transition-colors ${
            isActive ? 'neo-inset text-ink' : 'text-ink-soft hover:bg-paper-inset/60'
          }`
        }
      >
        <span className="truncate">{chat.title}</span>
      </NavLink>
      <span className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <button
          type="button"
          className="btn-icon"
          aria-label={`Rename ${chat.title}`}
          onClick={() => setEditing(true)}
        >
          <Pencil size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="btn-icon"
          aria-label={`Delete ${chat.title}`}
          onClick={() => onDelete(chat)}
        >
          <Trash2 size={13} aria-hidden="true" />
        </button>
      </span>
    </li>
  )
}

function Rail({ onNavigate, onClose }) {
  const { classId } = useParams()
  const location = useLocation()
  const { classes, activeClass } = useActiveClass()
  const { data: chats, isLoading } = useChats()
  const deleteChat = useDeleteChat()
  const confirm = useConfirm()
  const toast = useToast()
  const navigate = useNavigate()
  const classPath = `/c/${classId}`

  const remove = async (chat) => {
    const ok = await confirm({
      title: `Delete “${chat.title}”?`,
      body: 'The lesson plan it produced is kept.',
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!ok) return
    try {
      await deleteChat.mutateAsync(chat.id)
      /* Only leave if the chat that just went away is the one on screen.
         This used to navigate unconditionally, so tidying up an old chat in
         the sidebar closed the conversation you were in the middle of — the
         plan you were reading disappeared and you were dropped on the greeting
         screen, for deleting something else entirely. */
      if (location.pathname.startsWith(`${classPath}/chat/${chat.id}`)) navigate(classPath)
    } catch (err) {
      toast.apiError('Could not delete that chat', err)
    }
  }

  return (
    <>
      <div className="flex h-14 shrink-0 items-center gap-2 px-3">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight text-ink">
          Flexed Academy
        </span>
        {onClose ? (
          <button type="button" className="btn-icon" aria-label="Close menu" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <ClassSwitcher classes={classes} activeClass={activeClass} classPath={classPath} />

      <div className="px-2 pb-1 pt-1">
        {/* The one thing a teacher opens this app to do. Was .rail-cta's own
            --rail-pop teal (colorize.md) — a token .neo-world doesn't
            redeclare, so it rendered as a mismatched accent against the
            rose/cream palette here. neo-raised + the redeclared --accent
            tokens makes it the one floating, emphasized control in the
            rail instead — still the rarest warm note, just this world's
            warm note. */}
        <Link
          to={classPath}
          onClick={onNavigate}
          className="neo-raised flex min-h-touch items-center gap-2 rounded-lg bg-accent-tint px-3 text-sm font-medium text-accent-text"
        >
          <Plus size={15} aria-hidden="true" />
          <span className="flex-1">New plan</span>
          <kbd className="font-mono text-2xs">⌘K</kbd>
        </Link>
      </div>



      <nav className="min-h-0 flex-1 flex flex-col pt-2" aria-label="Your plans">
        <div className="flex items-center justify-between px-4 pb-1">
          <p className="eyebrow">Recent</p>
          <Link
            to={`${classPath}/history`}
            onClick={onNavigate}
            className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-ink-muted hover:text-ink"
            aria-label="Edit chat history"
          >
            <Pencil size={11} aria-hidden="true" />
            Edit
          </Link>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="px-4 py-2">
            <SkeletonText lines={4} />
          </div>
        ) : chats?.length ? (
          <div className="flex flex-col pb-4">
            <ul className="flex flex-col gap-0.5">
              {chats.map((c) => (
                <ChatRow key={c.id} chat={c} classId={classId} onDelete={remove} />
              ))}
            </ul>
          </div>
        ) : (
          <p className="px-4 py-2 text-xs text-ink-muted">
            Nothing yet. Describe a week to get started.
          </p>
        )}
        </div>
      </nav>

      <div className="shrink-0 border-t border-edge">
        {/* Every plan this class has ever built, placed at the bottom near account settings. */}
        <NavLink
          to={`${classPath}/plans`}
          onClick={onNavigate}
          className={({ isActive }) =>
            `flex min-h-touch items-center gap-2.5 px-4 text-sm transition-colors ${
              isActive ? 'text-ink' : 'text-ink-soft hover:text-ink'
            }`
          }
        >
          <FileText size={15} aria-hidden="true" /> Library
        </NavLink>
        {/* Only rendered for is_admin accounts — everyone else never sees this
            link exists. The route and every request it makes are gated again
            server-side, so this is convenience, not the security boundary. */}
        <AccountMenu classPath={classPath} />
      </div>
    </>
  )
}

export function AppShell({ children }) {
  const isNarrow = useMediaQuery(NARROW)
  const [drawerOpen, setDrawerOpen] = useState(false)
  /* Owned here, set by ChatPage — see lib/shellContext.js. The rail is the one
     column with slack in it, so it gives up 48px while the document is open. */
  const [docOpen, setDocOpen] = useState(false)
  const shell = useMemo(() => ({ docOpen, setDocOpen }), [docOpen])
  const drawerRef = useRef(null)
  const drawerExit = useExitTransition(drawerOpen, 130)
  useFocusTrap(drawerRef, { active: drawerOpen, trap: drawerOpen, onEscape: () => setDrawerOpen(false) })

  /* Desktop-dock only — the narrow/phone drawer above already has its own
     open/close (drawerOpen). At >=lg the rail used to be a permanent fixture
     with no way to reclaim its width, unlike the artifact rail on the other
     side of the screen, which has had a collapse handle from the start.
     Persisted the same way chatWidthPx is (ChatPage.jsx), so it survives a
     reload instead of springing back open every visit. */
  const [railCollapsed, setRailCollapsed] = useState(() => {
    try {
      return localStorage.getItem('aplang.railCollapsed') === '1'
    } catch {
      return false
    }
  })
  const toggleRailCollapsed = () => {
    setRailCollapsed((collapsed) => {
      const next = !collapsed
      try {
        localStorage.setItem('aplang.railCollapsed', next ? '1' : '0')
      } catch {
        /* not persisted */
      }
      return next
    })
  }

  return (
    <ShellContext.Provider value={shell}>
    {/* neo-world here, not per-surface: this is the one root every
        authenticated screen (chat, class page, the rail, every dialog and
        toast rendered inside them) already mounts under, and every one of
        them already reads bg-paper/text-ink/etc. through Tailwind — the
        whole complete-overhaul ask, from a single class. Public pages
        (landing, login/signup) keep their own separate fixed world
        (.auth-ground) — a different deliberate brand system, not this
        one, and AppShell never wraps them anyway. */}
    <div className="app-texture neo-world flex h-app w-full overflow-hidden bg-paper font-sans text-ink">
      <a
        className="sr-only transition-all focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-ink focus:px-4 focus:py-2 focus:text-ink-inverse focus:shadow-md"
        href="#main"
      >
        Skip to content
      </a>

      {/* docked */}
      {!isNarrow ? (
        <div
          className="app-rail flex shrink-0 flex-row overflow-hidden transition-[width]"
          style={{
            width: railCollapsed ? '14px' : docOpen ? 'var(--sidebar-w-tight)' : 'var(--sidebar-w)',
            transitionDuration: 'var(--t-base)',
            transitionTimingFunction: 'var(--ease-out)',
          }}
        >
          {!railCollapsed ? (
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              <Rail />
            </div>
          ) : null}
          {/* Same seam-handle language as the artifact rail's own collapse
              control on the other side of the screen (ArtifactRail.jsx) —
              a groove found by hover/touch, not a labeled button competing
              with everything else in the header. */}
          <button
            type="button"
            className="app-rail-handle tap-target"
            onClick={toggleRailCollapsed}
            aria-expanded={!railCollapsed}
            aria-label={railCollapsed ? 'Show the sidebar' : 'Collapse the sidebar'}
            title={railCollapsed ? 'Show the sidebar' : 'Collapse the sidebar'}
          >
            {railCollapsed ? <ChevronRight className="app-rail-handle-arrow" aria-hidden="true" /> : null}
          </button>
        </div>
      ) : null}

      {/* drawer */}
      {isNarrow && drawerExit.mounted ? (
        <>
          <button
            type="button"
            className={`panel-scrim${drawerExit.closing ? ' is-closing' : ''}`}
            aria-label="Close menu"
            onClick={() => setDrawerOpen(false)}
          />
          <div
            ref={drawerRef}
            className={`app-rail rail-drawer${drawerExit.closing ? ' is-closing' : ''} fixed inset-y-0 left-0 z-50 flex w-[min(300px,85vw)] flex-col shadow-lg`}
          >
            <Rail onNavigate={() => setDrawerOpen(false)} onClose={() => setDrawerOpen(false)} />
          </div>
        </>
      ) : null}

      <div className="relative z-10 flex min-w-0 flex-1 flex-col overflow-hidden" id="main">
        {/* Same wash as the rail's two glows, scoped to this pane instead of
            the viewport — the chat column read as a flat, unlit rectangle
            next to the rail's lit glass. z-index: -1 keeps it under #main's
            own content (the header bar and children below) without needing
            to touch either of those. */}
        {isNarrow ? (
          <div className="relative flex h-12 shrink-0 items-center gap-2 border-b border-edge px-2">
            <button
              type="button"
              className="btn-icon"
              aria-label="Show menu"
              onClick={() => setDrawerOpen(true)}
            >
              <PanelLeft size={17} aria-hidden="true" />
            </button>
            {/* The drawer carries the same wordmark (see Rail, above), but with
                the rail closed by default on a phone there was nothing on
                screen naming the app at all — just a browser tab bar showing
                the bare domain. Absolutely centered on the bar itself, not
                the leftover space beside the menu button — flex-1 centered
                it against the wrong span and it read as off-center next to
                a button with no matching weight on the right. */}
            <span className="pointer-events-none absolute inset-x-0 truncate text-center text-sm font-semibold tracking-tight text-ink">
              Flexed Academy
            </span>
          </div>
        ) : null}
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </div>
    </ShellContext.Provider>
  )
}
