import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, CircleHelp, FileText, Inbox, Info, Mail, MailOpen, PenLine, RefreshCw, Send } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { SplitLayout } from '../components/SplitLayout'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useAuth } from '../lib/authContext'
import { api } from '../lib/api'
import { qk } from '../lib/queryKeys'
import { SUPPORT_SUBJECT } from '../lib/support'
import { useNavigate, useParams } from 'react-router-dom'

const EMPTY_THREADS = []
const SUPPORT_MAILBOX_OPENED_KEY = 'flexed.support.mailbox.opened'

const threadTimestamp = (thread) => {
  const timestamp = Date.parse(thread?.last_message_at || thread?.updated_at || '')
  return Number.isNaN(timestamp) ? 0 : timestamp
}

const formatDate = (value) => {
  if (!value) return ''
  try {
    const date = new Date(value)
    const now = new Date()
    const sameDay = date.toDateString() === now.toDateString()
    return new Intl.DateTimeFormat(undefined, sameDay
      ? { hour: 'numeric', minute: '2-digit' }
      : { month: 'short', day: 'numeric' }
    ).format(date)
  } catch {
    return value
  }
}

const formatFullDate = (value) => {
  if (!value) return ''
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  } catch {
    return value
  }
}

const senderLabel = (thread) => thread.last_author_type === 'support' ? 'FlexEd support' : 'You'

const SUPPORT_TABS = [
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'sent', label: 'Sent', icon: Send },
  { id: 'help', label: 'Support details', icon: Info },
]

function MailboxToolbar({ items, selectedIds, onSelectAll, onRefresh, refreshing, onMarkRead }) {
  const allSelected = items.length > 0 && items.every((thread) => selectedIds.has(thread.id))
  return (
    <div className="support-mail-toolbar">
      <label className="support-mail-checkbox" title={allSelected ? 'Clear selection' : 'Select all conversations'}>
        <input type="checkbox" checked={allSelected} onChange={(event) => onSelectAll(event.target.checked)} aria-label={allSelected ? 'Clear conversation selection' : 'Select all conversations'} />
        <span aria-hidden="true" />
      </label>
      <button type="button" className="support-mail-toolbar-button" onClick={onRefresh} disabled={refreshing} aria-label="Refresh inbox" title="Refresh">
        <RefreshCw size={16} aria-hidden="true" className={refreshing ? 'animate-spin' : ''} />
      </button>
      {selectedIds.size ? (
        <button type="button" className="support-mail-toolbar-button" onClick={onMarkRead} aria-label="Mark selected as read" title="Mark selected as read">
          <MailOpen size={16} aria-hidden="true" />
        </button>
      ) : null}
      <span className="support-mail-toolbar-count">
        {selectedIds.size ? `${selectedIds.size} selected` : `${items.length} ${items.length === 1 ? 'conversation' : 'conversations'}`}
      </span>
    </div>
  )
}

