import { useEffect, useRef, useState } from 'react'
import { NavLink } from 'react-router-dom'
import {
  BookMarked,
  Check,
  FileText,
  GraduationCap,
  MessageSquare,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react'

/* New · Plans · Standards · My Class. The Projects and Scheduled stubs are gone —
   nav that says "coming soon" reads as unfinished. */
const NAV = [
  { to: '/plans', label: 'Plans', Icon: FileText },
  { to: '/standards', label: 'Standards', Icon: BookMarked },
  { to: '/my-class', label: 'My Class', Icon: GraduationCap },
]

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
      <div className="chat-row">
        <input
          ref={inputRef}
          className="chat-rename-input"
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
        <div className="chat-row-actions" style={{ opacity: 1 }}>
          <button type="button" className="btn-icon" onClick={commit} aria-label="Save name">
            <Check size={13} aria-hidden="true" />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={`chat-row${isActive ? ' is-active' : ''}`}>
      {/* A real button, not a clickable div — the old rows were unreachable by keyboard. */}
      <button type="button" className="chat-row-btn" onClick={() => onOpen(chat.id)}>
        <MessageSquare size={12} aria-hidden="true" />
        <span>{chat.title}</span>
      </button>
      <div className="chat-row-actions">
        <button
          type="button"
          className="btn-icon"
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
          className="btn-icon is-danger"
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
}) {
  const initials = (settings?.teacher || 'Teacher')
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return (
    <nav
      className={`sidebar${collapsed ? ' is-collapsed' : ''}`}
      aria-label="Main"
      aria-hidden={collapsed || undefined}
    >
      <div className="sidebar-head">
        <span className="wordmark">
          <img src="/logo.png" alt="" aria-hidden="true" />
          <span>AP&nbsp;Lang Planner</span>
        </span>
        <div className="topbar-spacer" />
        <button
          type="button"
          className="btn-icon only-narrow"
          onClick={onClose}
          aria-label="Close menu"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      <div className="sidebar-nav">
        <button type="button" className="nav-item" onClick={onNewChat}>
          <Plus size={14} aria-hidden="true" /> New plan
        </button>
        {NAV.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => `nav-item${isActive ? ' is-active' : ''}`}
          >
            <Icon size={14} aria-hidden="true" /> {label}
          </NavLink>
        ))}
      </div>

      <div className="sidebar-scroll">
        <div className="sidebar-section">
          <span className="eyebrow">Recent</span>
        </div>
        {chats.length === 0 ? (
          <p
            style={{
              padding: '0 var(--sp-3)',
              fontSize: 'var(--fs-xs)',
              color: 'var(--ink-faint)',
            }}
          >
            Nothing yet. Describe a week to get started.
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

      <div className="sidebar-foot">
        <span className="avatar" aria-hidden="true">
          {initials}
        </span>
        <span className="sidebar-foot-id">
          <strong>{settings?.teacher || 'Teacher'}</strong>
          <small>{settings?.course || 'AP Language & Composition'}</small>
        </span>
      </div>
    </nav>
  )
}
