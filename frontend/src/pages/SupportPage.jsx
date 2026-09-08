import { useEffect, useMemo, useState } from 'react'
import { CircleHelp, FileText, Inbox, Info, Mail, PenLine, Send } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { SplitLayout } from '../components/SplitLayout'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useAuth } from '../lib/authContext'
import { api } from '../lib/api'
import { qk } from '../lib/queryKeys'
import { SUPPORT_EMAIL, SUPPORT_SUBJECT } from '../lib/support'
import { useNavigate, useParams } from 'react-router-dom'

const SUPPORT_TABS = [
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'sent', label: 'Sent', icon: Send },
  { id: 'compose', label: 'New message', icon: PenLine },
  { id: 'help', label: 'Support details', icon: Info },
]
const EMPTY_THREADS = []

const formatDate = (value) => {
  if (!value) return ''
  try {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value))
  } catch {
    return value
  }
}

function ThreadList({ items, selectedId, onSelect, empty }) {
  if (!items.length) {
    return (
      <div className="rounded-2xl border border-edge bg-paper-raised/50 p-6 text-center">
        <Inbox size={20} className="mx-auto text-ink-muted" aria-hidden="true" />
        <p className="mt-3 text-sm font-medium text-ink">{empty}</p>
      </div>
    )
  }
  return (
    <ul className="overflow-hidden rounded-2xl border border-edge bg-paper-raised/50">
      {items.map((thread) => (
        <li key={thread.id} className="border-b border-edge last:border-b-0">
          <button
            type="button"
            onClick={() => onSelect(thread.id)}
            aria-current={selectedId === thread.id ? 'true' : undefined}
            className={`w-full px-4 py-3 text-left transition-colors hover:bg-paper-inset ${selectedId === thread.id ? 'bg-paper-inset' : ''}`}
          >
            <div className="flex items-start justify-between gap-3">
              <span className="min-w-0 truncate text-sm font-semibold text-ink">{thread.subject}</span>
              <time className="shrink-0 text-2xs text-ink-muted">{formatDate(thread.last_message_at || thread.updated_at)}</time>
            </div>
            <p className="mt-1 truncate text-xs text-ink-muted">{thread.last_message || 'No messages yet'}</p>
            <div className="mt-2 flex items-center gap-2 text-2xs text-ink-faint">
              <span>{thread.last_author_type === 'support' ? 'FlexEd support' : 'You'}</span>
              {thread.unread_count ? <span className="rounded-full bg-accent px-1.5 py-0.5 font-semibold text-white">{thread.unread_count} new</span> : null}
            </div>
          </button>
        </li>
      ))}
    </ul>
  )
}

function ThreadViewer({ thread, reply, setReply, onReply, sending }) {
  if (!thread) {
    return (
      <div className="flex min-h-64 items-center justify-center rounded-2xl border border-dashed border-edge-strong bg-paper-raised/30 p-8 text-center">
        <div>
          <Mail size={22} className="mx-auto text-ink-muted" aria-hidden="true" />
          <p className="mt-3 text-sm text-ink-muted">Select a conversation to read it here.</p>
        </div>
      </div>
    )
  }
  return (
    <article className="overflow-hidden rounded-2xl border border-edge bg-paper-raised/50">
      <header className="border-b border-edge px-4 py-4">
        <p className="text-2xs font-semibold uppercase tracking-[0.14em] text-ink-muted">Support thread</p>
        <h3 className="mt-1 truncate text-base font-semibold text-ink">{thread.subject}</h3>
      </header>
      <div className="flex max-h-[30rem] flex-col gap-3 overflow-y-auto p-4">
        {(thread.messages || []).map((message) => (
          <div key={message.id} className={`max-w-[92%] rounded-2xl border p-3 ${message.author_type === 'teacher' ? 'self-end border-edge bg-paper-inset' : 'self-start border-accent/20 bg-accent-tint/30'}`}>
            <div className="flex items-center justify-between gap-3 text-2xs text-ink-muted">
              <span className="font-semibold text-ink">{message.author_type === 'teacher' ? 'You' : message.author_name || 'FlexEd support'}</span>
              <time>{formatDate(message.created_at)}</time>
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">{message.body}</p>
          </div>
        ))}
      </div>
      <form className="border-t border-edge p-4" onSubmit={onReply}>
        <label className="grid gap-2 text-sm font-semibold text-ink">
          Reply in FlexEd
          <textarea value={reply} onChange={(event) => setReply(event.target.value)} rows={3} maxLength={5000} placeholder="Write a reply to this support thread…" className="input w-full resize-y leading-relaxed" />
        </label>
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-2xs text-ink-muted">You can also reply from your email.</span>
          <button type="submit" className="btn btn-primary" disabled={!reply.trim() || sending}><Send size={14} className="mr-1.5" aria-hidden="true" />{sending ? 'Sending…' : 'Send reply'}</button>
        </div>
      </form>
    </article>
  )
}

function MailboxSection({ title, description, items, selectedId, onSelect, selectedThread, reply, setReply, onReply, sending, empty }) {
  const visibleThread = items.some((item) => item.id === selectedId) ? selectedThread : null
  return (
    <section id={`section-${title.toLowerCase()}`} className="scroll-mt-8 mb-14">
      <div className="border-b border-edge pb-4"><h2 className="text-xl font-semibold tracking-tight text-ink">{title}</h2><p className="mt-1 text-sm text-ink-muted">{description}</p></div>
      <div className="mt-6 grid gap-4 xl:grid-cols-[minmax(15rem,0.8fr)_minmax(0,1.2fr)]"><ThreadList items={items} selectedId={selectedId} onSelect={onSelect} empty={empty} /><ThreadViewer thread={visibleThread} reply={reply} setReply={setReply} onReply={onReply} sending={sending} /></div>
    </section>
  )
}

