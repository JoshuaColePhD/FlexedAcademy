import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels'
import { ArrowDown } from 'lucide-react'
import { api } from '../lib/api'
import { qk } from '../lib/queryKeys'
import { useToast } from '../lib/toastContext'
import { useLessonStream } from '../hooks/useLessonStream'
import { useLayoutMode, PANEL_OVERLAY, useMediaQuery } from '../hooks/useMediaQuery'
import { useActiveClass, useChats } from '../hooks/useAppData'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Composer } from '../components/Composer'
import { Message } from '../components/Message'
import { ArtifactPanel } from '../components/ArtifactPanel'
import { WeekStrip } from '../components/WeekStrip'
import { Greeting } from '../components/Greeting'

/* One chat, one plan.
 *
 * Say what you need, it builds it, then every message after that revises it.
 * That last part is the piece that never existed: the whole-plan revise
 * endpoint ran an autonomous self-critique and took no instruction, so "make
 * Thursday a Socratic seminar" had nowhere to go. It takes feedback now.
 *
 * The calendar is not a screen. It is still the thing keeping generation
 * honest — backend/schoolcal.py reads the same file the prompt quotes, so the
 * model cannot put five days of lessons inside Fall Break — it just doesn't
 * need a surface of its own to do that.
 *
 * Intent routing is deliberately dumb and predictable: no plan yet, your
 * message builds one; plan exists, your message revises it. A model guessing
 * which you meant would be wrong occasionally, and "occasionally regenerates
 * your week from scratch" is the worst failure this app has available. To start
 * something else, start a new chat.
 */

let idSeq = 0
const nextId = () => `m${++idSeq}`

