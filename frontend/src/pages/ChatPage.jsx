import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowDown } from 'lucide-react'
import { api } from '../lib/api'
import { qk } from '../lib/queryKeys'
import { useToast } from '../lib/toastContext'
import { useShell } from '../lib/shellContext'
import { useLessonStream } from '../hooks/useLessonStream'
import { useLayoutMode, PANEL_OVERLAY, useMediaQuery } from '../hooks/useMediaQuery'
import { useActiveClass, useChats } from '../hooks/useAppData'
import { FIELD_LABELS } from '../lib/planShape'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Composer } from '../components/Composer'
import { Message } from '../components/Message'
import { ArtifactPanel } from '../components/ArtifactPanel'
import { ArtifactRail } from '../components/ArtifactRail'
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
 *
 * ── the artifact is a file, not a viewer ──────────────────────────────────
 * The resizable panel is gone. It and the chat fought over the same pixels and
 * both lost: a 460px message column, and a document squeezed until it clipped
 * its own title. A lesson plan is downloaded, printed and handed in — it is not
 * primarily read on screen — so it collapses to a 240px rail and the chat gets
 * a real reading column. The proof that the week is right travels in the
 * message (WeekStrip + grounding line), which is what makes closing the
 * document safe. Click the file when you actually want the pages.
 */

let idSeq = 0
const nextId = () => `m${++idSeq}`

const cellKey = (dayIndex, field) => `${dayIndex}:${field}`

/* Per attached file. A pacing guide is a few thousand characters; a scanned
   40-page PDF is hundreds of thousands, and the whole thing would ride into
   every prompt in the conversation. */
const ATTACHMENT_CHAR_CAP = 12000

