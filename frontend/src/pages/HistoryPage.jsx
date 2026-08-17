import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Link, useNavigate } from 'react-router-dom'
import { MessageSquare, Search, Trash2, CheckSquare, Square, ArrowLeft, ArrowRight, Loader2 } from 'lucide-react'
import { useToast } from '../lib/toastContext'
import { useConfirm } from '../lib/confirmContext'
import { useActiveClass, useChats, useDeleteChat, useRenameChat } from '../hooks/useAppData'
import { errorParts } from '../lib/apiError'
import { SkeletonText } from '../components/Skeleton'

const SEARCH_THRESHOLD = 8

function matchesSearch(chat, query) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return chat.title?.toLowerCase().includes(q)
}

function formatDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function ChatHistoryRow({ chat, isActive, onClick, deleting, closing, selectionMode, selected, onToggleSelect }) {
  const label = chat.title || 'Untitled chat'

  const content = (
    <>
      {selectionMode ? (
        selected ? (
          <CheckSquare size={15} aria-hidden="true" className="shrink-0 text-accent" />
        ) : (
          <Square size={15} aria-hidden="true" className="shrink-0 text-ink-muted" />
        )
      ) : (
        <MessageSquare size={15} aria-hidden="true" className="shrink-0 text-ink-muted" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {label}
        </span>
        <span className="block truncate text-xs opacity-70">
          {formatDate(chat.created_at)}
        </span>
      </span>
    </>
  )

  if (selectionMode) {
    return (
      <button
        type="button"
        onClick={() => onToggleSelect(chat.id)}
        className={`flex w-full min-h-touch min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors ${
          selected ? 'bg-paper-inset text-ink' : 'text-ink-soft hover:bg-paper-inset hover:text-ink'
        }`}
      >
        {content}
      </button>
    )
  }

  return (
    <button
      onClick={() => onClick(chat)}
      className={`group flex w-full min-h-touch min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors ${
        isActive 
          ? 'bg-paper-inset font-medium text-ink' 
          : 'text-ink-soft hover:bg-paper-inset hover:text-ink'
      }`}
    >
      {content}
    </button>
  )
}

function GlobalHistoryDashboard({ chats, deleteChat, onDeleteCallback }) {
  const toast = useToast()
  const confirm = useConfirm()
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [isDeletingBulk, setIsDeletingBulk] = useState(false)

  const toggleSelectAll = () => {
    if (selectedIds.size === chats.length && chats.length > 0) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(chats.map(c => c.id)))
    }
  }

  const toggleSelect = (id) => {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelectedIds(next)
  }

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return
    const ok = await confirm({
      title: `Delete ${selectedIds.size} chat${selectedIds.size === 1 ? '' : 's'}?`,
      body: 'This removes the conversations. Any lesson plans built from them are kept in the Library.',
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!ok) return

    setIsDeletingBulk(true)
    try {
      const arr = Array.from(selectedIds)
      for (const id of arr) {
        await deleteChat.mutateAsync(id)
      }
      setSelectedIds(new Set())
      toast.success(`Deleted ${arr.length} chats`)
      onDeleteCallback?.()
    } catch (err) {
      toast.apiError('Could not delete all selected chats', err)
    } finally {
      setIsDeletingBulk(false)
    }
  }

  return (
    <div className="w-full max-w-3xl pb-16">
      <div className="mb-8 border-b border-edge pb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-ink">Chat History</h2>
          <p className="text-sm text-ink-muted">Select conversations to delete them in bulk.</p>
        </div>
      </div>

      <div className="neo-panel rounded-xl bg-paper/30 backdrop-blur-3xl saturate-[1.2] border border-white/5 shadow-inner shadow-white/5">
        <div className="flex items-center justify-between border-b border-edge bg-paper-sunken px-4 py-3 rounded-t-xl">
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={chats.length > 0 && selectedIds.size === chats.length}
              onChange={toggleSelectAll}
              className="h-4 w-4 rounded border-edge text-accent focus:ring-accent"
            />
            <span className="text-sm font-medium text-ink-muted">
              {selectedIds.size} selected
            </span>
          </div>
          {selectedIds.size > 0 && (
            <button
              type="button"
              disabled={isDeletingBulk}
              onClick={handleBulkDelete}
              className="neo-raised flex items-center gap-1.5 rounded-lg bg-mark px-3 py-1.5 text-sm font-medium text-white hover:bg-mark/90 disabled:opacity-50"
            >
              {isDeletingBulk ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
              Delete Selected
            </button>
          )}
        </div>

        <ul className="divide-y divide-edge">
          {chats.length === 0 ? (
            <li className="px-4 py-16 text-center">
              <MessageSquare size={32} className="mx-auto text-ink-faint mb-4" />
              <p className="text-sm font-medium text-ink">No conversations found</p>
              <p className="text-xs text-ink-muted mt-1">Start planning to see your history here.</p>
            </li>
          ) : (
            chats.map(c => (
              <li key={c.id} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-paper-inset">
                <input
                  type="checkbox"
                  checked={selectedIds.has(c.id)}
                  onChange={() => toggleSelect(c.id)}
                  className="h-4 w-4 rounded border-edge text-accent focus:ring-accent"
                />
                <div>
                  <p className="text-sm font-medium text-ink">{c.title || 'Untitled chat'}</p>
                  <p className="text-xs text-ink-muted">{formatDate(c.created_at)}</p>
                </div>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  )
}

function ChatDetailPanel({ chat, classId, onDelete }) {
  const navigate = useNavigate()
  const renameChat = useRenameChat()
  const [editingTitle, setEditingTitle] = useState(false)
  const [title, setTitle] = useState(chat.title || '')
  
  const handleRename = async () => {
    if (!title.trim() || title.trim() === chat.title) {
      setEditingTitle(false)
      return
    }
    try {
      await renameChat.mutateAsync({ id: chat.id, title: title.trim() })
    } catch {
      // toast will be handled by mutation if needed, or silently fail gracefully
    } finally {
      setEditingTitle(false)
    }
  }

  return (
    <div className="w-full max-w-2xl py-8">
      <div className="neo-world neo-panel rounded-xl p-6">
        <div className="mb-6 flex items-start justify-between">
          <div className="flex-1">
            {editingTitle ? (
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={handleRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                  if (e.key === 'Escape') {
                    setTitle(chat.title || '')
                    setEditingTitle(false)
                  }
                }}
                className="w-full rounded-lg border border-edge bg-paper px-3 py-1.5 text-xl font-semibold text-ink outline-none focus:border-accent"
              />
            ) : (
              <h2 
                className="text-xl font-semibold text-ink cursor-pointer hover:underline"
                onClick={() => {
                  setTitle(chat.title || '')
                  setEditingTitle(true)
                }}
                title="Click to rename"
              >
                {chat.title || 'Untitled chat'}
              </h2>
            )}
            <p className="mt-1 text-sm text-ink-muted">Started on {formatDate(chat.created_at)}</p>
          </div>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row pt-4 border-t border-edge">
          <Link
            to={`/c/${classId}/chat/${chat.id}`}
            className="neo-raised flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90"
          >
            Open Conversation <ArrowRight size={16} />
          </Link>
          <button
            type="button"
            onClick={() => onDelete(chat)}
            className="neo-raised flex items-center justify-center gap-2 rounded-lg bg-paper-inset px-4 py-2 text-sm font-medium text-mark hover:bg-mark-tint"
          >
            <Trash2 size={16} /> Delete Conversation
          </button>
        </div>
      </div>
    </div>
  )
}

export function HistoryPage() {
  const { classId } = useActiveClass()
  const navigate = useNavigate()
  const { data: chats, isLoading, isError } = useChats()
  const deleteChat = useDeleteChat()
  const confirm = useConfirm()
  const toast = useToast()
  
  const [search, setSearch] = useState('')
  const [activeChat, setActiveChat] = useState(null)
  
  const items = chats || []
  const filtered = search.trim() ? items.filter((c) => matchesSearch(c, search)) : items

  // Make sure activeChat still exists after a potential deletion
  const currentActiveChat = activeChat && items.find(c => c.id === activeChat.id) ? activeChat : null

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
      if (currentActiveChat?.id === chat.id) {
        setActiveChat(null)
      }
      toast.success('Chat deleted')
    } catch (err) {
      toast.apiError('Could not delete that chat', err)
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-paper/30 backdrop-blur-3xl saturate-[1.2] border border-white/5 shadow-inner shadow-white/5 font-sans">
      
      {/* Left Sidebar (Master) */}
      <div className={`flex w-full md:w-64 shrink-0 flex-col border-r border-edge bg-paper-sunken ${currentActiveChat ? 'hidden md:flex' : ''}`}>
        <header className="flex h-14 shrink-0 items-center gap-2 px-4">
          <button
            onClick={() => navigate(`/c/${classId}`)}
            aria-label="Back to Chat"
            className="rounded-md p-1.5 text-ink-muted transition-colors hover:bg-paper-inset hover:text-ink"
          >
            <ArrowLeft size={16} aria-hidden="true" />
          </button>
          <h1 className="text-sm font-semibold text-ink">Recent History</h1>
        </header>

        <div className="px-3 pb-3">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
            <input
              type="text"
              placeholder="Search history…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="neo-inset w-full rounded-md bg-paper py-1.5 pl-8 pr-3 text-xs text-ink placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-4">
          {isLoading ? (
            <div className="px-2">
              <SkeletonText lines={10} />
            </div>
          ) : isError ? (
            <div className="rounded-lg bg-mark-tint px-3 py-2.5">
              <p className="text-xs font-medium text-mark">Could not load history</p>
            </div>
          ) : filtered.length > 0 ? (
            <div className="flex flex-col gap-0.5">
              {filtered.map((c) => (
                <ChatHistoryRow
                  key={c.id}
                  chat={c}
                  isActive={currentActiveChat?.id === c.id}
                  onClick={(chat) => setActiveChat(chat)}
                />
              ))}
            </div>
          ) : (
            <div className="px-4 py-8 text-center">
              <p className="text-sm font-medium text-ink-muted">No chats found</p>
            </div>
          )}
        </div>
      </div>

      {/* Right Content Area (Detail) */}
      <div className={`flex-1 min-w-0 flex flex-col ${!currentActiveChat ? 'hidden md:flex' : ''}`}>
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-edge bg-paper/80 px-4 md:px-8 backdrop-blur-sm">
          <button
            onClick={() => setActiveChat(null)}
            className="md:hidden rounded-md p-1.5 text-ink-muted transition-colors hover:bg-paper-inset hover:text-ink"
            aria-label="Back to chat list"
          >
            <ArrowLeft size={16} aria-hidden="true" />
          </button>
          <div className="text-sm font-medium text-ink-muted">
            {currentActiveChat ? 'Conversation Details' : 'History Management'}
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-4 md:px-8 py-8 overflow-x-hidden relative">
          <AnimatePresence mode="wait">
            <motion.div
              key={currentActiveChat ? currentActiveChat.id : 'dashboard'}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.15 }}
              className="w-full"
            >
              {currentActiveChat ? (
                <ChatDetailPanel chat={currentActiveChat} classId={classId} onDelete={remove} />
              ) : (
                <GlobalHistoryDashboard 
                  chats={filtered} 
                  deleteChat={deleteChat} 
                  onDeleteCallback={() => setActiveChat(null)}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

    </div>
  )
}
