import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Lightbulb, MessageSquarePlus, Search, Sparkles, Trash2, Users } from 'lucide-react'
import { api } from '../lib/api'
import { qk } from '../lib/queryKeys'
import { useToast } from '../lib/toastContext'
import { useConfirm } from '../lib/confirmContext'
import { useChatStream } from '../hooks/useChatStream'
import { useLayoutMode } from '../hooks/useMediaQuery'
import { useCalendar, useChats, useDeleteChat } from '../hooks/useAppData'
import { defaultWeek } from '../lib/queue'
import { Composer } from '../components/Composer'
import { Message } from '../components/Message'
import { SkeletonText } from '../components/Skeleton'

/* The dedicated chat.
 *
 * useChatStream and POST /api/chat_stream have both existed the whole time and
 * nothing has ever called either of them — 98 lines of frontend and a
 * three-mode backend, orphaned. Its own system prompt ends "tell them they can
 * click the Generate Lesson Plan button", so the chat→week handoff was designed
 * and then never wired to anything.
 *
 * The important structural point: this is a place to THINK, not the container
 * the app lives in. Generating a plan happens on a week, at that week's URL.
 * When the old ChatPage was both, "home" was a state of a chat, no plan had an
 * address, and the sidebar's Recent list became a second index of the year.
 */

const MODES = [
  {
    id: 'brainstorm',
    label: 'Brainstorm',
    Icon: Lightbulb,
    blurb: 'Kick ideas around for a week before you build it.',
  },
  {
    id: 'interview',
    label: 'Interview me',
    Icon: Users,
    blurb: 'It asks the questions, one at a time, until the week is clear.',
  },
  {
    id: 'standards',
    label: 'Find standards',
    Icon: Search,
    blurb: 'Narrow down which standards the week should actually hit.',
  },
]

let idSeq = 0
const nextId = () => `m${++idSeq}`