export function ChatPage() {
  const { classId, chatId } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const qc = useQueryClient()
  const mode = useLayoutMode()
  const isOverlay = useMediaQuery(PANEL_OVERLAY)
  const { activeClass } = useActiveClass()
  const { data: chats = [] } = useChats()
  const { setDocOpen } = useShell()

  const [messages, setMessages] = useState([])
  const [artifact, setArtifact] = useState(null)
  const [query, setQuery] = useState('')
  const [attachments, setAttachments] = useState([])
  /* Was `panelOpen`. The document is closed by default now — the rail and the
     message carry enough that opening it is a choice, not a requirement. */
  const [expanded, setExpanded] = useState(false)
  const [revising, setRevising] = useState(false)
  const [atBottom, setAtBottom] = useState(true)

  /* Which cell is being tweaked, and which cells just changed. `flashCells` is
     the only animation in the app that carries information: it answers "what
     changed?" without anyone having to build a diff view. */
  const [openTweak, setOpenTweak] = useState(null)
  const [flashCells, setFlashCells] = useState(() => new Set())

  const scrollRef = useRef(null)
  const endRef = useRef(null)

  const activeChat = chats.find((c) => c.id === chatId)
  useDocumentTitle(activeChat?.title || (chatId ? 'New plan' : null))

  /* The nav rail tightens while the document is open — see lib/shellContext.js.
     Reported rather than reached for: AppShell owns its own width. */
  useEffect(() => {
    setDocOpen(expanded && !isOverlay)
    return () => setDocOpen(false)
  }, [expanded, isOverlay, setDocOpen])

  /* Which chat the in-memory transcript currently belongs to.
   *
   * When it already matches the chat we are opening, LOCAL STATE IS THE TRUTH
   * and re-reading the server is not merely redundant, it is destructive:
   * submit() navigates to the new chat the moment it exists, which changes
   * chatId and fires the loader below while the POST saving the first message
   * is still in flight. The loader won, read back an empty conversation, and
   * setMessages([]) over the message the teacher had just typed — so the
   * question vanished, the transcript sat blank for about a second, and the
   * answer arrived attached to nothing. Reproduced at 400ms of write latency;
   * on a cold Render instance the window is far wider.
   *
   * A ref keyed to the CHAT, not a "we made this one" flag: leaving a chat you
   * created and coming back must re-read the server like any other
   * conversation, or you would be shown the transcript of wherever you had
   * been in the meantime. Comparing ids makes the skip idempotent too, which
   * matters because StrictMode double-invokes effects in dev. */
  const localFor = useRef(null)

  /* ── load an existing conversation and whatever plan it produced ──────── */
  useEffect(() => {
    let cancelled = false
    if (!chatId) {
      setMessages([])
      setArtifact(null)
      setExpanded(false)
      localFor.current = null
      return undefined
    }
    // The transcript on screen is already this chat's — nothing to catch up on.
    if (localFor.current === chatId) return undefined

    /* Drop the previous conversation's artifact NOW, not when the fetch
       resolves. Otherwise the rail and the open document keep showing the last
       chat's week under the new chat's heading for as long as the round trip
       takes — measured at ~100-200ms locally, and it reads as the app showing
       you the wrong plan. */
    setArtifact(null)
    setOpenTweak(null)
    setExpanded(false)

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
        localFor.current = chatId
        const last = [...loaded].reverse().find((m) => m.planId)
        if (!last) {
          setArtifact(null)
          return
        }
        try {
          const plan = await api.getPlan(last.planId)
          if (cancelled) return
          setArtifact({
            planId: plan.id,
            plan: plan.plan_json,
            warnings: plan.warnings,
            retrievedIds: plan.retrieved_ids,
            unit: plan.unit,
          })
          /* Attach the week to the message that produced it, so a reopened
             conversation still carries its own verification rather than making
             the teacher open the document to see what was built. Only the last
             one: the earlier plan_json values are gone — the row is updated in
             place — and inventing a week strip for them would be worse than
             showing none. */
          setMessages((prev) =>
            prev.map((m) =>
              m.id === last.id
                ? { ...m, plan: plan.plan_json, retrievedCodes: plan.retrieved_ids }
                : m
            )
          )
        } catch {
          if (!cancelled) setArtifact(null)
        }
      })
      .catch(() => !cancelled && toast.error("Couldn't open that conversation"))
    return () => {
      cancelled = true
    }
  }, [chatId, toast])

  /** Mark cells as just-changed. Cleared after the flash has finished playing. */
  const flash = useCallback((keys) => {
    if (!keys.length) return
    setFlashCells(new Set(keys))
    setTimeout(() => setFlashCells(new Set()), 2400)
  }, [])

  const stream = useLessonStream({
    onDone: (done) => {
      setArtifact({
        planId: done.plan_id,
        plan: done.plan,
        warnings: done.warnings,
        retrievedIds: done.retrieved_ids ?? done.grounding?.codes,
        unit: done.unit,
      })
      const content = `Built ${done.plan?.week_of || 'the week'}. Tell me what to change and I'll revise it.`
      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: 'assistant',
          content,
          planId: done.plan_id,
          weekLabel: done.plan?.week_of,
          plan: done.plan,
          retrievedCodes: done.retrieved_ids ?? done.grounding?.codes,
        },
      ])
      /* SAVE IT. This was missing, and it did not merely lose a line of chat.
         The loader finds a conversation's plan by scanning its messages for a
         plan_id — so with no assistant message written, reopening a chat that
         had produced a week showed the question, no answer, and NO ARTIFACT:
         the .docx became unreachable from the conversation that made it.
         Confirmed against live data, where a freshly generated chat held one
         message and no plan_id at all.

         localFor.current, not chatId: for a chat created moments ago the route
         param has not necessarily caught up, and this is the id we just wrote
         the transcript under. */
      const saveTo = localFor.current
      if (saveTo) {
        api
          .addMessage(saveTo, { role: 'assistant', content, plan_id: done.plan_id })
          .catch(() => {})
      }
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
      const typed = (text ?? query).trim()

      /* Attached files were extracted, confirmed with a toast reporting the
         character count, and then never sent: `attachments` was written by the
         Composer and read by nobody. The chip also stayed pinned after sending,
         so it looked like the document was still in context for every later
         message. It never was.

         Capped, because a 40-page PDF is both a context-window and a bill
         problem, and the truncation is stated in the text rather than silent. */
      const docs = attachments
        .map((a) => {
          const body = String(a.text || '')
          const clipped = body.length > ATTACHMENT_CHAR_CAP
          return `--- ${a.filename}${clipped ? ' (truncated)' : ''} ---\n${
            clipped ? `${body.slice(0, ATTACHMENT_CHAR_CAP)}\n…[truncated]` : body
          }`
        })
        .join('\n\n')

      const content = docs ? `${docs}\n\n---\n\n${typed}` : typed
      // Guards on the COMBINED text, so an attachment with no typed message
      // sends — the send button was already enabled for that and did nothing.
      if (!content.trim() || busy) return
      setQuery('')
      setAttachments([])
      setMessages((prev) => [
        ...prev,
        // The transcript shows what was typed; the file goes to the model.
        { id: nextId(), role: 'user', content: typed || `Sent ${attachments.length} file(s)` },
      ])

      let activeChatId = chatId
      if (!activeChatId) {
        try {
          // `typed`, never `content`: titling a chat from an attached PDF
          // would name it after the document's first 80 characters.
          const created = await api.createChat((typed || attachments[0]?.filename || 'New plan').slice(0, 80))
          activeChatId = created.id
          // Claim it BEFORE navigating: the navigation is what fires the
          // loader, and the loader has to already know this transcript is ours.
          localFor.current = created.id
          qc.invalidateQueries({ queryKey: qk.chats })
          navigate(`/c/${classId}/chat/${created.id}`, { replace: true })
        } catch {
          /* Keep working even if the conversation can't be saved. */
        }
      }
      /* The TRANSCRIPT stores what the teacher wrote, not the file they
         attached — persisting `content` would replay an entire PDF as their
         message every time the conversation is reopened. The model still gets
         the full text below. */
      const shown = typed || `Sent ${attachments.length} file(s)`
      if (activeChatId) api.addMessage(activeChatId, { role: 'user', content: shown }).catch(() => {})

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
        const reply = {
          id: nextId(),
          role: 'assistant',
          content: 'Updated the week and rebuilt the document.',
          planId: row.id,
          weekLabel: row.week_label,
          plan: row.plan_json,
          retrievedCodes: row.retrieved_ids,
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
    [query, attachments, busy, chatId, classId, artifact, stream, navigate, qc, toast]
  )

  /* Per-cell revise, from clicking a cell in the document.
   *
   * `field` is what makes this surgical rather than merely local: without it the
   * backend regenerates the whole day, so "shorten the Do Now" also re-rolls
   * that day's standards and re-decides the grounding audit. With it exactly one
   * key changes. Both this and the composer end up in the transcript, so the
   * chat stays a complete record of what happened to the plan. */
  const reviseDay = useCallback(
    async (dayIndex, day, feedback, field = null) => {
      if (!artifact?.planId) return
      const label = field ? `${day.name}’s ${FIELD_LABELS[field] || field}` : day.name
      const ask = `Revise ${label}: ${feedback}`
      setMessages((prev) => [...prev, { id: nextId(), role: 'user', content: ask }])
      // Persisted for the same reason as the composer's own messages: a cell
      // tweak is a real edit to the week, and the transcript is meant to be a
      // complete record of what happened to the plan. It was writing to screen
      // only, so every in-cell revision vanished on reload.
      const saveTo = localFor.current
      if (saveTo) api.addMessage(saveTo, { role: 'user', content: ask }).catch(() => {})
      setRevising(true)
      try {
        const row = await api.reviseDay({
          plan_id: artifact.planId,
          day_index: dayIndex,
          feedback,
          ...(field ? { field } : {}),
        })
        setArtifact((a) => ({
          ...a,
          plan: row.plan_json,
          warnings: row.warnings,
          retrievedIds: row.retrieved_ids,
        }))
        flash(field ? [cellKey(dayIndex, field)] : [])
        const reply = `Updated ${label} and rebuilt the document.`
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: 'assistant',
            content: reply,
            planId: row.id,
            weekLabel: row.week_label,
            plan: row.plan_json,
            retrievedCodes: row.retrieved_ids,
          },
        ])
        // Carries plan_id, so the conversation keeps its link to the document.
        if (saveTo) {
          api.addMessage(saveTo, { role: 'assistant', content: reply, plan_id: row.id }).catch(() => {})
        }
      } catch (err) {
        toast.apiError(`Could not revise ${label}`, err)
      } finally {
        setRevising(false)
      }
    },
    [artifact, toast, flash]
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
  const hasArtifact = Boolean(liveArtifact && livePlan?.days?.length)
  /* Declared before chatPane, which reads it — the three-column layout at the
     bottom of this component consumes it too. */
  const docOpen = expanded && hasArtifact && !isOverlay

  /** Opening the document from anywhere, optionally straight into a cell. */
  const openDocument = useCallback((tweak = null) => {
    setOpenTweak(tweak)
    setExpanded(true)
  }, [])

  const collapse = useCallback(() => {
    setOpenTweak(null)
    setExpanded(false)
  }, [])

  const artifactEl = (
    <ArtifactPanel
      artifact={{ ...liveArtifact, plan: livePlan }}
      missingDays={stream.isStreaming ? 'pending' : artifact?.planId ? 'no_school' : 'incomplete'}
      onCollapse={collapse}
      onReviseDay={mode === 'desktop' && artifact?.planId ? reviseDay : undefined}
      onPlanRevised={onPlanRevised}
      busy={busy}
      streamingText={stream.text}
      openTweak={openTweak}
      setOpenTweak={setOpenTweak}
      flashCells={flashCells}
    />
  )

  const chatPane = (
    <div className="relative flex h-full min-h-0 flex-col bg-paper">
      {/* What week am I in, and for which class. Two facts that were only
          available by opening the document or reading the sidebar's highlight.
          Hidden once the document opens — it says the same thing in its own
          header two inches to the right. */}
      {!isEmpty && !docOpen && (livePlan?.week_of || activeClass?.name) ? (
        <div className="chat-head">
          {livePlan?.week_of ? <strong>{livePlan.week_of}</strong> : null}
          {activeClass?.name ? <span>· {activeClass.name}</span> : null}
        </div>
      ) : null}

      {isEmpty ? (
        <Greeting onPick={submit} className={activeClass?.name} />
      ) : (
        <div className="min-h-0 flex-1 scroll-y" ref={scrollRef} onScroll={onScroll}>
          <div className="chat-column mx-auto flex w-full max-w-measure flex-col gap-7 px-gutter py-8">
            {messages.map((m) => (
              <Message
                key={m.id}
                message={m}
                onOpenArtifact={m.planId ? () => openDocument() : undefined}
                /* The pencil rendered unguarded while this was never passed, so
                   clicking it opened a working editor whose "Send again" threw
                   and silently reverted the text. */
                onEdit={m.role === 'user' && !busy ? (_m, next) => submit(next) : undefined}
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
              <p className="eyebrow">Revising…</p>
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

  /* The chat pane keeps the SAME slot in the SAME parent in every state — only
     its width changes. Moving it between containers would remount the Composer,
     and the Composer owns a MediaRecorder and a ResizeObserver that do not
     survive that. */
  return (
    <div className="flex h-full w-full min-w-0">
      <div
        className="flex min-w-0 flex-col transition-[flex-basis] duration-300 ease-out"
        style={
          docOpen
            ? { flex: '0 0 var(--chat-w-narrow)' }
            : { flex: '1 1 0%' }
        }
      >
        {chatPane}
      </div>

      {hasArtifact && !isOverlay ? (
        docOpen ? (
          artifactEl
        ) : (
          <ArtifactRail
            artifact={{ ...liveArtifact, plan: livePlan }}
            classId={classId}
            onExpand={() => openDocument()}
            busy={busy}
          />
        )
      ) : null}

      {/* Below --xl the document cannot sit beside the chat, so it overlays —
          and here the dialog semantics ArtifactPanel claims are actually true. */}
      {expanded && hasArtifact && isOverlay ? (
        <>
          <button
            type="button"
            aria-label="Close lesson plan"
            className="fixed inset-0 z-40 bg-[var(--scrim)]"
            onClick={collapse}
          />
          <div className="artifact-overlay">{artifactEl}</div>
        </>
      ) : null}
    </div>
  )
}
