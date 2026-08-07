import { useMemo, useRef, useState } from 'react'
import { Link, NavLink, useNavigate, useParams } from 'react-router-dom'
import { GraduationCap, PanelLeft, Pencil, Plus, Trash2, X } from 'lucide-react'
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
          `flex min-h-touch items-center rounded-md px-2 pr-14 text-sm transition-colors ${
            isActive ? 'bg-paper-inset text-ink' : 'text-ink-soft hover:bg-paper-inset/60'
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
      navigate(classPath)
    } catch (err) {
      toast.apiError('Could not delete that chat', err)
    }
  }

  return (
    <>
      <div className="flex h-14 shrink-0 items-center gap-2 px-3">
        <span
          aria-hidden="true"
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-ink text-[0.75rem] font-bold text-ink-inverse"
        >
          F
        </span>
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
        <Link
          to={classPath}
          onClick={onNavigate}
          className="flex min-h-touch items-center gap-2 rounded-lg bg-paper-inset px-3 text-sm font-medium text-ink transition-colors hover:bg-edge"
        >
          <Plus size={15} aria-hidden="true" />
          <span className="flex-1">New plan</span>
          <kbd className="font-mono text-2xs text-ink-faint">⌘K</kbd>
        </Link>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto pt-2" aria-label="Your plans">
        <p className="eyebrow px-4 pb-1">Recent</p>
        {isLoading ? (
          <div className="px-4 py-2">
            <SkeletonText lines={4} />
          </div>
        ) : chats?.length ? (
          <ul className="flex flex-col gap-0.5">
            {chats.map((c) => (
              <ChatRow key={c.id} chat={c} classId={classId} onDelete={remove} />
            ))}
          </ul>
        ) : (
          <p className="px-4 py-2 text-xs text-ink-muted">
            Nothing yet. Describe a week to get started.
          </p>
        )}
      </nav>

      <div className="shrink-0 border-t border-edge">
        <NavLink
          to={`${classPath}/class`}
          onClick={onNavigate}
          className={({ isActive }) =>
            `flex min-h-touch items-center gap-2.5 px-4 text-sm transition-colors ${
              isActive ? 'text-ink' : 'text-ink-soft hover:text-ink'
            }`
          }
        >
          <GraduationCap size={15} aria-hidden="true" /> My classes
        </NavLink>
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
  useFocusTrap(drawerRef, { active: drawerOpen, trap: drawerOpen, onEscape: () => setDrawerOpen(false) })

  return (
    <ShellContext.Provider value={shell}>
    <div className="flex h-app w-full overflow-hidden bg-paper font-sans text-ink">
      <a
        className="sr-only transition-all focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-ink focus:px-4 focus:py-2 focus:text-ink-inverse focus:shadow-md"
        href="#main"
      >
        Skip to content
      </a>

      {/* docked */}
      {!isNarrow ? (
        <div
          className="flex shrink-0 flex-col overflow-hidden border-r border-edge bg-paper-sunken transition-[width] duration-300 ease-out"
          style={{ width: docOpen ? 'var(--sidebar-w-tight)' : 'var(--sidebar-w)' }}
        >
          <Rail />
        </div>
      ) : null}

      {/* drawer */}
      {isNarrow && drawerOpen ? (
        <>
          <button
            type="button"
            className="fixed inset-0 z-40 bg-[var(--scrim)]"
            aria-label="Close menu"
            onClick={() => setDrawerOpen(false)}
          />
          <div
            ref={drawerRef}
            className="fixed inset-y-0 left-0 z-50 flex w-[min(300px,85vw)] flex-col bg-paper-sunken shadow-lg"
          >
            <Rail onNavigate={() => setDrawerOpen(false)} onClose={() => setDrawerOpen(false)} />
          </div>
        </>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden" id="main">
        {isNarrow ? (
          <div className="flex h-12 shrink-0 items-center gap-1 border-b border-edge px-2">
            <button
              type="button"
              className="btn-icon"
              aria-label="Show menu"
              onClick={() => setDrawerOpen(true)}
            >
              <PanelLeft size={17} aria-hidden="true" />
            </button>
          </div>
        ) : null}
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </div>
    </ShellContext.Provider>
  )
}