export function ChatPage() {
  const { classId, chatId } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const qc = useQueryClient()
  const mode = useLayoutMode()
  const isOverlay = useMediaQuery(PANEL_OVERLAY)
  const { activeClass } = useActiveClass()
  const { data: chats = [] } = useChats()

  const [messages, setMessages] = useState([])
  const [artifact, setArtifact] = useState(null)
  const [query, setQuery] = useState('')
  const [attachments, setAttachments] = useState([])
  const [panelOpen, setPanelOpen] = useState(true)
  const [revising, setRevising] = useState(false)
  const [atBottom, setAtBottom] = useState(true)

  const scrollRef = useRef(null)
  const endRef = useRef(null)

  const activeChat = chats.find((c) => c.id === chatId)
  useDocumentTitle(activeChat?.title || (chatId ? 'New plan' : null))

  /* ── load an existing conversation and whatever plan it produced ──────── */
  useEffect(() => {
    let cancelled = false
    if (!chatId) {
      setMessages([])
      setArtifact(null)
      return undefined
    }
    api
      .getChat(chatId)
      .then(async (row) => {
        if (cancelled) return
        const loaded = (row.messages || []).map((m) => ({
          id: nextId(),
          role: m.role,
          content: m.content,
          planId: m.plan_id || null,
        }))
        setMessages(loaded)
        const last = [...loaded].reverse().find((m) => m.planId)
        if (!last) {
          setArtifact(null)
          return
        }
        try {
          const plan = await api.getPlan(last.planId)
          if (!cancelled) {
            setArtifact({
              planId: plan.id,
              plan: plan.plan_json,
              warnings: plan.warnings,
              retrievedIds: plan.retrieved_ids,
              unit: plan.unit,
            })
          }
        } catch {
          if (!cancelled) setArtifact(null)
        }
      })
      .catch(() => !cancelled && toast.error("Couldn't open that conversation"))
    return () => {
      cancelled = true
    }
  }, [chatId, toast])

  const stream = useLessonStream({
    onDone: (done) => {
      setArtifact({
        planId: done.plan_id,
        plan: done.plan,
        warnings: done.warnings,
        retrievedIds: done.retrieved_ids ?? done.grounding?.codes,
        unit: done.unit,
      })
      setPanelOpen(true)
      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: 'assistant',
          content: `Built ${done.plan?.week_of || 'the week'}. Tell me what to change and I'll revise it.`,
          planId: done.plan_id,
          weekLabel: done.plan?.week_of,
        },
      ])
      qc.invalidateQueries({ queryKey: qk.chats })
    },
    onError: (err) => {
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'assistant', isError: true, content: err.message, hint: err.hint },
      ])
      toast.apiError("Couldn't build that", err)
    },
  })

  const busy = stream.isStreaming || revising

  /* ── the one submit path ──────────────────────────────────────────────── */
  const submit = useCallback(
    async (text) => {
      const content = (text ?? query).trim()
      if (!content || busy) return
      setQuery('')
      setMessages((prev) => [...prev, { id: nextId(), role: 'user', content }])

      let activeChatId = chatId
      if (!activeChatId) {
        try {
          const created = await api.createChat(content.slice(0, 80))
          activeChatId = created.id
          qc.invalidateQueries({ queryKey: qk.chats })
          navigate(`/c/${classId}/chat/${created.id}`, { replace: true })
        } catch {
          /* Keep working even if the conversation can't be saved. */
        }
      }
      if (activeChatId) api.addMessage(activeChatId, { role: 'user', content }).catch(() => {})

      // No plan in this chat yet -> build one. Otherwise -> revise it.
      if (!artifact?.planId) {
        stream.start(content, { chatId: activeChatId }).catch(() => {})
        return
      }

      setRevising(true)
      try {
        const row = await api.revisePlan(artifact.planId, content)
        setArtifact((a) => ({
          ...a,
          plan: row.plan_json,
          warnings: row.warnings,
          retrievedIds: row.retrieved_ids,
        }))
        setPanelOpen(true)
        const reply = {
          id: nextId(),
          role: 'assistant',
          content: 'Updated the week and rebuilt the document.',
          planId: row.id,
          weekLabel: row.week_label,
        }
        setMessages((prev) => [...prev, reply])
        if (activeChatId) {
          api
            .addMessage(activeChatId, { role: 'assistant', content: reply.content, plan_id: row.id })
            .catch(() => {})
        }
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: 'assistant', isError: true, content: err.message, hint: err.hint },
        ])
        toast.apiError("Couldn't revise that", err)
      } finally {
        setRevising(false)
      }
    },
    [query, busy, chatId, classId, artifact, stream, navigate, qc, toast]
  )

  /* Per-day revise, from the Sparkles button in the table. Surgical, where the
     composer is conversational — both end up in the transcript so the chat is a
     complete record of what happened to the plan. */
  const reviseDay = useCallback(
    async (dayIndex, day, feedback) => {
      if (!artifact?.planId) return
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'user', content: `Revise ${day.name}: ${feedback}` },
      ])
      try {
        const row = await api.reviseDay({ plan_id: artifact.planId, day_index: dayIndex, feedback })
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
      } catch (err) {
        toast.apiError(`Could not revise ${day.name}`, err)
      }
    },
    [artifact, toast]
  )

  const onPlanRevised = useCallback((row) => {
    if (!row) return
    setArtifact((a) => ({
      ...a,
      plan: row.plan_json,
      warnings: row.warnings,
      retrievedIds: row.retrieved_ids,
    }))
  }, [])

  /* ── scroll ───────────────────────────────────────────────────────────── */
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 120)
  }
  useEffect(() => {
    if (atBottom) endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, atBottom])

  const livePlan = artifact?.plan || stream.preview
  const liveArtifact = useMemo(
    () =>
      artifact ||
      (stream.preview || stream.isStreaming
        ? { plan: stream.preview, grounding: stream.grounding }
        : null),
    [artifact, stream.preview, stream.isStreaming, stream.grounding]
  )

  const isEmpty = messages.length === 0
  const showPanel = panelOpen && liveArtifact && livePlan?.days?.length

  const artifactEl = (
    <ArtifactPanel
      artifact={{ ...liveArtifact, plan: livePlan }}
      missingDays={stream.isStreaming ? 'pending' : artifact?.planId ? 'no_school' : 'incomplete'}
      onClose={() => setPanelOpen(false)}
      onReviseDay={mode === 'desktop' && artifact?.planId ? reviseDay : undefined}
      onPlanRevised={onPlanRevised}
      busy={busy}
      streamingText={stream.text}
      framework={activeClass?.name}
    />
  )

  const chatPane = (
    <div className="relative flex h-full min-h-0 flex-col bg-paper">
      {isEmpty ? (
        <Greeting onPick={submit} className={activeClass?.name} />
      ) : (
        <div className="min-h-0 flex-1 scroll-y" ref={scrollRef} onScroll={onScroll}>
          <div className="mx-auto flex w-full max-w-measure flex-col gap-7 px-gutter py-8">
            {messages.map((m) => (
              <Message
                key={m.id}
                message={m}
                onOpenArtifact={m.planId ? () => setPanelOpen(true) : undefined}
              />
            ))}

            {/* Progress is the week filling in, not three bouncing dots — a
                teacher can see which day is being written and how many are
                left, which is the only thing worth knowing while waiting. */}
            {stream.isStreaming ? (
              <div className="w-full">
                <p className="eyebrow mb-2">
                  {stream.preview?.days?.length ? 'Writing the week' : 'Retrieving standards'}
                </p>
                <WeekStrip days={stream.preview?.days} writing compact />
              </div>
            ) : revising ? (
              <p className="eyebrow">Revising the week…</p>
            ) : null}

            <div ref={endRef} />
          </div>
        </div>
      )}

      {!atBottom && !isEmpty ? (
        <div className="pointer-events-none absolute bottom-[92px] left-0 right-0 z-10 flex justify-center">
          <button
            type="button"
            className="pointer-events-auto flex min-h-touch items-center gap-2 rounded-full bg-paper-inset px-3.5 text-xs font-medium text-ink-soft transition-colors hover:bg-edge"
            onClick={() => {
              setAtBottom(true)
              endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
            }}
          >
            <ArrowDown size={13} aria-hidden="true" /> Latest
          </button>
        </div>
      ) : null}

      <div className="visually-hidden" role="status" aria-live="polite">
        {stream.isStreaming ? 'Building the lesson plan.' : artifact?.planId ? 'Lesson plan ready.' : ''}
      </div>

      {/* The dock. Composer must stay in the SAME slot of the same parent across
          the empty/non-empty transition — it owns a MediaRecorder, a
          ResizeObserver and an autosized inline height, all of which die on
          remount. Only the wrapper's className may change. */}
      <div className="shrink-0 border-t border-edge bg-paper px-gutter pb-5 pt-3">
        <div className="mx-auto w-full max-w-measure">
          <Composer
            value={query}
            onChange={setQuery}
            onSubmit={submit}
            onStop={stream.stop}
            isStreaming={busy}
            attachments={attachments}
            setAttachments={setAttachments}
            placeholder={
              artifact?.planId
                ? 'What should change? — e.g. make Thursday a Socratic seminar'
                : 'What do you need a lesson plan for?'
            }
            sendLabel={artifact?.planId ? 'Revise the plan' : 'Build the lesson plan'}
          />
        </div>
      </div>
    </div>
  )

  return (
    <PanelGroup orientation="horizontal" className="h-full w-full">
      <Panel defaultSize={showPanel && !isOverlay ? 55 : 100} minSize={30} className="min-w-0">
        {chatPane}
      </Panel>

      {showPanel && !isOverlay ? (
        <>
          <PanelResizeHandle className="w-px shrink-0 cursor-col-resize bg-edge transition-colors hover:bg-edge-strong active:w-0.5 active:bg-accent" />
          <Panel id="artifact" defaultSize={45} minSize={30} className="relative z-10 flex h-full flex-col bg-paper-raised">
            {artifactEl}
          </Panel>
        </>
      ) : null}

      {showPanel && isOverlay ? (
        <>
          <button
            type="button"
            aria-label="Close lesson plan"
            className="fixed inset-0 z-40 bg-[var(--scrim)]"
            onClick={() => setPanelOpen(false)}
          />
          <div className="artifact-overlay">{artifactEl}</div>
        </>
      ) : null}
    </PanelGroup>
  )
}
