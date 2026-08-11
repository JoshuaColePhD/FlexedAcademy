import { useState } from 'react'
import { Link } from 'react-router-dom'
import { MessageSquare, Search, Trash2, CheckSquare, Square } from 'lucide-react'
import { useToast } from '../lib/toastContext'
import { useConfirm } from '../lib/confirmContext'
import { useActiveClass, useChats, useDeleteChat } from '../hooks/useAppData'
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

function ChatHistoryRow({ chat, classId, onDelete, deleting, selectionMode, selected, onToggleSelect }) {
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
        <span className="block truncate text-sm font-medium text-ink">
          {label}
        </span>
        <span className="block truncate text-xs text-ink-muted">
          {formatDate(chat.created_at)}
        </span>
      </span>
    </>
  )

  if (selectionMode) {
    return (
      <li className="group flex items-center gap-1 px-2 py-1">
        <button
          type="button"
          onClick={() => onToggleSelect(chat.id)}
          className="flex min-h-touch min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 text-left transition-colors hover:bg-paper-sunken"
        >
          {content}
        </button>
      </li>
    )
  }

  return (
    <li className="group flex items-center gap-1 px-2 py-1">
      <Link
        to={`/c/${classId}/chat/${chat.id}`}
        className="flex min-h-touch min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 transition-colors hover:bg-paper-sunken"
      >
        {content}
      </Link>
      <span className="flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <button
          type="button"
          className="btn-icon"
          onClick={() => onDelete(chat)}
          disabled={deleting}
          aria-label={`Delete ${label}`}
          title="Delete"
        >
          <Trash2 size={13} aria-hidden="true" />
        </button>
      </span>
    </li>
  )
}

export function HistoryPage() {
  const { classId, activeClass } = useActiveClass()
  const { data: chats, isLoading, isError, error } = useChats()
  const deleteChat = useDeleteChat()
  const confirm = useConfirm()
  const toast = useToast()
  const [search, setSearch] = useState('')
  const [deletingId, setDeletingId] = useState(null)
  
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [isDeletingBulk, setIsDeletingBulk] = useState(false)

  const items = chats || []
  const filtered = search.trim() ? items.filter((c) => matchesSearch(c, search)) : items

  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === filtered.length && filtered.length > 0) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filtered.map(c => c.id)))
    }
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
      setSelectionMode(false)
      toast.success(`Deleted ${arr.length} chats`)
    } catch (err) {
      toast.apiError('Could not delete all selected chats', err)
    } finally {
      setIsDeletingBulk(false)
    }
  }

  const remove = async (chat) => {
    const ok = await confirm({
      title: `Delete “${chat.title}”?`,
      body: 'The lesson plan it produced is kept.',
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!ok) return
    setDeletingId(chat.id)
    try {
      await deleteChat.mutateAsync(chat.id)
    } catch (err) {
      toast.apiError('Could not delete that chat', err)
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="flex h-app flex-col bg-paper font-sans text-ink">
      <header className="flex h-14 shrink-0 items-center justify-between px-gutter">
        <h1 className="text-sm font-semibold text-ink">
          History{activeClass?.name ? ` — ${activeClass.name}` : ''}
        </h1>
        <div className="flex items-center gap-3">
          {selectionMode ? (
            <>
              <button
                type="button"
                disabled={isDeletingBulk}
                onClick={toggleSelectAll}
                className="text-xs font-medium text-ink-muted hover:text-ink disabled:opacity-50"
              >
                {selectedIds.size === filtered.length && filtered.length > 0 ? 'Deselect all' : 'Select all'}
              </button>
              <button
                type="button"
                disabled={selectedIds.size === 0 || isDeletingBulk}
                onClick={handleBulkDelete}
                className="text-xs font-medium text-mark hover:text-mark/80 disabled:opacity-50"
              >
                Delete ({selectedIds.size})
              </button>
              <button
                type="button"
                disabled={isDeletingBulk}
                onClick={() => {
                  setSelectionMode(false)
                  setSelectedIds(new Set())
                }}
                className="text-xs font-medium text-ink-muted hover:text-ink disabled:opacity-50"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setSelectionMode(true)}
              className="text-xs font-medium text-ink-muted hover:text-ink"
            >
              Select multiple
            </button>
          )}
        </div>
      </header>

      <div className="page scroll-y">
        <div className="mx-auto w-full max-w-measure-form">
          {items.length >= SEARCH_THRESHOLD ? (
            <div className="relative mb-6 px-4">
              <Search
                size={14}
                className="absolute left-7 top-1/2 -translate-y-1/2 text-ink-faint"
                aria-hidden="true"
              />
              <input
                type="text"
                placeholder="Search history…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-md border border-edge bg-transparent py-1.5 pl-9 pr-3 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                aria-label="Search history"
              />
            </div>
          ) : null}

          {isLoading ? (
            <div className="px-4">
              <SkeletonText lines={10} />
            </div>
          ) : isError ? (
            <div className="px-4">
              <p className="text-sm font-medium text-mark">Could not load history</p>
              <p className="text-xs text-ink-muted">{errorParts(error).message}</p>
            </div>
          ) : filtered.length > 0 ? (
            <ul className="flex flex-col pb-12">
              {filtered.map((c) => (
                <ChatHistoryRow
                  key={c.id}
                  chat={c}
                  classId={classId}
                  onDelete={remove}
                  deleting={deletingId === c.id}
                  selectionMode={selectionMode}
                  selected={selectedIds.has(c.id)}
                  onToggleSelect={toggleSelect}
                />
              ))}
            </ul>
          ) : (
            <div className="px-4 text-center">
              <p className="text-sm font-medium text-ink">No chats found</p>
              {search ? (
                <p className="text-xs text-ink-muted">Nothing matched your search.</p>
              ) : (
                <p className="text-xs text-ink-muted">You haven't built anything yet.</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
