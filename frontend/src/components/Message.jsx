import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, Copy, Pencil, RotateCcw } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { scanGrounding } from '../lib/grounding'
import { dayTitle, orderedDays } from '../lib/planShape'
import { Cite } from './Citation'
import { WeekStrip } from './WeekStrip'
import { ThinkingIndicator } from './ThinkingIndicator'

/** What Copy puts on the clipboard: the reply, plus the week and the codes the
 *  message is actually showing. */
function copyableText(message, grounded, ungrounded) {
  const parts = [message.content]
  const days = message.plan?.days
  if (days?.length) {
    parts.push(
      '',
      ...orderedDays(message.plan, 'no_school').map(
        (d) => `${d.name}: ${d.no_school ? 'No school' : dayTitle(d) || '—'}`
      )
    )
  }
  if (grounded?.length) parts.push('', `Grounded: ${grounded.join(', ')}`)
  if (ungrounded?.length) {
    parts.push(`Not retrieved: ${ungrounded.map((u) => `${u.code} (${u.dayName})`).join(', ')}`)
  }
  return parts.join('\n')
}

function useCopy() {
  const [copied, setCopied] = useState(false)
  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard blocked (insecure context) — the button just won't confirm.
    }
  }
  return { copied, copy }
}

/* One exchange on the page.
 *
 * Both turns sit in the same neo-raised, rounded box now — the teacher's own
 * message tinted with the accent color, the app's reply in the plain
 * neutral card surface (bg-paper-raised) the rest of the app already uses
 * for a "card." Same shape, different fill: that's what keeps "said by you"
 * distinct from "said by the app" without giving the assistant an avatar or
 * a second speaker's identity — it's still the page talking back, just
 * boxed like everything else here. */
