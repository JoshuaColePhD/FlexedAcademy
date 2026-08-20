import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, Pencil, RotateCcw } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { scanGrounding } from '../lib/grounding'
import { dayTitle, orderedDays } from '../lib/planShape'
import { Cite } from './Citation'
import { WeekStrip } from './WeekStrip'
import { LessonQuestions } from './LessonQuestions'

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
export function Message({ message, subject, onRetry, onEdit, onAnswerQuestions, isLast }) {
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

  /* fa-rise was written for exactly this and then never attached to anything,
     so every message simply appeared — which is most of why the transcript felt
     abrupt. CSS animations run once per mount, and React keeps existing
     messages mounted when one is appended, so only the new message plays.

     Deliberately NOT staggered per sibling. A stagger is computed from the
     index, and the index of an appended message is large — so your own message
     would sit invisible for hundreds of milliseconds before fading in, which is
     worse than no animation at all. The entry reads fine without it. */
  return (
    <div className={`fa-rise group flex w-full ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`flex max-w-full flex-col ${isUser ? 'items-end' : 'w-full items-start'}`}>
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
                  'neo-raised rounded-2xl bg-paper-raised px-4 py-3 text-[0.9375rem] leading-relaxed text-ink'
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

        {/* The guided alternative to typing — see LessonQuestions. Only ever
            on the most recent assistant turn in practice (answering submits
            the next message immediately), but not restricted to isLast: a
            reload's history should show what was asked even once it's moot. */}
        {!isUser && message.questions?.length && onAnswerQuestions ? (
          <div className="mt-3 w-full">
            <LessonQuestions
              questions={message.questions}
              onSubmit={(text) => onAnswerQuestions(message, text)}
            />
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
            With the document closed by default, this is where proof lives: the
            five days and what is on each, then which codes were retrieved and
            which one wasn't. It is what makes a bad week catchable without
            opening a viewer — and it is less UI than the panel it replaces. */}
        {!isUser && message.plan?.days?.length ? (
          <div className="mt-3 flex w-full flex-col gap-3.5">
            <WeekStrip days={message.plan.days} loose />
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
          </div>
        ) : null}

        <div
          className={`mt-1 flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 ${
            isUser ? 'justify-end' : 'justify-start'
          } ${message.isError ? 'text-mark' : 'text-ink-muted'}`}
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
    </div>
  )
}