export function SupportPage() {
  useDocumentTitle('Contact support')
  const navigate = useNavigate()
  const { user } = useAuth()
  const { classId } = useParams()
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState(null)
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
  const sentThreads = threads

  useEffect(() => {
    if (!selectedId && threads[0]) setSelectedId(threads[0].id)
  }, [selectedId, threads])

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
      setComposeStatus(thread.email_sent === false ? 'Saved in FlexEd. Email delivery will begin when email notifications are configured.' : 'Message sent and saved to your FlexEd mailbox.')
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
  return (
    <SplitLayout title="Contact support" icon={Mail} tabs={SUPPORT_TABS} mobileTabs={SUPPORT_TABS} backPath={classId ? `/c/${classId}` : '/'} contentMaxWidth="max-w-5xl">
      <div className="w-full max-w-5xl pb-24">
        <MailboxSection title="Inbox" description="Replies from FlexEd support stay in this conversation history." items={inboxThreads} selectedId={selectedId} onSelect={setSelectedId} selectedThread={selectedThread} reply={reply} setReply={setReply} onReply={sendReply} sending={replyMutation.isPending} empty="Your support inbox is clear." />
        <MailboxSection title="Sent" description="Every support message you send is saved here." items={sentThreads} selectedId={selectedId} onSelect={setSelectedId} selectedThread={selectedThread} reply={reply} setReply={setReply} onReply={sendReply} sending={replyMutation.isPending} empty="No sent messages yet." />

        <section id="section-compose" className="scroll-mt-8 mb-14">
          <div className="border-b border-edge pb-4"><p className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-[0.16em] text-mark"><Mail size={13} aria-hidden="true" /> FlexEd Academy support</p><h2 className="mt-2 text-xl font-semibold tracking-tight text-ink">New message</h2><p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-muted">Start a support thread inside FlexEd. You can continue it here or reply from your regular email.</p></div>
          <form className="mt-6 rounded-2xl border border-edge bg-paper-raised/50 p-4 sm:p-6" onSubmit={sendNewMessage}>
            <div className="rounded-xl border border-edge bg-paper-sunken px-4">
              <div className="flex flex-col gap-1.5 border-b border-edge py-3 sm:flex-row sm:items-center sm:gap-6"><span className="w-16 shrink-0 text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">To</span><span className="text-sm font-medium text-ink">{SUPPORT_EMAIL} <span className="ml-2 text-xs font-normal text-ink-muted">FlexEd support</span></span></div>
              <div className="flex flex-col gap-1.5 border-b border-edge py-3 sm:flex-row sm:items-center sm:gap-6"><span className="w-16 shrink-0 text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">From</span><span className="truncate text-sm text-ink">{user?.email || 'Your account email'}</span></div>
              <label className="flex flex-col gap-1.5 py-3 sm:flex-row sm:items-center sm:gap-6"><span className="w-16 shrink-0 text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">Subject</span><input type="text" value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={120} className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-muted" /></label>
            </div>
            <label className="mt-5 grid gap-2 text-sm font-semibold text-ink">Message<textarea value={message} onChange={(event) => setMessage(event.target.value)} maxLength={5000} rows={8} required placeholder="Tell Josh what you noticed, what you were trying to do, or what you would improve." className="input min-h-48 w-full resize-y leading-relaxed" /></label>
            {composeStatus ? <p className="mt-3 text-sm text-ok" role="status">{composeStatus}</p> : null}
            {error ? <p className="mt-3 text-sm text-mark" role="alert">{error.message || 'Could not update your support mailbox.'}</p> : null}
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-ink-muted">Your message is stored in FlexEd even if email delivery is unavailable.</p><button type="submit" className="btn btn-primary" disabled={!message.trim() || createMutation.isPending}><Send size={14} className="mr-1.5" aria-hidden="true" />{createMutation.isPending ? 'Sending…' : 'Send message'}</button></div>
          </form>
        </section>

        <section id="section-help" className="scroll-mt-8"><div className="border-b border-edge pb-4"><h2 className="text-xl font-semibold tracking-tight text-ink">Support details</h2><p className="mt-1 text-sm text-ink-muted">Your in-app mailbox and regular email stay connected.</p></div><div className="mt-6 grid gap-3 sm:grid-cols-2"><div className="rounded-2xl border border-edge bg-paper-raised/50 p-5"><CircleHelp size={18} className="text-ink-muted" aria-hidden="true" /><h3 className="mt-3 font-semibold text-ink">One persistent thread</h3><p className="mt-1 text-sm leading-relaxed text-ink-muted">Every message is stored under your account, so your context and history remain available in FlexEd.</p></div><div className="rounded-2xl border border-edge bg-paper-raised/50 p-5"><FileText size={18} className="text-ink-muted" aria-hidden="true" /><h3 className="mt-3 font-semibold text-ink">Email when you need it</h3><p className="mt-1 text-sm leading-relaxed text-ink-muted">Email notifications can alert you to a reply, and replying from email brings the response back into this thread.</p></div></div><button type="button" className="btn mt-6" onClick={() => navigate(classId ? `/c/${classId}` : '/')}>Back to workspace</button></section>
      </div>
    </SplitLayout>
  )
}
