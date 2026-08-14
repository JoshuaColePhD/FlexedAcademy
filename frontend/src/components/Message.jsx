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
 * The teacher's own message is the one that looks written: set against a tinted
 * block, the way a quoted passage sits in a text. The app's reply is unadorned
 * body copy on the ruled lines — it is the page talking, not a second speaker,
 * so it gets no bubble and no avatar. The previous version gave the assistant a
 * greyscale logo avatar and a rounded chat bubble, which framed a document tool
 * as a messaging app. */
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
        <div className="neo-inset w-full max-w-[85%] rounded-xl bg-paper-sunken p-4">
          <label className="visually-hidden" htmlFor={`edit-${message.id}`}>
            Edit your message
          </label>
          <textarea
            id={`edit-${message.id}`}
            ref={ref}
            value={draft}
            className="min-h-[60px] w-full resize-none border-none bg-transparent text-[0.9375rem] text-ink outline-none"
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
              className="neo-raised rounded-full px-4 py-1.5 text-sm font-medium text-ink-soft transition-shadow"
              onClick={() => {
                setDraft(message.content)
                setEditing(false)
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              /* bg-accent-tint + accent text, not a solid ink fill — the
                 app's one primary-button treatment (see AppShell's "New
                 plan"), so "send again" reads the same as every other
                 commit action instead of a black slab. */
              className="neo-raised rounded-full bg-accent-tint px-4 py-1.5 text-sm font-medium text-accent-text transition-shadow disabled:cursor-not-allowed disabled:opacity-40"
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
      <div className={`flex max-w-[92%] flex-col ${isUser ? 'items-end' : 'w-full items-start'}`}>
        {/* An error reply used to render as ordinary assistant body copy, on
            the same ruled lines as a real plan — `isError` only tinted the
            hover-only icon row, so "The connection closed before the plan was
            finished." read as a normal answer unless you happened to hover it.
            Same marking as .marginalia uses for a grounding warning. */}
        <div
          className={
            isUser
              ? /* The teacher's own turn, pressed into the page rather than
                   floating on it — the assistant's replies are bare text on
                   the paper, so "said by you" reads as a groove cut into
                   that same sheet instead of a second card competing with
                   the reply beside it. */
                'neo-inset rounded-2xl bg-paper-sunken px-4 py-3 text-[0.9375rem] leading-relaxed text-ink'
              : message.isError
                ? 'msg-error text-[0.9375rem] leading-relaxed'
                : 'text-[0.9375rem] leading-relaxed text-ink'
          }
        >
          {isUser ? (
            <p className="m-0 whitespace-pre-wrap">{message.content}</p>
          ) : (
            <div className="msg-markdown">
              <ReactMarkdown>{message.content}</ReactMarkdown>
              {message.streaming ? (
                <span
                  className="ml-1 inline-block h-4 w-1.5 animate-pulse bg-accent align-middle"
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
        </div>

        {/* The guided alternative to typing — see LessonQuestions. Only ever
            on the most recent assistant turn in practice (answering submits
            the next message immediately), but not restricted to isLast: a
            reload's history should show what was asked even once it's moot. */}
        {!isUser && message.questions?.length && onAnswerQuestions ? (
          <div className="mt-3 w-full max-w-sm">
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
            className="rounded-md p-1.5 transition-colors hover:bg-paper-sunken hover:text-ink"
            /* The week and its codes, not just the sentence.
               An assistant reply's `content` is the fixed string "Built the
               week of X. Tell me what to change…", while the message also
               renders a full week strip and a grounding line. Pasting into an
               email or an LMS produced one meaningless sentence. */
            onClick={() => copy(copyableText(message, grounded, ungrounded))}
            aria-label={copied ? 'Copied' : 'Copy this message'}
          >
            {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          </button>
          {/* Guarded on onEdit, like the retry button beside it. Without the
              guard this rendered on every user message even though no caller
              supplied a handler, so the affordance was fully visible and
              silently discarded the edit. */}
          {isUser && onEdit ? (
            <button
              type="button"
              className="rounded-md p-1.5 transition-colors hover:bg-paper-sunken hover:text-ink"
              onClick={() => setEditing(true)}
              aria-label="Edit and send again"
            >
              <Pencil size={14} aria-hidden="true" />
            </button>
          ) : null}
          {!isUser && isLast && onRetry ? (
            <button
              type="button"
              className="rounded-md p-1.5 transition-colors hover:bg-paper-sunken hover:text-ink"
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
