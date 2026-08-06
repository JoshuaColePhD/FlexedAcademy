import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels'
import { api } from '../lib/api'
import { useLessonStream } from '../hooks/useLessonStream'
import { PANEL_OVERLAY, useMediaQuery } from '../hooks/useMediaQuery'
import { ArrowDown } from 'lucide-react'
import { useToast } from '../lib/toastContext'
import { useConfirm } from '../lib/confirmContext'
import { Composer } from '../components/Composer'
import { Message } from '../components/Message'
import { ArtifactPanel } from '../components/ArtifactPanel'
import { TopBar } from '../components/TopBar'
import { WeekBoard } from '../components/WeekBoard'
import { WeekStrip } from '../components/WeekStrip'

let localId = 0
const nextId = () => `m${++localId}`

export function ChatPage({ shell }) {
  const toast = useToast()
  const confirm = useConfirm()
  const {
    chats,
    setChats,
    currentChatId,
    setCurrentChatId,
    onToggleSidebar,
    refreshChats,
  } = shell

  const [messages, setMessages] = useState([])
  const [query, setQuery] = useState('')
  const [attachments, setAttachments] = useState([])
  const [artifact, setArtifact] = useState(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [atBottom, setAtBottom] = useState(true)

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
        const loaded = (chat.messages || []).map((m) => ({
          id: nextId(),
          role: m.role,
          content: m.content,
          planId: m.plan_id || null,
        }))
        setMessages((prev) => {
          // If we have more messages locally (optimistic UI), don't overwrite with stale fetch
          if (prev.length > loaded.length) return prev
          return loaded
        })
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
      .catch((err) => alive && toast.apiError('Could not open that chat', err))
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
        { id: assistantId, role: 'assistant', content: '', streaming: true },
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
          grounding: done.grounding,
          unit: done.unit,
        })
        if (chatId) {
          try {
            await api.addMessage(chatId, {
              role: 'assistant',
              content: `Generated ${done.week_label}`,
              plan_id: done.plan_id,
            })
          } catch (err) {
            toast.apiError('The plan was saved, but this conversation wasn’t updated', err)
          }
          refreshChats()
        }
      } catch {
        // Already surfaced by the hook's onError.
      }
    },
    [stream, refreshChats, toast]
  )

  const submit = useCallback(async (overrideQuery) => {
    const raw = (typeof overrideQuery === 'string' ? overrideQuery : query).trim()
    if (!raw && attachments.length === 0) return

    let fullQuery = raw
    if (attachments.length) {
      fullQuery += '\n\n--- Attached context ---\n'
      for (const f of attachments) fullQuery += `\nDocument: ${f.filename}\n${f.text}\n`
    }
    lastQueryRef.current = fullQuery

    let chatId = currentChatId
    if (!chatId) {
      try {
        const firstLine = (raw || 'Attached files').split('\n')[0]
        const title = firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine
        const chat = await api.createChat(title)
        chatId = chat.id
        setCurrentChatId(chat.id)
        setChats((prev) => [chat, ...prev])

        api
          .suggestChatTitle(raw || 'Attached files')
          .then(({ title: suggested }) => {
            if (!suggested || suggested === title) return
            setChats((prev) => prev.map((c) => (c.id === chat.id ? { ...c, title: suggested } : c)))
            api.renameChat(chat.id, suggested).catch(() => {})
          })
          .catch(() => {})
      } catch (err) {
        toast.apiError('Could not start a new chat', err)
        return
      }
    }

    const userMessageId = nextId()
    const userContent = raw || 'Attached files for context.'
    setMessages((prev) => [...prev, { id: userMessageId, role: 'user', content: userContent }])
    setQuery('')
    setAttachments([])
    setAtBottom(true)

    if (chatId) {
      api.addMessage(chatId, { role: 'user', content: userContent }).catch((err) => {
        setMessages((prev) =>
          prev.map((m) => (m.id === userMessageId ? { ...m, unsaved: true } : m))
        )
        toast.apiError('That message wasn’t saved to this conversation', err)
      })
    }

    await runGeneration(fullQuery, { chatId })

  }, [
    query,
    attachments,
    currentChatId,
    setCurrentChatId,
    setChats,
    toast,
    runGeneration,
  ])

  const retry = useCallback(async () => {
    if (!lastQueryRef.current) return
    setMessages((prev) => {
      const next = [...prev]
      while (next.length && next[next.length - 1].role === 'assistant') next.pop()
      return next
    })
    await runGeneration(lastQueryRef.current, { chatId: currentChatId })
  }, [runGeneration, currentChatId])

  const editAndResend = useCallback(
    async (message, newText) => {
      const text = newText.trim()
      if (!text) return
      const idx = messages.findIndex((m) => m.id === message.id)
      if (idx === -1) return

      const dropped = messages.length - 1 - idx
      if (dropped > 0) {
        const ok = await confirm({
          title: 'Resend this message?',
          body: `The ${dropped} message${dropped === 1 ? '' : 's'} after it will be removed from this conversation.`,
          confirmLabel: 'Resend',
        })
        if (!ok) return
      }

      setMessages((prev) => {
        const at = prev.findIndex((m) => m.id === message.id)
        if (at === -1) return prev
        return [...prev.slice(0, at), { ...prev[at], content: text }]
      })
      lastQueryRef.current = text
      await runGeneration(text, { chatId: currentChatId })
    },
    [messages, runGeneration, currentChatId, confirm]
  )

  const reviseDay = useCallback(
    async (dayIndex, day, feedback) => {
      if (!artifact?.planId) return
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
      }
    },
    [artifact, toast]
  )

  /* The whole-plan revise returns the updated row. Putting it into state here is
     what lets that button stop telling the teacher to refresh the page — the
     same shape reviseDay above already uses. */
  const onPlanRevised = useCallback((row) => {
    if (!row) return
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
        content: 'Reviewed the whole week and rewrote it.',
        planId: row.id,
        weekLabel: row.week_label,
      },
    ])
  }, [])

  const livePlan = artifact?.plan || stream.preview

  const liveArtifact = useMemo(
    () =>
      artifact ||
      (stream.preview || stream.isStreaming
        ? { plan: stream.preview, grounding: stream.grounding }
        : null),
    [artifact, stream.preview, stream.isStreaming, stream.grounding]
  )

  /* Built once and rendered into whichever container the width calls for, so
     the docked and overlaid panels can never drift apart in props. */
  const isOverlay = useMediaQuery(PANEL_OVERLAY)
  const artifactEl = (
    <ArtifactPanel
      missingDays={
        stream.isStreaming
          ? 'pending'
          : liveArtifact && !liveArtifact.planId
            ? 'incomplete'
            : 'no_school'
      }
      artifact={{ ...liveArtifact, plan: livePlan }}
      onClose={() => setPanelOpen(false)}
      onReviseDay={reviseDay}
      onPlanRevised={onPlanRevised}
      busy={stream.isStreaming}
      streamingText={stream.text}
    />
  )

  const activeChat = chats.find((c) => c.id === currentChatId)
  const isEmpty = messages.length === 0

  /* Was the previous render empty? Drives a one-shot settle so the composer
     reads as moving into the footer rather than jumping there. */
  const wasEmpty = useRef(true)
  const justDocked = !isEmpty && wasEmpty.current
  useEffect(() => {
    wasEmpty.current = isEmpty
  }, [isEmpty])

  /* autoSaveId removed — see the note in App.jsx. P5 collapses these two nested
     groups into one and wires useDefaultLayout there. */
  return (
    <PanelGroup orientation="horizontal" className="h-full w-full">
{/* Left Pane: Chat */}
      <Panel
        defaultSize={panelOpen && liveArtifact ? 55 : 100}
        minSize={30}
        className="relative flex h-full min-h-0 flex-col bg-paper"
      >
        <TopBar
          title={isEmpty ? '' : activeChat?.title || 'New plan'}
          course={shell.settings?.course}
          collapsed={shell.collapsed}
          onToggleSidebar={onToggleSidebar}
        />

        {/* Hidden, not zero-height, so it contributes nothing to the centring
            below when there is nothing to show. */}
        <div
          className={isEmpty ? 'hidden' : 'min-h-0 flex-1 scroll-smooth overflow-y-auto'}
          ref={scrollRef}
          onScroll={onScroll}
        >
          <div className="mx-auto flex w-full max-w-measure flex-col gap-7 px-5 py-8">
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
            {/* Progress is the week filling in, not three bouncing dots. A
                teacher can see which day is being written and how many are
                left, which is the only thing they'd want to know while
                waiting. */}
            {stream.isStreaming ? (
              <div className="w-full">
                <p className="eyebrow mb-2">
                  {stream.preview?.days?.length ? 'Writing the week' : 'Retrieving standards'}
                </p>
                <WeekStrip days={stream.preview?.days} writing compact />
              </div>
            ) : null}
            <div ref={endRef} />
          </div>
        </div>

        {!atBottom && !isEmpty ? (
          <div className="pointer-events-none absolute bottom-[92px] left-0 right-0 z-10 flex justify-center">
            <button
              type="button"
              className="pointer-events-auto flex items-center gap-2 rounded-full bg-paper-inset px-3.5 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:bg-edge active:scale-[0.98]"
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
          {stream.isStreaming
            ? 'Generating the lesson plan.'
            : artifact?.planId
              ? 'Lesson plan ready.'
              : ''}
        </div>

        {/* The year. This is the home screen — an empty message list means
            "nothing planned in this conversation yet", not "say something". */}
        {isEmpty ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <WeekBoard
              activeClass={shell.activeClass}
              onPlanWeek={(w) => submit(`Plan ${w.label}.`)}
              onOpenPlan={(w) => w.plan_id && shell.onOpenPlan?.(w.plan_id)}
            />
          </div>
        ) : null}

        {/* ── the dock ──────────────────────────────────────────────────────
            The composer sits at the bottom in both states now. It must still
            stay in the SAME slot of the same parent across the transition:
            Composer owns a MediaRecorder, a ResizeObserver and an autosized
            inline height, all of which die on remount. Only the wrapper's
            className may change. */}
        <div className="shrink-0 border-t border-edge bg-paper px-5 pb-5 pt-3">
          <div className={`mx-auto w-full max-w-measure ${justDocked ? 'animate-dock-settle' : ''}`}>
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
      </Panel>
{/* Right Pane: Artifact (when available) */}
      {panelOpen && liveArtifact && !isOverlay ? (
        <>
          <PanelResizeHandle className="w-px shrink-0 cursor-col-resize bg-edge transition-colors hover:bg-edge-strong active:w-0.5 active:bg-accent" />
          <Panel id="artifact-panel" defaultSize={45} minSize={30} className="relative z-10 flex h-full flex-col bg-paper-raised">
            {artifactEl}
          </Panel>
        </>
      ) : null}

      {/* Below --xl the panel cannot share width with the plan, so it overlays.
          The scrim is a real button, not a div with onClick: the panel claims
          aria-modal, and a modal you can only dismiss with a mouse is not one. */}
      {panelOpen && liveArtifact && isOverlay ? (
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