export function Message({
  message,
  subject,
  onRetry,
  onEdit,
  isLast,
  hideWeekStrip = false,
  voiceOpen = false,
  // False for every bubble but the last in a same-role run (ChatPage's own
  // grouping) — a tightly-stacked run only needs one timestamp, on the
  // bubble it actually ended at, not one per line fighting the same-role
  // spacing that's supposed to read as "one thought, several lines."
  showTimestamp = true,
}) {
  const { copied, copy } = useCopy()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)
  const ref = useRef(null)

  /* `draft.length` was a dependency, so this re-ran on every keystroke and
     forced the caret back to the end — click into the middle of a prompt to fix
     one word and every letter you typed teleported to the end of the line. It
     should place the cursor ONCE, when the editor opens. */
  useEffect(() => {
    if (!editing) return
    const el = ref.current
    el?.focus()
    el?.setSelectionRange(el.value.length, el.value.length)
  }, [editing])

  const isUser = message.role === 'user'
  const assistantSettled = !isUser && !message.streaming && !message.isError
  /* message.created_at only exists once a message has round-tripped through
     the server (see ChatPage's `loaded` mapping on reopening a chat) — a
     message this session just sent or received locally has no timestamp of
     its own yet, and nothing here re-fetches to backfill one. Falling back
     to "now" the one time this memo runs for that message (the dependency
     is `undefined` either way, so it never recomputes on a later render —
     no ticking clock, no drift while a reply streams in) means every
     message shows a real time immediately instead of only after a reload. */
  const timeString = useMemo(() => {
    try {
      return new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        minute: '2-digit',
      }).format(message.created_at ? new Date(message.created_at) : new Date())
    } catch {
      return ''
    }
  }, [message.created_at])


  /* Computed here rather than handed down, so a message that carries a plan
     carries its own proof and nothing upstream has to remember to attach it. */
  const { grounded, ungrounded } = useMemo(
    () => scanGrounding(message.plan, message.retrievedCodes),
    [message.plan, message.retrievedCodes]
  )

  if (isUser && editing) {
    return (
      <div className="group flex w-full justify-end">
        {/* Same neo-raised + accent-tint bubble as the sent message, not the
            paper-sunken groove this used to be — editing your own turn
            should still read as your turn, not switch to a different
            surface mid-edit. */}
        <div className="neo-raised w-full max-w-full rounded-2xl bg-accent-tint p-4">
          <label className="visually-hidden" htmlFor={`edit-${message.id}`}>
            Edit your message
          </label>
          <textarea
            id={`edit-${message.id}`}
            ref={ref}
            value={draft}
            className="min-h-[60px] w-full resize-none border-none bg-transparent text-[0.9375rem] text-accent-text outline-none placeholder:text-accent-text/60"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setDraft(message.content)
                setEditing(false)
              }
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                setEditing(false)
                onEdit(message, draft)
              }
            }}
          />
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              className="fa-press neo-raised rounded-full px-4 py-1.5 text-sm font-medium text-ink-soft transition-shadow"
              onClick={() => {
                setDraft(message.content)
                setEditing(false)
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              /* bg-paper, not the usual bg-accent-tint: the box around this
                 button IS accent-tint now (the bubble itself), so the
                 primary-button treatment inverts to stay legible — accent
                 text still marks it as "the" action, but the fill has to
                 read against the tint instead of matching it. */
              className="fa-press neo-raised rounded-full bg-paper px-4 py-1.5 text-sm font-medium text-accent-text transition-shadow disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!draft.trim()}
              onClick={() => {
                setEditing(false)
                onEdit(message, draft)
              }}
            >
              Send again
            </button>
          </div>
        </div>
      </div>
    )
  }

  /* The placeholder ChatPage pushes right before a reply starts streaming
     (see liveMessageIdRef in ChatPage.jsx) has nothing in it yet — a bare
     blinking cursor on an empty line reads as "nothing is happening," not
     "it's working." Voice mode's own status pill already says as much, so
     showing this too would say it twice; the placeholder still exists there
     (it becomes the real reply once one arrives), it just renders nothing
     until it has something to show. */
  const isThinking = !isUser && message.streaming && !message.content?.trim()
  if (isThinking && voiceOpen) return null

  /* fa-rise was written for exactly this and then never attached to anything,
     so every message simply appeared — which is most of why the transcript felt
     abrupt. CSS animations run once per mount, and React keeps existing
     messages mounted when one is appended, so only the new message plays.

     Deliberately NOT staggered per sibling. A stagger is computed from the
     index, and the index of an appended message is large — so your own message
     would sit invisible for hundreds of milliseconds before fading in, which is
     worse than no animation at all. The entry reads fine without it.

     isUser gets its own, snappier entrance than the assistant's — a sent
     message should feel like it was just launched (a firmer spring, a
     shorter travel distance since it's appearing right where the composer
     was), while a reply settles in more gently, matching the softer
     thinking→content cross-fade below rather than popping in on top of it. */
  return (
    <motion.div
      className={`group flex w-full ${isUser ? 'justify-end' : 'justify-start'}`}
      initial={isUser ? { opacity: 0, scale: 0.97, y: 6 } : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={
        isUser
          ? { type: 'spring', stiffness: 420, damping: 28 }
          : { type: 'spring', stiffness: 220, damping: 24 }
      }
    >
      <div className={`flex max-w-full flex-col ${isUser ? 'items-end' : 'w-full items-start'}`}>
        {/* Thinking dots and the real reply used to be two entirely separate
            component returns — the dots vanished the instant content
            arrived and the bubble popped in a beat later with no visual
            relationship between the two, reading as a hard cut rather than
            a reply arriving. Cross-fading them in the same slot (instead of
            the whole message remounting) makes that a single continuous
            moment: dots fade out as the bubble fades in. */}
        <AnimatePresence mode="wait" initial={false}>
          {isThinking ? (
            <motion.div
              key="thinking"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <ThinkingIndicator />
            </motion.div>
          ) : (
            <motion.div
              key="content"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              // layout: as streamed markdown grows or reflows (a list or
              // heading forming mid-reply), the bubble's own height changes
              // — without this it just snaps to the new size every chunk.
              // Framer animates the size change itself (FLIP), so growth
              // reads as the bubble easing open rather than jumping.
              layout="size"
            >
              {/* An error reply used to render as ordinary assistant body copy, on
                  the same ruled lines as a real plan — `isError` only tinted the
                  hover-only icon row, so "The connection closed before the plan was
                  finished." read as a normal answer unless you happened to hover it.
                  Same marking as .marginalia uses for a grounding warning. */}
              <div
                className={
                  isUser
                    ? /* The teacher's own turn, lifted off the page as its own
                         bubble rather than cut into it. Used to use bg-accent-tint
                         but now uses the logo's purple (brand) for a distinct voice
                         that does not shift with the selected class. */
                      'neo-raised rounded-2xl px-4 py-3 text-[0.9375rem] leading-relaxed'
                    : message.isError
                      ? 'msg-error text-[0.9375rem] leading-relaxed'
                      : /* Same neo-raised box as the teacher's own bubble, but
                           bg-paper-raised instead of bg-accent-tint — the app's
                           existing neutral "card" surface (see DecisionStack,
                           VoiceModePanel), not a colored one, so the two turns are
                           still visually distinct while both read as boxed. */
                        `neo-raised rounded-2xl bg-paper-raised px-4 py-3 text-[0.9375rem] leading-relaxed text-ink${assistantSettled ? ' fa-settle' : ''}`
                }
                /* Token, not a raw rgba() literal — the literal never adapted in
                   dark mode, so the teacher's own bubble stayed the same light
                   lavender tint regardless of theme while every other surface
                   (--accent-tint, --paper-raised) properly switched. */
                style={isUser ? { backgroundColor: 'rgb(var(--msg-user-bg-rgb) / 0.15)', color: 'var(--ink)' } : undefined}
              >
                {isUser ? (
                  <p className="m-0 whitespace-pre-wrap">{message.content}</p>
                ) : (
                  <div className="msg-markdown">
                    <ReactMarkdown>{message.content}</ReactMarkdown>
                    {message.streaming ? (
                      <span
                        className="fa-cursor ml-1 inline-block h-4 w-1.5 bg-accent align-middle"
                        aria-hidden="true"
                      />
                    ) : null}
                  </div>
                )}
                {message.hint ? (
                  <small className="mt-2 block rounded-md bg-mark-tint p-2 text-xs text-mark">
                    {message.hint}
                  </small>
                ) : null}

                {message.isError && isLast && onRetry ? (
                  <button
                    onClick={onRetry}
                    className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-mark px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-mark-dark sm:w-auto"
                  >
                    <RotateCcw size={16} />
                    Retry Request
                  </button>
                ) : null}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* The guided alternative to typing — see LessonQuestions, which now
            renders in a dock above the composer (ChatPage's pendingQuestions)
            instead of inline, so it reads as "answer below" rather than a
            card stuck mid-transcript that scrolls out of reach. isLast means
            this IS the pending round — the dock owns it, so there's nothing
            to show here. An older message that still carries unanswered
            questions (superseded by whatever was said since) gets a plain,
            non-interactive summary instead of silently dropping what was
            asked. */}
        {!isUser && message.questions?.length && !isLast ? (
          <div className="mt-3 flex flex-col gap-1 rounded-2xl bg-paper-sunken p-2.5 text-sm text-ink-muted">
            <p className="eyebrow text-ink-faint">Never answered</p>
            <ul className="flex list-none flex-col gap-1">
              {message.questions.map((q) => (
                <li key={q.id}>{q.text}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {message.unsaved ? (
          <span
            className="mt-1 inline-block rounded-sm bg-flag-tint px-1.5 py-0.5 text-[10px] font-semibold tracking-caps text-flag"
            title="This message was not saved to the conversation"
          >
            not saved
          </span>
        ) : null}

        {/* THE VERIFICATION.
            With the document closed by default, this is where proof lives:
            which codes were retrieved and which one wasn't, always — and,
            on phone (hideWeekStrip), the five days and what's on each too,
            since a phone has no side rail to carry that instead (see
            ArtifactRail's own "This week" section, which is where this
            lives everywhere else now). It is what makes a bad week
            catchable without opening a viewer — and it is less UI than the
            panel it replaces. */}
        {!isUser && message.plan?.days?.length ? (
          <div className="mt-3 flex w-full flex-col gap-3.5">
            {hideWeekStrip ? null : <WeekStrip days={message.plan.days} loose />}
            {grounded.length || ungrounded.length ? (
              <div className="grounding-line">
                <span>Grounded:</span>
                {grounded.map((c) => (
                  <Cite key={c} code={c} subject={subject} grounded />
                ))}
                {ungrounded.length ? (
                  <>
                    <span className="grounding-line-sep" aria-hidden="true">
                      ·
                    </span>
                    {/* The code and its verdict wrap as one unit. Split across
                        a line break, a bare "4.C※" reads as just another
                        citation and the warning loses its subject. */}
                    {ungrounded.map((u) => (
                      <span className="grounding-line-miss-group" key={u.code}>
                        <Cite code={u.code} subject={subject} grounded={false} />
                        <span className="grounding-line-miss">
                          not retrieved — {u.dayName}
                        </span>
                      </span>
                    ))}
                  </>
                ) : null}
              </div>
            ) : null}
            {/* message.thin is only ever set on the assistant message ChatPage
                pushes right after onDone (see its own comment) — a plan
                loaded from storage never carries it, so this is silent for
                every plan generated before this existed rather than
                guessing retroactively. */}
            {message.thin ? (
              <div className="grounding-line grounding-line-thin">
                <span>
                  Limited standards on file for this grade/subject — worth a second look before you teach it.
                </span>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Always on when it's the last bubble of a run (ChatPage's own
            groupEnd) — was folded into the hover-only action row below, so
            "what time was this" cost a mouse. A real conversation log reads
            its own timestamps at a glance; it shouldn't take a hover to
            find out when something was said. */}
        {timeString && showTimestamp ? (
          <span
            className={`mt-1 block text-3xs tracking-wider text-ink-faint ${isUser ? 'text-right' : 'text-left'}`}
          >
            {timeString}
          </span>
        ) : null}

        <div
          className={`flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 ${
            timeString && showTimestamp ? '' : 'mt-1'
          } ${isUser ? 'justify-end' : 'justify-start'} ${message.isError ? 'text-mark' : 'text-ink-muted'}`}
        >
          <button
            type="button"
            className="fa-press rounded-md p-1.5 transition-colors hover:bg-paper-sunken hover:text-ink"
            /* The week and its codes, not just the sentence.
               An assistant reply's `content` is the fixed string "Built the
               week of X. Tell me what to change…", while the message also
               renders a full week strip and a grounding line. Pasting into an
               email or an LMS produced one meaningless sentence. */
            onClick={() => copy(copyableText(message, grounded, ungrounded))}
            aria-label={copied ? 'Copied' : 'Copy this message'}
          >
            {/* The confirmation pops in rather than just swapping icons —
                the click already told the finger something happened
                (fa-press), so the eye gets its own answer a beat later
                instead of a silent glyph replacement. */}
            {copied ? (
              <Check key="copied" size={14} className="fa-pop" aria-hidden="true" />
            ) : (
              <Copy size={14} aria-hidden="true" />
            )}
          </button>
          {/* Guarded on onEdit, like the retry button beside it. Without the
              guard this rendered on every user message even though no caller
              supplied a handler, so the affordance was fully visible and
              silently discarded the edit. */}
          {isUser && onEdit ? (
            <button
              type="button"
              className="fa-press rounded-md p-1.5 transition-colors hover:bg-paper-sunken hover:text-ink"
              onClick={() => setEditing(true)}
              aria-label="Edit and send again"
            >
              <Pencil size={14} aria-hidden="true" />
            </button>
          ) : null}
          {!isUser && isLast && onRetry ? (
            <button
              type="button"
              className="fa-press rounded-md p-1.5 transition-colors hover:bg-paper-sunken hover:text-ink"
              onClick={onRetry}
              aria-label="Build this plan again"
            >
              <RotateCcw size={14} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
    </motion.div>
  )
}
