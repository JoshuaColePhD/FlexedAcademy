import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, PanelLeft } from 'lucide-react'
import { api } from '../lib/api'
import { useLessonStream } from '../hooks/useLessonStream'
import { useToast } from '../lib/toastContext'
import { Composer } from '../components/Composer'
import { Message } from '../components/Message'
import { ArtifactPanel } from '../components/ArtifactPanel'
import { ThemeToggle } from '../components/ThemeToggle'

const SUGGESTIONS = [
  'Week 3 — rhetorical analysis of Letter from Birmingham Jail',
  'A week on line of reasoning and evidence',
  'Week 12, synthesis essay from six sources',
]

let localId = 0
const nextId = () => `m${++localId}`

export function ChatPage({ shell }) {
  const toast = useToast()
  const {
    chats,
    setChats,
    currentChatId,
    setCurrentChatId,
    theme,
    onToggleSidebar,
    refreshChats,
  } = shell

  const [messages, setMessages] = useState([])
  const [query, setQuery] = useState('')
  const [attachments, setAttachments] = useState([])
  const [artifact, setArtifact] = useState(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const [busy, setBusy] = useState(false)

  const scrollRef = useRef(null)
  const endRef = useRef(null)
  const lastQueryRef = useRef('')

  const stream = useLessonStream({
    onError: (err) => {
      // A real, visible failure — never an endless "Generating…".
      setMessages((prev) =>
        prev.map((m) =>
          m.streaming
            ? {
                ...m,
                streaming: false,
                isError: true,
                content: err.message || 'Generation failed.',
                hint: err.hint,
              }
            : m
        )
      )
      toast.error('Could not build that plan', err.hint || err.message)
    },
  })

  /* ---- scrolling ---- */
  useEffect(() => {
    if (atBottom) endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, stream.text, atBottom])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
  }

  /* ---- loading an existing chat ---- */
  useEffect(() => {
    if (!currentChatId) {
      setMessages([])
      setArtifact(null)
      setPanelOpen(false)
      return
    }
    let alive = true
    api
      .getChat(currentChatId)
      .then(async (chat) => {
        if (!alive) return
        const loaded = chat.messages.map((m) => ({
          id: nextId(),
          role: m.role,
          content: m.content,
          planId: m.plan_id || null,
        }))
        setMessages(loaded)
        const lastPlan = [...loaded].reverse().find((m) => m.planId)
        if (lastPlan) {
          try {
            const row = await api.getPlan(lastPlan.planId)
            if (!alive) return
            setArtifact({
              planId: row.id,
              plan: row.plan_json,
              warnings: row.warnings,
              retrievedIds: row.retrieved_ids,
              unit: row.unit,
            })
          } catch {
            /* the plan may have been deleted — leave the panel closed */
          }
        } else {
          setArtifact(null)
        }
      })
      .catch((err) => alive && toast.error('Could not open that chat', err.message))
    return () => {
      alive = false
    }
  }, [currentChatId, toast])

  /* ---- generate ---- */
  const runGeneration = useCallback(
    async (rawQuery, { chatId }) => {
      const assistantId = nextId()
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: 'assistant', content: 'Drafting the week…', streaming: true },
      ])
      setArtifact(null)
      setPanelOpen(true)

      try {
        const done = await stream.start(rawQuery, { chatId })
        if (!done) {
          // Stopped by the user.
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, streaming: false, content: 'Stopped before the plan was finished.' }
                : m
            )
          )
          return
        }
        const warnCount = done.warnings?.length || 0
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  streaming: false,
                  planId: done.plan_id,
                  weekLabel: done.week_label,
                  content: `Here’s ${done.week_label}. The document is ready to download.${
                    warnCount ? ` ${warnCount} grounding note${warnCount === 1 ? '' : 's'} to check.` : ''
                  }`,
                }
              : m
          )
        )
        setArtifact({
          planId: done.plan_id,
          plan: done.plan,
          warnings: done.warnings,
          grounding: stream.grounding,
          unit: done.unit,
        })
        if (chatId) {
          await api.addMessage(chatId, {
            role: 'assistant',
            content: `Generated ${done.week_label}`,
            plan_id: done.plan_id,
          })
          refreshChats()
        }
      } catch {
        // Already surfaced by the hook's onError.
      }
    },
    [stream, refreshChats]
  )

  const submit = useCallback(async () => {
    const text = query.trim()
    if (!text && attachments.length === 0) return

    let fullQuery = text
    if (attachments.length) {
      fullQuery += '\n\n--- Attached context ---\n'
      for (const f of attachments) fullQuery += `\nDocument: ${f.filename}\n${f.text}\n`
    }
    lastQueryRef.current = fullQuery

    let chatId = currentChatId
    if (!chatId) {
      try {
        // Title from the first line only, and the ellipsis decided from that same
        // line — the old version sliced the first line but tested the full length.
        const firstLine = (text || 'Attached files').split('\n')[0]
        const title = firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine
        const chat = await api.createChat(title)
        chatId = chat.id
        setCurrentChatId(chat.id)
        setChats((prev) => [chat, ...prev])
      } catch (err) {
        toast.error('Could not start a new chat', err.message)
        return
      }
    }

    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: 'user', content: text || 'Attached files for context.' },
    ])
    setQuery('')
    setAttachments([])
    setAtBottom(true)

    if (chatId) {
      api
        .addMessage(chatId, { role: 'user', content: text || 'Attached files for context.' })
        .catch(() => {})
    }

    setBusy(true)
    await runGeneration(fullQuery, { chatId })
    setBusy(false)
  }, [query, attachments, currentChatId, setCurrentChatId, setChats, toast, runGeneration])

  const retry = useCallback(async () => {
    if (!lastQueryRef.current) return
    setMessages((prev) => {
      const next = [...prev]
      while (next.length && next[next.length - 1].role === 'assistant') next.pop()
      return next
    })
    setBusy(true)
    await runGeneration(lastQueryRef.current, { chatId: currentChatId })
    setBusy(false)
  }, [runGeneration, currentChatId])

  const editAndResend = useCallback(
    async (message, newText) => {
      const text = newText.trim()
      if (!text) return
      const idx = messages.findIndex((m) => m.id === message.id)
      setMessages((prev) => [
        ...prev.slice(0, idx),
        { ...prev[idx], content: text },
      ])
      lastQueryRef.current = text
      setBusy(true)
      await runGeneration(text, { chatId: currentChatId })
      setBusy(false)
    },
    [messages, runGeneration, currentChatId]
  )

  const reviseDay = useCallback(
    async (dayIndex, day, feedback) => {
      if (!artifact?.planId) return
      setBusy(true)
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'user', content: `Revise ${day.name}: ${feedback}` },
      ])
      try {
        const row = await api.reviseDay({
          plan_id: artifact.planId,
          day_index: dayIndex,
          feedback,
        })
        setArtifact((a) => ({
          ...a,
          plan: row.plan_json,
          warnings: row.warnings,
          retrievedIds: row.retrieved_ids,
        }))
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: 'assistant',
            content: `Updated ${day.name} and rebuilt the document.`,
            planId: row.id,
            weekLabel: row.week_label,
          },
        ])
        toast.success(`${day.name} revised`, 'The .docx has been rebuilt to match.')
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: 'assistant',
            isError: true,
            content: err.message,
            hint: err.hint,
          },
        ])
        toast.error(`Could not revise ${day.name}`, err.hint || err.message)
      } finally {
        setBusy(false)
      }
    },
    [artifact, toast]
  )

  const livePlan = artifact?.plan || stream.preview
  const liveArtifact = useMemo(
    () =>
      artifact ||
      (stream.preview || stream.isStreaming
        ? { plan: stream.preview, grounding: stream.grounding }
        : null),
    [artifact, stream.preview, stream.isStreaming, stream.grounding]
  )

  const activeChat = chats.find((c) => c.id === currentChatId)

  return (
    <>
      <div className="column">
        <header className="topbar">
          <button
            type="button"
            className="btn-icon"
            onClick={onToggleSidebar}
            aria-label="Toggle sidebar"
          >
            <PanelLeft size={16} aria-hidden="true" />
          </button>
          <span className="topbar-title">{activeChat?.title || 'New plan'}</span>
          <span className="topbar-spacer" />
          <ThemeToggle mode={theme.mode} onCycle={theme.cycle} />
        </header>

        <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
          {messages.length === 0 ? (
            <div className="empty-state">
              <h1>
                What are we <em>teaching</em> next week?
              </h1>
              <p>
                Describe a week. Every standard gets cited from your own source documents, and
                you get the district template as a&nbsp;.docx.
              </p>
              <div className="suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s} type="button" className="suggestion" onClick={() => setQuery(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="chat-inner">
              {messages.map((m, i) => (
                <Message
                  key={m.id}
                  message={m}
                  isLast={i === messages.length - 1}
                  onOpenArtifact={() => setPanelOpen(true)}
                  onRetry={m.role === 'assistant' && !stream.isStreaming ? retry : undefined}
                  onEdit={editAndResend}
                />
              ))}
              {stream.isStreaming && !messages.some((m) => m.streaming) ? (
                <div className="msg is-assistant">
                  <span className="msg-avatar">
                    <img src="/logo.png" alt="" aria-hidden="true" />
                  </span>
                  <div className="msg-body">
                    <span className="thinking">
                      <i /> <i /> <i /> Retrieving standards
                    </span>
                  </div>
                </div>
              ) : null}
              <div ref={endRef} />
            </div>
          )}

          {!atBottom && messages.length > 0 ? (
            <button
              type="button"
              className="scroll-bottom"
              onClick={() => {
                setAtBottom(true)
                endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
              }}
            >
              <ArrowDown size={13} aria-hidden="true" /> Latest
            </button>
          ) : null}
        </div>

        {/* Announces streaming status and errors to a screen reader — errors used
            to arrive via alert(), which is invisible until dismissed. */}
        <div className="visually-hidden" role="status" aria-live="polite">
          {stream.isStreaming
            ? 'Generating the lesson plan.'
            : artifact?.planId
              ? 'Lesson plan ready.'
              : ''}
        </div>

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

      {panelOpen && liveArtifact ? (
        <ArtifactPanel
          artifact={{ ...liveArtifact, plan: livePlan }}
          onClose={() => setPanelOpen(false)}
          onReviseDay={reviseDay}
          busy={busy || stream.isStreaming}
          streamingText={stream.text}
        />
      ) : null}
    </>
  )
}
