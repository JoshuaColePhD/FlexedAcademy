import { useEffect, useRef, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { SkeletonRows } from './Skeleton'
import { ThemeToggle } from './ThemeToggle'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { errorParts } from '../lib/apiError'
import { Check, PanelLeft, Pencil, Plus, SlidersHorizontal, Trash2, X } from 'lucide-react'

/* App.jsx binds Cmd/Ctrl+K. Sniffed once at module scope rather than per render
   — it cannot change while the tab is open. */
const SHORTCUT =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘K' : 'Ctrl K'

function ChatRow({ chat, isActive, onOpen, onRename, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(chat.title)
  const inputRef = useRef(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const commit = () => {
    const next = draft.trim()
    if (next && next !== chat.title) onRename(chat.id, next)
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="mx-2 my-px flex items-center gap-2 rounded-lg bg-paper-inset px-3 py-1">
        <input
          ref={inputRef}
          className="min-w-0 flex-1 border-none bg-transparent text-sm font-medium text-ink outline-none"
          value={draft}
          aria-label={`Rename ${chat.title}`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') {
              setDraft(chat.title)
              setEditing(false)
            }
          }}
          onBlur={commit}
        />
        <button
          type="button"
          className="rounded p-1 text-ink-muted transition-colors hover:text-ink"
          onClick={commit}
          aria-label="Save name"
        >
          <Check size={14} aria-hidden="true" />
        </button>
      </div>
    )
  }

  return (
    <div
      className={`group mx-2 my-px flex items-center justify-between rounded-lg transition-colors ${
        isActive
          ? 'bg-paper-inset font-medium text-ink'
          : 'text-ink-soft hover:bg-paper-inset/60 hover:text-ink'
      }`}
    >
      <button
        type="button"
        className="min-w-0 flex-1 truncate px-3 py-[0.4375rem] text-left text-sm"
        onClick={() => onOpen(chat.id)}
      >
        {chat.title}
      </button>
      <div
        className={`flex items-center pr-2 transition-opacity ${
          isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        }`}
      >
        <button
          type="button"
          className="rounded p-1 text-ink-muted transition-colors hover:text-ink"
          onClick={() => {
            setDraft(chat.title)
            setEditing(true)
          }}
          aria-label={`Rename ${chat.title}`}
        >
          <Pencil size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="rounded p-1 text-ink-muted transition-colors hover:text-mark"
          onClick={() => onDelete(chat)}
          aria-label={`Delete ${chat.title}`}
        >
          <Trash2 size={13} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

export function Sidebar({
  collapsed,
  onClose,
  chats,
  currentChatId,
  onNewChat,
  onOpenChat,
  onRenameChat,
  onDeleteChat,
  settings,
  onToggleSidebar,
  chatsError,
  chatsLoading,
  onRetryChats,
  isNarrow,
  theme,
}) {
  const navRef = useRef(null)

  useFocusTrap(navRef, {
    active: !!isNarrow && !collapsed,
    trap: true,
    onEscape: onClose,
  })

  return (
    <nav
      className="flex h-full w-full flex-col bg-paper-sunken"
      aria-label="Main"
      ref={navRef}
      inert={collapsed || undefined}
    >
      {/* Function-first name. "Flexed Academy" is the mark at the foot of the
          column, so a colleague doesn't have to learn a brand to trust the tool. */}
      <div className="flex h-14 shrink-0 items-center justify-between px-4">
        <NavLink
          to="/"
          className="text-sm font-semibold tracking-tight text-ink transition-colors hover:text-ink-soft"
        >
          Lesson Plans
        </NavLink>
        <button
          type="button"
          className="hidden rounded-lg p-1.5 text-ink-muted transition-colors hover:bg-paper-inset hover:text-ink sm:block"
          onClick={onToggleSidebar}
          aria-label="Collapse sidebar"
        >
          <PanelLeft size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="rounded-lg p-1.5 text-ink-muted transition-colors hover:bg-paper-inset hover:text-ink sm:hidden"
          onClick={onClose}
          aria-label="Close menu"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      <div className="flex shrink-0 flex-col gap-0.5 px-2 pb-2">
        {/* A row at nav weight rather than a filled button. The ⌘K hint is the
            only affordance that shortcut has ever had — App.jsx has bound it for
            a while with nothing anywhere telling anyone. */}
        <button
          type="button"
          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-ink-soft transition-colors hover:bg-paper-inset hover:text-ink"
          onClick={onNewChat}
        >
          <Plus size={16} aria-hidden="true" />
          <span className="flex-1 text-left">New plan</span>
          <span aria-hidden="true" className="text-[0.6875rem] text-ink-faint">
            {SHORTCUT}
          </span>
        </button>
        {/* Class setup used to live inside a dropdown at the foot of the
            sidebar, which is where a first-time user never looks. */}
        <NavLink
          to="/my-class"
          className={({ isActive }) =>
            `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              isActive ? 'bg-paper-inset text-ink' : 'text-ink-soft hover:bg-paper-inset hover:text-ink'
            }`
          }
        >
          <SlidersHorizontal size={16} aria-hidden="true" /> My class
        </NavLink>
      </div>

      <div className="mt-4 flex-1 overflow-y-auto pb-4">
        <p className="eyebrow mb-1 px-5">Recent</p>
        {chatsError ? (
          <div className="mx-2 flex flex-col items-start gap-2 rounded-xl border border-mark/25 bg-mark-tint px-4 py-3">
            <strong className="text-xs font-semibold text-mark">
              Couldn’t load your plans
            </strong>
            <small className="text-xs text-ink-soft">
              {errorParts(chatsError).hint || errorParts(chatsError).message}
            </small>
            <button
              type="button"
              className="rounded border border-mark/30 bg-paper-raised px-2 py-1 text-xs font-medium text-mark transition-colors hover:bg-mark-tint"
              onClick={onRetryChats}
            >
              Try again
            </button>
          </div>
        ) : chatsLoading && chats.length === 0 ? (
          <div className="px-4 opacity-60">
            <SkeletonRows rows={3} />
            <p className="visually-hidden" role="status">
              Loading your plans…
            </p>
          </div>
        ) : chats.length === 0 ? (
          <p className="px-5 text-sm leading-relaxed text-ink-muted">
            Nothing here yet. Start with <strong className="font-medium text-ink">New plan</strong>.
          </p>
        ) : (
          chats.map((chat) => (
            <ChatRow
              key={chat.id}
              chat={chat}
              isActive={chat.id === currentChatId}
              onOpen={onOpenChat}
              onRename={onRenameChat}
              onDelete={onDeleteChat}
            />
          ))
        )}
      </div>

      {/* One block, no rules. Since the composer no longer says which class a
          plan is for, this is the ONLY place that information lives — so it
          carries course AND framework, not just the teacher's name. */}
      <div className="mt-auto shrink-0 p-2">
        <div className="flex items-center gap-1 rounded-lg pr-1 transition-colors hover:bg-paper-inset">
          <NavLink to="/my-class" className="min-w-0 flex-1 rounded-lg px-3 py-2">
            <span className="block truncate text-sm font-medium text-ink">
              {settings?.teacher || 'Set up your class'}
            </span>
            <span className="mt-0.5 block truncate text-xs text-ink-muted">
              {[settings?.course, settings?.subject?.replace(/_/g, ' ')]
                .filter(Boolean)
                .join(' · ') || 'Name, course and standards'}
            </span>
          </NavLink>
          {theme ? <ThemeToggle mode={theme.mode} onCycle={theme.cycle} /> : null}
        </div>
        <p className="px-3 pt-2 text-[0.6875rem] font-medium tracking-caps text-ink-faint">
          Flexed Academy
        </p>
      </div>
    </nav>
  )
}