export function ChatPage() {
  const { classId, chatId } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const mode = useLayoutMode()

  const { data: chats = [], isLoading: chatsLoading } = useChats()
  const { data: calendar } = useCalendar(classId)
  const deleteChat = useDeleteChat()

  const [messages, setMessages] = useState([])
  const [query, setQuery] = useState('')
  const [attachments, setAttachments] = useState([])
  const [chatMode, setChatMode] = useState('brainstorm')
  const [loadingChat, setLoadingChat] = useState(false)
  const endRef = useRef(null)

  const stream = useChatStream({
    onError: (err) => toast.apiError('The reply failed', err),
  })

  useEffect(() => {
    let cancelled = false
    if (!chatId) {
      setMessages([])
      return undefined
    }
    setLoadingChat(true)
    api
      .getChat(chatId)
      .then((row) => {
        if (cancelled) return
        setMessages(
          (row.messages || []).map((m) => ({
            id: nextId(),
            role: m.role,
            content: m.content,
          }))
        )
      })
      .catch(() => !cancelled && toast.error("Couldn't open that conversation"))
      .finally(() => !cancelled && setLoadingChat(false))
    return () => {
      cancelled = true
    }
  }, [chatId, toast])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  const submit = useCallback(
    async (text) => {
      const content = (text ?? query).trim()
      if (!content || stream.isStreaming) return
      setQuery('')

      const history = [...messages, { id: nextId(), role: 'user', content }]
      setMessages(history)

      let activeChatId = chatId
      if (!activeChatId) {
        try {
          const created = await api.createChat(content.slice(0, 80))
          activeChatId = created.id
          qc.invalidateQueries({ queryKey: qk.chats })
          navigate(`/c/${classId}/chat/${created.id}`, { replace: true })
        } catch {
          /* Keep talking even if the conversation can't be saved — losing the
             transcript is better than refusing to answer. */
        }
      }
      if (activeChatId) {
        api.addMessage(activeChatId, { role: 'user', content }).catch(() => {})
      }

      const replyId = nextId()
      setMessages((prev) => [...prev, { id: replyId, role: 'assistant', content: '' }])

      await stream.start(
        history.map(({ role, content: c }) => ({ role, content: c })),
        chatMode,
        {
          onChunk: (accumulated) =>
            setMessages((prev) =>
              prev.map((m) => (m.id === replyId ? { ...m, content: accumulated } : m))
            ),
          onDone: () => {
            setMessages((prev) => {
              const final = prev.find((m) => m.id === replyId)
              if (activeChatId && final?.content) {
                api
                  .addMessage(activeChatId, { role: 'assistant', content: final.content })
                  .catch(() => {})
              }
              return prev
            })
          },
        }
      )
    },
    [query, messages, stream, chatId, classId, chatMode, navigate, qc]
  )

  const removeChat = useCallback(
    async (chat) => {
      const ok = await confirm({
        title: `Delete “${chat.title}”?`,
        body: 'Plans you built are kept — this only removes the conversation.',
        confirmLabel: 'Delete',
        tone: 'danger',
      })
      if (!ok) return
      await deleteChat.mutateAsync(chat.id).catch((err) => toast.apiError('Could not delete', err))
      if (chat.id === chatId) navigate(`/c/${classId}/chat`)
    },
    [confirm, deleteChat, chatId, classId, navigate, toast]
  )

  // The handoff the orphaned backend prompt was written for.
  const target = defaultWeek(calendar?.weeks)
  const buildHref = target ? `/c/${classId}/week/${target.week}` : `/c/${classId}/week/next`
  const canCompose = mode === 'desktop' || mode === 'tablet'

  /* ── the conversation list ───────────────────────────────────────────── */
  if (!chatId) {
    return (
      <div className="column">
        <header className="flex h-14 shrink-0 items-center justify-between gap-2 px-gutter">
          <h1 className="text-sm font-semibold text-ink">Chats</h1>
        </header>
        <div className="page scroll-y">
          <div className="mx-auto flex w-full max-w-measure flex-col gap-5">
            <div>
              <p className="text-sm text-ink-muted">
                Somewhere to think a week through before you build it. Nothing here writes a
                plan — that happens on the week itself.
              </p>
            </div>

            <div className="grid gap-2 sm:grid-cols-3">
              {MODES.map(({ id, label, Icon, blurb }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setChatMode(id)
                    setMessages([])
                    navigate(`/c/${classId}/chat/new`)
                  }}
                  className="flex flex-col gap-1.5 rounded-xl border border-edge bg-paper-raised p-3 text-left transition-colors hover:bg-paper-sunken"
                >
                  <Icon size={16} aria-hidden="true" className="text-ink-muted" />
                  <span className="text-sm font-medium text-ink">{label}</span>
                  <span className="text-2xs leading-relaxed text-ink-muted">{blurb}</span>
                </button>
              ))}
            </div>

            <div>
              <h2 className="eyebrow mb-2">Recent</h2>
              {chatsLoading ? (
                <SkeletonText lines={4} />
              ) : chats.length ? (
                <ul className="overflow-hidden rounded-xl border border-edge bg-paper-raised">
                  {chats.map((c) => (
                    <li
                      key={c.id}
                      className="group flex items-center gap-2 border-b border-edge px-3 last:border-b-0"
                    >
                      <Link
                        to={`/c/${classId}/chat/${c.id}`}
                        className="min-w-0 flex-1 truncate py-2.5 text-sm text-ink hover:underline"
                      >
                        {c.title}
                      </Link>
                      <button
                        type="button"
                        className="btn-icon opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
                        aria-label={`Delete ${c.title}`}
                        onClick={() => removeChat(c)}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rounded-xl bg-paper-sunken p-4 text-sm text-ink-muted">
                  No conversations yet.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  /* ── one conversation ────────────────────────────────────────────────── */
  return (
    <div className="column">
      <header className="flex h-14 shrink-0 items-center gap-2 px-gutter">
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
          {chats.find((c) => c.id === chatId)?.title || 'New conversation'}
        </h1>
        {/* Chat brainstorms; the week generates. That is the seam, and this is
            the door through it. */}
        <Link to={buildHref} className="btn">
          <Sparkles size={14} aria-hidden="true" />
          <span className="hidden sm:inline">Build a week</span>
        </Link>
      </header>

      <div className="page scroll-y">
        <div className="mx-auto flex w-full max-w-measure flex-col gap-7">
          {loadingChat ? (
            <SkeletonText lines={6} />
          ) : messages.length === 0 ? (
            <div className="empty-state">
              <MessageSquarePlus size={20} aria-hidden="true" className="text-ink-faint" />
              <h1>{MODES.find((m) => m.id === chatMode)?.label}</h1>
              <p>{MODES.find((m) => m.id === chatMode)?.blurb}</p>
            </div>
          ) : (
            messages.map((m) => <Message key={m.id} message={m} />)
          )}
          <div ref={endRef} />
        </div>
      </div>

      {canCompose ? (
        <div className="shrink-0 border-t border-edge bg-paper px-gutter pb-4 pt-3">
          <div className="mx-auto w-full max-w-measure">
            <Composer
              value={query}
              onChange={setQuery}
              onSubmit={submit}
              onStop={stream.stop}
              isStreaming={stream.isStreaming}
              attachments={attachments}
              setAttachments={setAttachments}
            />
          </div>
        </div>
      ) : (
        <p className="shrink-0 border-t border-edge px-gutter py-3 text-center text-xs text-ink-muted">
          Open this on a computer to join the conversation.
        </p>
      )}
    </div>
  )
}