function ThreadList({ items, selectedId, selectedIds, onSelect, onToggleSelected, empty }) {
  if (!items.length) {
    return (
      <div className="support-mail-empty">
        <Inbox size={24} aria-hidden="true" />
        <p>{empty}</p>
        <span>New support conversations will appear here.</span>
      </div>
    )
  }

  return (
    <ul className="support-mail-list" aria-label="Support conversations">
      {items.map((thread) => {
        const unread = Boolean(thread.unread_count)
        return (
          <li key={thread.id} className={`support-mail-row${selectedId === thread.id ? ' is-selected' : ''}${unread ? ' is-unread' : ''}`}>
            <label className="support-mail-checkbox" title={`Select ${thread.subject}`}>
              <input type="checkbox" checked={selectedIds.has(thread.id)} onChange={() => onToggleSelected(thread.id)} aria-label={`Select ${thread.subject}`} />
              <span aria-hidden="true" />
            </label>
            <button type="button" className="support-mail-row-main" onClick={() => onSelect(thread.id)}>
              <span className="support-mail-sender">{senderLabel(thread)}</span>
              <span className="support-mail-subject">{thread.subject}</span>
              <span className="support-mail-snippet"> — {thread.last_message || 'No messages yet'}</span>
              <time dateTime={thread.last_message_at || thread.updated_at}>{formatDate(thread.last_message_at || thread.updated_at)}</time>
              {unread ? <span className="support-mail-unread-count">{thread.unread_count}</span> : null}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function ThreadViewer({ thread, reply, setReply, onReply, sending, onBack }) {
  if (!thread) {
    return (
      <div className="support-reading-empty">
        <Mail size={28} aria-hidden="true" />
        <p>Select a conversation to read it here.</p>
        <span>Your support messages and replies will stay together in one thread.</span>
      </div>
    )
  }

  return (
    <article className="support-reading-pane">
      <header className="support-reading-header">
        <button type="button" className="support-reading-back" onClick={onBack} aria-label="Back to conversations">
          <ChevronLeft size={18} aria-hidden="true" />
          <span>Inbox</span>
        </button>
        <div className="support-reading-title-row">
          <div className="support-mail-avatar" aria-hidden="true">{senderLabel(thread).slice(0, 1)}</div>
          <div className="min-w-0">
            <h3>{thread.subject}</h3>
            <p>{senderLabel(thread)} · support thread</p>
          </div>
        </div>
      </header>
      <div className="support-reading-messages">
        {(thread.messages || []).map((message) => (
          <section key={message.id} className={`support-reading-message${message.author_type === 'teacher' ? ' is-teacher' : ''}`}>
            <div className="support-reading-message-head">
              <div className="support-mail-avatar support-mail-avatar-small" aria-hidden="true">
                {(message.author_type === 'teacher' ? 'You' : message.author_name || 'FlexEd support').slice(0, 1)}
              </div>
              <div className="min-w-0">
                <strong>{message.author_type === 'teacher' ? 'You' : message.author_name || 'FlexEd support'}</strong>
                <span>to {message.author_type === 'teacher' ? 'FlexEd support' : 'you'}</span>
              </div>
              <time dateTime={message.created_at} title={formatFullDate(message.created_at)}>{formatFullDate(message.created_at)}</time>
            </div>
            <p className="support-reading-message-body">{message.body}</p>
          </section>
        ))}
      </div>
      <form className="support-reply-box" onSubmit={onReply}>
        <textarea value={reply} onChange={(event) => setReply(event.target.value)} rows={3} maxLength={5000} placeholder="Reply to this conversation…" aria-label="Reply to this support conversation" />
        <div className="support-reply-footer">
          <span>Replies stay in this support thread.</span>
          <button type="submit" className="btn btn-primary" disabled={!reply.trim() || sending}><Send size={14} aria-hidden="true" />{sending ? 'Sending…' : 'Send'}</button>
        </div>
      </form>
    </article>
  )
}

function MailboxView({ items, selectedId, selectedIds, onSelect, onToggleSelected, onSelectAll, onRefresh, refreshing, onMarkRead, selectedThread, reply, setReply, onReply, sending, empty, onBack }) {
  return (
    <section className="support-mailbox-view" aria-label="Support mailbox">
      <div className={`support-mailbox-grid${selectedThread ? ' has-selection' : ''}`}>
        <div className="support-mail-list-pane">
          <MailboxToolbar items={items} selectedIds={selectedIds} onSelectAll={onSelectAll} onRefresh={onRefresh} refreshing={refreshing} onMarkRead={onMarkRead} />
          <ThreadList items={items} selectedId={selectedId} selectedIds={selectedIds} onSelect={onSelect} onToggleSelected={onToggleSelected} empty={empty} />
        </div>
        <ThreadViewer thread={selectedThread} reply={reply} setReply={setReply} onReply={onReply} sending={sending} onBack={onBack} />
      </div>
    </section>
  )
}

function ComposeView({ user, subject, setSubject, message, setMessage, status, error, sending, onSubmit, onCancel }) {
  return (
    <section className="support-compose-view" aria-labelledby="support-compose-title">
      <div className="support-mailbox-heading">
        <div>
          <p className="eyebrow">FlexEd Academy support</p>
          <h2 id="support-compose-title">New message</h2>
        </div>
        <button type="button" className="support-secondary-button" onClick={onCancel}>Discard</button>
      </div>
      <form className="support-compose-card" onSubmit={onSubmit}>
        <div className="support-compose-meta">
          <div><span>To</span><strong>Support</strong></div>
          <div><span>From</span><strong>{user?.name || 'Your profile'}</strong></div>
          <label><span>Subject</span><input type="text" value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={120} /></label>
        </div>
        <textarea value={message} onChange={(event) => setMessage(event.target.value)} maxLength={5000} rows={12} required placeholder="Tell Josh what you noticed, what you were trying to do, or what you would improve." aria-label="Support message" />
        {status ? <p className="support-form-status" role="status">{status}</p> : null}
        {error ? <p className="support-form-error" role="alert">{error.message || 'Could not update your support mailbox.'}</p> : null}
        <div className="support-compose-footer">
          <span>Replies stay in this support thread.</span>
          <button type="submit" className="btn btn-primary" disabled={!message.trim() || sending}><Send size={14} aria-hidden="true" />{sending ? 'Sending…' : 'Send message'}</button>
        </div>
      </form>
    </section>
  )
}

function SupportDetails({ onBack }) {
  return (
    <section className="support-details-view" aria-labelledby="support-details-title">
      <div className="support-mailbox-heading">
        <div>
          <p className="eyebrow">FlexEd Academy support</p>
          <h2 id="support-details-title">Support details</h2>
        </div>
      </div>
      <div className="support-details-grid">
        <div><CircleHelp size={19} aria-hidden="true" /><h3>One persistent thread</h3><p>Every message is stored under your account, so your context and history remain available in FlexEd.</p></div>
        <div><FileText size={19} aria-hidden="true" /><h3>Replies stay together</h3><p>Your messages and Support replies remain in one thread, so the full context is easy to find.</p></div>
      </div>
      <button type="button" className="btn" onClick={onBack}>Back to workspace</button>
    </section>
  )
}

export function SupportPage() {
  useDocumentTitle('Contact support')
  const navigate = useNavigate()
  const { user } = useAuth()
  const { classId } = useParams()
  const queryClient = useQueryClient()
  const [activeView, setActiveView] = useState('inbox')
  const [initialRouteReady, setInitialRouteReady] = useState(false)
  const [selectedId, setSelectedId] = useState(null)
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [reply, setReply] = useState('')
  const [subject, setSubject] = useState(SUPPORT_SUBJECT)
  const [message, setMessage] = useState('')
  const [composeStatus, setComposeStatus] = useState('')

  const threadsQuery = useQuery({ queryKey: qk.supportThreads, queryFn: api.listSupportThreads })
  const threads = threadsQuery.data?.threads ?? EMPTY_THREADS
  const selectedFromList = threads.find((thread) => thread.id === selectedId) || null
  const selectedThreadQuery = useQuery({ queryKey: qk.supportThread(selectedId), queryFn: () => api.getSupportThread(selectedId), enabled: Boolean(selectedId) })
  const selectedThread = selectedThreadQuery.data || selectedFromList
  const inboxThreads = useMemo(() => threads.filter((thread) => thread.last_author_type === 'support' || thread.unread_count > 0), [threads])
  const newestUnreadThread = useMemo(() => [...threads]
    .filter((thread) => (thread.unread_count || 0) > 0)
    .sort((a, b) => threadTimestamp(b) - threadTimestamp(a))[0] || null, [threads])
  const sentThreads = threads
  const visibleThreads = activeView === 'inbox' ? inboxThreads : sentThreads
  const visibleSelectedThread = visibleThreads.some((thread) => thread.id === selectedId) ? selectedThread : null

  useEffect(() => {
    if (!user?.id || !threadsQuery.isFetched || threadsQuery.isError || initialRouteReady) return
    if (user.is_owner) {
      setInitialRouteReady(true)
      return
    }
    let firstVisit = false
    try {
      firstVisit = !window.localStorage.getItem(`${SUPPORT_MAILBOX_OPENED_KEY}:${user.id}`)
      window.localStorage.setItem(`${SUPPORT_MAILBOX_OPENED_KEY}:${user.id}`, '1')
    } catch {
      // Private browsing or blocked storage should not prevent the mailbox
      // from opening; it simply cannot remember the first-visit preference.
      firstVisit = true
    }

    if (newestUnreadThread) {
      setActiveView('inbox')
      setSelectedId(newestUnreadThread.id)
    } else if (firstVisit) {
      setActiveView('compose')
      setSelectedId(null)
    }
    setInitialRouteReady(true)
  }, [initialRouteReady, newestUnreadThread, threadsQuery.isError, threadsQuery.isFetched, user?.id, user?.is_owner])

  useEffect(() => {
    if (!initialRouteReady || activeView === 'compose' || activeView === 'help') return
    if (!visibleThreads.length) {
      setSelectedId(null)
      return
    }
    if (!selectedId || !visibleThreads.some((thread) => thread.id === selectedId)) setSelectedId(visibleThreads[0].id)
  }, [activeView, initialRouteReady, selectedId, visibleThreads])

  useEffect(() => {
    setSelectedIds((current) => new Set([...current].filter((id) => visibleThreads.some((thread) => thread.id === id))))
  }, [visibleThreads])

  useEffect(() => {
    setReply('')
  }, [selectedId])

  useEffect(() => {
    if (!selectedId || !selectedThread?.unread_count) return
    api.markSupportThreadRead(selectedId).then(() => queryClient.invalidateQueries({ queryKey: qk.supportThreads })).catch(() => {})
  }, [queryClient, selectedId, selectedThread?.unread_count])

  const createMutation = useMutation({
    mutationFn: api.createSupportThread,
    onSuccess: (thread) => {
      queryClient.invalidateQueries({ queryKey: qk.supportThreads })
      setSelectedId(thread.id)
      setMessage('')
      setSubject(SUPPORT_SUBJECT)
      setActiveView('sent')
      setComposeStatus('Message sent and saved to your FlexEd support inbox.')
    },
  })
  const replyMutation = useMutation({
    mutationFn: ({ id, body }) => api.addSupportMessage(id, body),
    onSuccess: (result) => {
      queryClient.setQueryData(qk.supportThread(selectedId), result.thread)
      queryClient.invalidateQueries({ queryKey: qk.supportThreads })
      setReply('')
    },
  })

  const refreshMailbox = () => threadsQuery.refetch()
  const selectAll = (checked) => setSelectedIds(checked ? new Set(visibleThreads.map((thread) => thread.id)) : new Set())
  const toggleSelected = (id) => setSelectedIds((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const markSelectedRead = async () => {
    const ids = [...selectedIds]
    await Promise.allSettled(ids.map((id) => api.markSupportThreadRead(id)))
    setSelectedIds(new Set())
    queryClient.invalidateQueries({ queryKey: qk.supportThreads })
  }
  const sendNewMessage = (event) => {
    event.preventDefault()
    if (!message.trim() || createMutation.isPending) return
    createMutation.reset()
    setComposeStatus('')
    createMutation.mutate({ subject: subject.trim() || SUPPORT_SUBJECT, message: message.trim() })
  }
  const sendReply = (event) => {
    event.preventDefault()
    if (!selectedId || !reply.trim() || replyMutation.isPending) return
    replyMutation.mutate({ id: selectedId, body: reply.trim() })
  }

  const error = createMutation.error || replyMutation.error || threadsQuery.error
  const tabCounts = SUPPORT_TABS.map((tab) => tab.id === 'inbox'
    ? { ...tab, count: inboxThreads.reduce((sum, thread) => sum + (thread.unread_count || 0), 0) || undefined }
    : tab
  )

  return (
    <SplitLayout
      title="Contact support"
      icon={Mail}
      tabs={tabCounts}
      mobileTabs={tabCounts}
      activeTab={activeView}
      onTabChange={setActiveView}
      sidebarTopAction={(
        <button
          type="button"
          className={`support-compose-action${activeView === 'compose' ? ' is-active' : ''}`}
          onClick={() => setActiveView('compose')}
          aria-current={activeView === 'compose' ? 'page' : undefined}
        >
          <PenLine size={16} aria-hidden="true" />
          <span>Compose</span>
        </button>
      )}
      backPath={classId ? `/c/${classId}` : '/'}
      contentMaxWidth="max-w-none"
    >
      <div className="support-mailbox-app">
        {activeView === 'inbox' ? <MailboxView items={inboxThreads} selectedId={selectedId} selectedIds={selectedIds} onSelect={setSelectedId} onToggleSelected={toggleSelected} onSelectAll={selectAll} onRefresh={refreshMailbox} refreshing={threadsQuery.isFetching} onMarkRead={markSelectedRead} selectedThread={visibleSelectedThread} reply={reply} setReply={setReply} onReply={sendReply} sending={replyMutation.isPending} empty="Your support inbox is clear." onBack={() => setSelectedId(null)} /> : null}
        {activeView === 'sent' ? <MailboxView items={sentThreads} selectedId={selectedId} selectedIds={selectedIds} onSelect={setSelectedId} onToggleSelected={toggleSelected} onSelectAll={selectAll} onRefresh={refreshMailbox} refreshing={threadsQuery.isFetching} onMarkRead={markSelectedRead} selectedThread={visibleSelectedThread} reply={reply} setReply={setReply} onReply={sendReply} sending={replyMutation.isPending} empty="No sent messages yet." onBack={() => setSelectedId(null)} /> : null}
        {activeView === 'compose' ? <ComposeView user={user} subject={subject} setSubject={setSubject} message={message} setMessage={setMessage} status={composeStatus} error={error} sending={createMutation.isPending} onSubmit={sendNewMessage} onCancel={() => setActiveView('inbox')} /> : null}
        {activeView === 'help' ? <SupportDetails onBack={() => navigate(classId ? `/c/${classId}` : '/')} /> : null}
      </div>
    </SplitLayout>
  )
}
