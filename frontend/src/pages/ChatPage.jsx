import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowDown } from 'lucide-react'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'
import { useAuth } from '../lib/authContext'
import { useBilling } from '../lib/billingContext'
import { useVoice } from '../lib/voiceContext'
import { useShell } from '../lib/shellContext'
import { useLessonStream } from '../hooks/useLessonStream'
import { useChatStream } from '../hooks/useChatStream'
import { useLayoutMode, PANEL_OVERLAY, useMediaQuery } from '../hooks/useMediaQuery'
import { useActiveClass, useCalendar, useChats } from '../hooks/useAppData'
import { FIELD_LABELS } from '../lib/planShape'
import { firstUnplanned } from '../lib/queue'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useExitTransition } from '../hooks/useExitTransition'
import { Composer } from '../components/Composer'
import { Message } from '../components/Message'
import { ArtifactPanel } from '../components/ArtifactPanel'
import { ArtifactRail, ArtifactDrawer } from '../components/ArtifactRail'
import { WeekStrip } from '../components/WeekStrip'
import { Greeting } from '../components/Greeting'
import { WeekPicker } from '../components/WeekPicker'

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
  const { refresh: refreshAuth } = useAuth()
  const { mayGenerate, openPaywall } = useBilling()
  const voice = useVoice()
  const mode = useLayoutMode()
  const isPhone = mode === 'phone'
  const isOverlay = useMediaQuery(PANEL_OVERLAY)
  const { activeClass } = useActiveClass()
  const { data: chats = [] } = useChats()
  const { data: calendar } = useCalendar(classId)
  const { setDocOpen } = useShell()

  const [messages, setMessages] = useState([])
  const [artifact, setArtifact] = useState(null)
  const [query, setQuery] = useState('')
  const [attachments, setAttachments] = useState([])
  /* Which week a NEW plan will be built for. Null means "auto" — the same
     next-unplanned week the Greeting suggestion already names — until the
     teacher overrides it. Without this the teacher found out which week they
     got only after a 30-second generation, from the finished document's own
     header; there was no way to see it, let alone change it, beforehand. */
  const [selectedWeek, setSelectedWeek] = useState(null)
  /* Was `panelOpen`. The document is closed by default now — the rail and the
     message carry enough that opening it is a choice, not a requirement. */
  const [expanded, setExpanded] = useState(false)
  /* The drawer's own open/closed state — separate from `expanded`, which is
     the FULL docked/overlay document. Starts closed (just the handle) for
     every chat; the effect below pulls it open the moment there's a reason
     to, and only that transition forces it — closing it again afterward is
     never overridden by a render where nothing changed. */
  const [railOpen, setRailOpen] = useState(false)
  const [revising, setRevising] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  /* True from the instant submit() is called until either stream/chatStream
     picks up the busy flag on its own (both flip isStreaming synchronously
     the moment they're invoked) or submit bails out. This exists because
     submit's FIRST await, for a brand-new chat, is api.createChat — and on a
     cold Render instance or a flaky phone connection that round trip can run
     long, with `busy` still false the entire time. The teacher's message
     appeared, and then nothing: no spinner, no "Building…", nothing to show
     the app had even heard them. */
  const [preparing, setPreparing] = useState(false)

  /* Which cell is being tweaked, and which cells just changed. `flashCells` is
     the only animation in the app that carries information: it answers "what
     changed?" without anyone having to build a diff view. */
  const [openTweak, setOpenTweak] = useState(null)
  const [flashCells, setFlashCells] = useState(() => new Set())

  const scrollRef = useRef(null)
  const endRef = useRef(null)

  const activeChat = chats.find((c) => c.id === chatId)
  useDocumentTitle(activeChat?.title || (chatId ? 'New plan' : null))

  // Every week worth offering in the picker: not a week the school is
  // shut, not one that's already gone by.
  const weekOptions = useMemo(
    () => (calendar?.weeks || []).filter((w) => !w.no_school && !w.is_past),
    [calendar]
  )
  const autoWeek = useMemo(() => firstUnplanned(calendar?.weeks), [calendar])
  const effectiveWeek = selectedWeek ?? autoWeek?.week ?? null

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

  /* The last message id VoiceProvider has already spoken (or been told to
     skip, on history load — see below). Primed to the newly-loaded
     transcript's own last id the moment a conversation opens, so opening an
     old chat with ten messages doesn't queue up ten replies of audio; only a
     message that arrives AFTER that point — a live reply — gets spoken. */
  const lastSpokenRef = useRef(null)

  /* ── load an existing conversation and whatever plan it produced ──────── */
  useEffect(() => {
    let cancelled = false
    /* Neither stream aborts on its own when the chat under it changes — only
       on unmount or an explicit Stop click. Navigate away from a chat mid-
       generation (sidebar click, "New plan") and the old fetch keeps running;
       when it eventually resolves, onDone still fires and writes into
       whatever `messages`/`artifact` state is on screen BY THEN, and persists
       via `localFor.current`, which has already moved to the new chat. A week
       built for chat A lands in chat B's transcript and database row. Both
       are safe no-ops when nothing was in flight. */
    stream.stop()
    chatStream.stop()
    if (!chatId) {
      setMessages([])
      setArtifact(null)
      setExpanded(false)
      setRailOpen(false)
      setSelectedWeek(null)
      localFor.current = null
      lastSpokenRef.current = null
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
    setRailOpen(false)

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
        lastSpokenRef.current = loaded.length ? loaded[loaded.length - 1].id : null
        const last = [...loaded].reverse().find((m) => m.planId)

        if (!last) {
          /* No message names a plan — but the chat may still HAVE one.
             Until the assistant message started being persisted, generation
             wrote the plan (with its chat_id) and nothing else, so every week
             built before that fix was stranded: the conversation reopened with
             no artifact, no rail and no way to the .docx, even though the row
             was sitting in the database the whole time. The plan knows which
             chat it came from, so ask it directly. */
          try {
            const { items = [] } = await api.listPlans({ chat_id: chatId, limit: 1 })
            if (cancelled) return
            if (!items[0]) {
              setArtifact(null)
              return
            }
            // The list view drops plan_json (db.list_plans pops it), so the
            // week itself still has to be fetched by id.
            const plan = await api.getPlan(items[0].id)
            if (cancelled) return
            setArtifact({
              planId: plan.id,
              plan: plan.plan_json,
              warnings: plan.warnings,
              retrievedIds: plan.retrieved_ids,
              unit: plan.unit,
            })
          } catch {
            if (!cancelled) setArtifact(null)
          }
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
    // stream/chatStream deliberately excluded: their .stop() is a stable
    // useCallback closed over a ref, so even this closure's "stale" copy
    // still aborts whatever is actually in flight — see useLessonStream.js.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      qc.invalidateQueries({ queryKey: ['chats'] })
      // A week was just used. Re-read the entitlement so the next submit knows.
      refreshAuth()
    },
    onError: (err) => {
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'assistant', isError: true, content: err.message, hint: err.hint },
      ])
      // The server is the authority; if it refused on entitlement, show the
      // offer rather than only a toast the teacher can't act on.
      if (err.code === 'subscription_required') {
        refreshAuth()
        openPaywall()
        return
      }
      toast.apiError("Couldn't build that", err)
    },
  })

  const chatStream = useChatStream({
    onDone: (result) => {
      // If the chat model just had a conversation (no tool call), we save the text.
      // If it called the tool, we save the text (e.g. "I'll make that plan now!") and then
      // trigger the actual plan build from the submit function.
      if (result?.text?.trim()) {
        const reply = {
          id: nextId(),
          role: 'assistant',
          content: result.text,
        }
        setMessages((prev) => [...prev, reply])
        const saveTo = localFor.current
        if (saveTo) {
          api.addMessage(saveTo, { role: 'assistant', content: result.text }).catch(() => {})
        }
        qc.invalidateQueries({ queryKey: ['chats'] })
      }
    },
    onError: (err) => {
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'assistant', isError: true, content: err.message, hint: err.hint },
      ])
      toast.apiError("Chat failed", err)
    },
  })

  const busy = stream.isStreaming || revising || chatStream.isStreaming || preparing

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
      setPreparing(true)
      setQuery('')
      // The chip has to clear here, before any request goes out — the sent
      // files are captured in `content` below and folded into this turn's
      // payload; leaving the chip pinned implied they were still in context
      // for every later message, which was never true even before this fix.
      setAttachments([])
      const nextMessages = [
        ...messages,
        { id: nextId(), role: 'user', content: typed || `Sent ${attachments.length} file(s)` }
      ]

      setMessages(nextMessages)

      let activeChatId = chatId
      if (!activeChatId) {
        try {
          const created = await api.createChat((typed || attachments[0]?.filename || 'New plan').slice(0, 80), classId)
          activeChatId = created.id
          localFor.current = created.id
          qc.invalidateQueries({ queryKey: ['chats'] })
          navigate(`/c/${classId}/chat/${created.id}`, { replace: true })

          /* Then give it a real name.
             The placeholder is the first 80 characters of whatever was typed,
             which is why the sidebar filled with rows reading "let's plan week
             2 of ap lang" twice over and "Plan a week around a text — I'll name
             it:" — the boilerplate, never the part that identifies the week.
             /api/chats/title exists precisely for this and had no callers; its
             own docstring describes being "called after the chat is already
             created with a truncated placeholder title".

             Deliberately not awaited: it is a second model call, it is purely
             cosmetic, and nothing about sending the first message should wait
             on it. Failure leaves the placeholder, which is what we have today. */
          const basis = typed || attachments[0]?.filename
          if (basis) {
            api
              .suggestChatTitle(basis)
              .then(({ title }) => title && api.renameChat(created.id, title))
              .then(() => qc.invalidateQueries({ queryKey: ['chats'] }))
              .catch(() => {})
          }
        } catch (err) {
          // Silently continuing here used to mean a failed chat creation left
          // the message sitting on screen with no reply and no explanation —
          // indistinguishable from the app having simply not heard the teacher.
          setPreparing(false)
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: 'assistant',
              isError: true,
              content: "Couldn't reach the server to start that.",
              hint: err?.hint || 'Check your connection and try again.',
            },
          ])
          toast.apiError("Couldn't send that", err)
          return
        }
      }

      const shown = typed || `Sent ${attachments.length} file(s)`
      if (activeChatId) api.addMessage(activeChatId, { role: 'user', content: shown }).catch(() => {})

      /* No plan in this chat yet -> build one, directly. This used to go
         through chat_stream first and only built if the model chose to call
         generate_lesson_plan — which reintroduced exactly the guessing this
         app exists to avoid (see the file header: "intent routing is
         deliberately dumb"). A fully-specified prompt like "plan a week on
         Gatsby, chapters 3-4, rhetorical analysis" got an outline and "want me
         to proceed?" instead of the week the composer promised. There is no
         mode picker in this UI — every message here is asking for a plan. */
      if (!artifact?.planId) {
        /* The paywall, asked before the 30-second wait rather than after it.
           The server enforces the same rule (routes/generate.py) — this exists
           so a blocked teacher sees the offer immediately instead of watching a
           progress indicator that was always going to end in a 402. Revising,
           the branch below, is never gated. */
        if (!mayGenerate) {
          setPreparing(false)
          openPaywall()
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: 'assistant',
              isError: true,
              content: 'You’ve used your free week.',
              hint: 'Subscribe to build new weeks — everything you’ve already made stays yours.',
            },
          ])
          return
        }
        const combinedHistory = [
          ...messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`),
          `USER: ${content}`,
        ].join('\n\n')
        // stream.start() flips stream.isStreaming synchronously before its
        // first await, so busy is already covered by the time preparing drops.
        stream.start(combinedHistory, { chatId: activeChatId, weekNumber: effectiveWeek }).catch(() => {})
        setPreparing(false)
        return
      }

      // A plan already exists, so this message is ambiguous between "just
      // talking about it" and "revise it" — that's the one case worth asking
      // the model to route, since a bare follow-up ("why Thursday?") shouldn't
      // silently rebuild the week.
      const payloadMessages = [
        ...messages.map((m) => ({ role: m.role, content: m.content || m.planLabel || m.weekLabel || '' })),
        { role: 'user', content },
      ]
      // Same handoff as above: chatStream.start() sets chatStream.isStreaming
      // synchronously, so busy stays continuously true across this call even
      // though we're about to `await` its whole run rather than fire-and-forget.
      setPreparing(false)
      const chatResult = await chatStream.start(payloadMessages, { chatId: activeChatId })

      if (!chatResult || !chatResult.toolCalled) {
        // AI decided to just converse, no revision needed.
        return
      }

      // The AI called generate_lesson_plan. Combine history for the prompt.
      // We append any introductory text the AI just streamed ("I'll get right on that!")
      // so it's in the combined history. Same split as above: the last turn
      // carries the attachment text, everything before it is the transcript.
      let combinedHistory = [
        ...messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`),
        `USER: ${content}`,
      ].join('\n\n')
      if (chatResult.text?.trim()) {
        combinedHistory += `\n\nASSISTANT: ${chatResult.text}`
      }

      setRevising(true)
      try {
        const row = await api.revisePlan(artifact.planId, combinedHistory)
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
    [query, attachments, busy, chatId, classId, artifact, stream, chatStream, messages, navigate, qc, toast, mayGenerate, openPaywall, effectiveWeek]
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
        /* The "Revise Thursday's Do Now…" message above was appended AND
           persisted before the request. With only a toast here, a failure left
           a question with no reply — and because the question was saved and the
           toast was not, it survived reload as an unanswered request nobody
           could explain. The reply is persisted for the same reason. */
        const failed = `Couldn’t revise ${label}. ${err.message}`
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: 'assistant', isError: true, content: failed, hint: err.hint },
        ])
        if (saveTo) api.addMessage(saveTo, { role: 'assistant', content: failed }).catch(() => {})
        toast.apiError(`Could not revise ${label}`, err)
      } finally {
        setRevising(false)
      }
    },
    [artifact, toast, flash]
  )

  /* Stopping used to say nothing at all: useLessonStream returns null on an
     AbortError and fires no callback, so the transcript kept the question and
     never acquired a reply. The teacher was left looking at their own message
     with no indication anything had happened. */
  const stopGenerating = useCallback(() => {
    stream.stop()
    const content = 'Stopped. Nothing was saved — ask again when you’re ready.'
    setMessages((prev) => [...prev, { id: nextId(), role: 'assistant', content, isError: true }])
    if (localFor.current) {
      api.addMessage(localFor.current, { role: 'assistant', content }).catch(() => {})
    }
  }, [stream])

  /* useChatStream.stop() has worked since it was written; nothing ever called
     it. The composer's own fallback — a spinner captioned "this can't be
     interrupted" — was therefore lying specifically about the conversational
     reply, which is interruptible and just wasn't wired. */
  const stopChatting = useCallback(() => {
    chatStream.stop()
    const content = 'Stopped. Nothing was saved — ask again when you’re ready.'
    setMessages((prev) => [...prev, { id: nextId(), role: 'assistant', content, isError: true }])
    if (localFor.current) {
      api.addMessage(localFor.current, { role: 'assistant', content }).catch(() => {})
    }
  }, [chatStream])

  /* Rebuild the last plan from the same prompt. `onRetry` and `isLast` were
     declared on Message and never passed, so the retry button could not render
     and the only recovery from a failed build was retyping the whole prompt. */
  const retryLast = useCallback(() => {
    const lastAsk = [...messages].reverse().find((m) => m.role === 'user')
    if (lastAsk) submit(lastAsk.content)
  }, [messages, submit])

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

  /* Voice mode's other half — see VoiceProvider for the mic button's. One
     effect watching `messages` catches every assistant reply this component
     creates (build confirmations, revision confirmations, errors, the whole
     handful of call sites in submit() below) without having to thread
     voice.speak() through each of them individually and risk a future one
     going quiet by omission. Guarded on the message's OWN id, not a count,
     so a load-more or a deleted message can't cause a stale reply to be
     spoken again. */
  useEffect(() => {
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'assistant' || last.streaming) return
    if (lastSpokenRef.current === last.id) return
    lastSpokenRef.current = last.id
    if (voice.enabled) voice.speak(last.content)
  }, [messages, voice])

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
  const overlayOpen = expanded && hasArtifact && isOverlay
  const overlayExit = useExitTransition(overlayOpen, 130)

  /* Auto-opens the drawer the moment a build starts or a plan exists; after
     that it is the teacher's to open or close, and closing it once does not
     get silently overridden on the next render (busy/hasArtifact going false
     again is not in this effect's deps). */
  useEffect(() => {
    if (busy || hasArtifact) setRailOpen(true)
  }, [busy, hasArtifact])

  /** Opening the document from anywhere, optionally straight into a cell. */
  const openDocument = useCallback((tweak = null) => {
    setOpenTweak(tweak)
    setExpanded(true)
  }, [])

  const collapse = useCallback(() => {
    setOpenTweak(null)
    setExpanded(false)
    /* Put focus back on the card that opened it.
       useFocusTrap captures the previously-focused element AFTER React has
       committed, and opening the docked document unmounts the rail in that
       same commit — so by then the trigger was already detached and the hook's
       `document.contains(previous)` guard correctly declined to restore. The
       result was focus on nothing: the next Tab started from "Skip to content"
       at the top of the app. The overlay path never had this, because there
       the trigger is a message button that stays mounted.

       Deferred a frame, because the rail has to remount first. */
    requestAnimationFrame(() => {
      document.getElementById('rail-open-title')?.focus({ preventScroll: true })
    })
  }, [])

  const artifactEl = (
    <ArtifactPanel
      artifact={{ ...liveArtifact, plan: livePlan }}
      classId={classId}
      missingDays={stream.isStreaming ? 'pending' : artifact?.planId ? 'no_school' : 'incomplete'}
      onCollapse={collapse}
      onReviseDay={!isPhone && artifact?.planId ? reviseDay : undefined}
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
        <Greeting
          onPick={submit}
          /* Drafting a suggestion puts the caret where the teacher has to keep
             typing. Without this, clicking "Build around a text" filled the
             composer and left focus on the suggestion button, so the next
             keystroke went nowhere and they had to click into the box to finish
             the sentence the app had just started for them. */
          onDraft={(text) => {
            setQuery(text)
            requestAnimationFrame(() => {
              const el = document.getElementById('composer-input')
              el?.focus()
              el?.setSelectionRange(text.length, text.length)
            })
          }}
          className={activeClass?.name}
        />
      ) : (
        <div className="min-h-0 flex-1 scroll-y" ref={scrollRef} onScroll={onScroll}>
          <div className="chat-column mx-auto flex w-full max-w-measure flex-col gap-7 px-gutter py-8">
            {messages.map((m, i) => (
              <Message
                key={m.id}
                message={m}
                isLast={i === messages.length - 1}
                onRetry={m.isError && !busy ? retryLast : undefined}
                /* The pencil rendered unguarded while this was never passed, so
                   clicking it opened a working editor whose "Send again" threw
                   and silently reverted the text. */
                onEdit={m.role === 'user' && !busy ? (_m, next) => submit(next) : undefined}
              />
            ))}

            {/* The conversational reply (chat_stream, ahead of any tool call)
                had no on-screen presence at all until its first token — the
                accumulating chatStream.text was tracked in state and never
                rendered. From a submit to either a reply or the plan-generation
                progress below, the screen just sat blank. Message already
                understands a `streaming` message (a blinking cursor, used
                elsewhere) — this is that, fed live text as it arrives instead
                of only the finished string once onDone fires. */}
            {chatStream.isStreaming && !stream.isStreaming ? (
              <Message
                message={{ id: 'chat-stream-live', role: 'assistant', content: chatStream.text, streaming: true }}
              />
            ) : null}

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
            ) : preparing ? (
              // The gap this covers: submit()'s first await, for a brand-new
              // chat, is api.createChat — which can run long on a cold Render
              // instance or a slow phone connection, and none of the other
              // busy flags exist yet. Without this line the message just sent
              // sat on screen with literally nothing happening beneath it.
              <p className="eyebrow">Sending…</p>
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

      {/* On a phone the 240px rail has nowhere to go, so the artifact becomes a
          one-row bar above the composer. Without it the only way to the .docx
          is the card inside the last assistant message, which scrolls out of
          reach as the conversation grows.

          A conditional, NOT wrapped in a fragment with the dock: React renders
          `null` as a placeholder, so the dock below keeps its child position
          and the Composer is never remounted. */}
      {hasArtifact && isPhone && !expanded ? (
        <ArtifactRail
          artifact={{ ...liveArtifact, plan: livePlan }}
          classId={classId}
          onExpand={() => openDocument()}
          busy={busy}
          variant="bar"
        />
      ) : null}

      {/* The dock. Composer must stay in the SAME slot of the same parent across
          the empty/non-empty transition — it owns a MediaRecorder, a
          ResizeObserver and an autosized inline height, all of which die on
          remount. Only the wrapper's className may change. */}
      <div className="shrink-0 border-t border-edge bg-paper px-gutter pb-5 pt-3">
        <div className="mx-auto w-full max-w-measure">
          {/* Which week this is about to become. Shown only before a plan
              exists in this chat — once one does, the chat-head above already
              names its week, and a plan already built is not up for a silent
              re-target. Without this, the teacher found out which week they got
              only after a 30-second generation finished. */}
          {isEmpty ? (
            <WeekPicker options={weekOptions} value={effectiveWeek} onChange={setSelectedWeek} />
          ) : null}
          <Composer
            value={query}
            onChange={setQuery}
            onSubmit={submit}
            /* Only a real stream is abortable — see the Composer. Revising has
               no AbortController yet, so `busy` without either flag correctly
               falls through to the composer's "can't be interrupted" spinner. */
            onStop={stream.isStreaming ? stopGenerating : chatStream.isStreaming ? stopChatting : undefined}
            isStreaming={busy}
            attachments={attachments}
            setAttachments={setAttachments}
            /* The example is worth its length on a laptop and clipped on a
               phone — the textarea is one row, so the second line of a wrapped
               placeholder is simply cut off mid-word. */
            placeholder={
              artifact?.planId
                ? isPhone
                  ? 'What should change?'
                  : 'What should change? — e.g. make Thursday a Socratic seminar'
                : isPhone
                  ? 'What are you planning?'
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
      {/* OUTSIDE chatPane. It used to live inside it, and ArtifactPanel sets
          aria-modal="true" when overlaying — which tells assistive tech to
          ignore everything outside the dialog, so on a phone with the document
          open "Building the lesson plan." was never announced. "Revising" is in
          here too; it was a plain <p> with no live semantics at all. */}
      <div className="visually-hidden" role="status" aria-live="polite">
        {stream.isStreaming
          ? 'Building the lesson plan.'
          : revising
            ? 'Revising the plan.'
            : preparing
              ? 'Sending.'
              : artifact?.planId
                ? 'Lesson plan ready.'
                : ''}
      </div>

      <div
        className="flex min-w-0 flex-col transition-[flex-basis]"
        style={
          docOpen
            ? { flex: '0 0 var(--chat-w-narrow)', transitionDuration: 'var(--t-base)', transitionTimingFunction: 'var(--ease-out)' }
            : { flex: '1 1 0%', transitionDuration: 'var(--t-base)', transitionTimingFunction: 'var(--ease-out)' }
        }
      >
        {chatPane}
      </div>

      {/* The rail docks from 768 up, not 1280. Gating it on `!isOverlay` left
          768–1279 with NO rail at all — no Download, no "Built from", no
          grounding count — even though 240px fits easily there (chat is 528px
          at 768 and 520px at 1024, both above the ~460px column this redesign
          was correcting). Below 768 it is the bar inside chatPane instead. */}
      {!isPhone && !docOpen ? (
        <ArtifactDrawer
          open={railOpen}
          onToggle={() => setRailOpen((o) => !o)}
          hasArtifact={hasArtifact}
          artifact={{ ...liveArtifact, plan: livePlan }}
          classId={classId}
          onExpand={() => openDocument()}
          busy={busy}
        />
      ) : null}

      {docOpen ? artifactEl : null}

      {/* Below --xl the document cannot sit beside the chat, so it overlays —
          and here the dialog semantics ArtifactPanel claims are actually true. */}
      {overlayExit.mounted ? (
        <>
          <button
            type="button"
            aria-label="Close lesson plan"
            className={`panel-scrim${overlayExit.closing ? ' is-closing' : ''}`}
            onClick={collapse}
          />
          <div className={`artifact-overlay${overlayExit.closing ? ' is-closing' : ''}`}>
            {artifactEl}
          </div>
        </>
      ) : null}
    </div>
  )
}
