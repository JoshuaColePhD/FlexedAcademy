import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, Download, FileText, Pencil, RotateCcw } from 'lucide-react'
import { api } from '../lib/api'
import { scanGrounding } from '../lib/grounding'
import { Cite } from './Citation'
import { WeekStrip } from './WeekStrip'

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
export function Message({ message, onOpenArtifact, onRetry, onEdit, isLast }) {
  const { copied, copy } = useCopy()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)
  const ref = useRef(null)

  useEffect(() => {
    if (editing) {
      ref.current?.focus()
      ref.current?.setSelectionRange(draft.length, draft.length)
    }
  }, [editing, draft.length])

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
        <div className="w-full max-w-[85%] rounded-xl bg-paper-sunken p-4">
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
              className="rounded-md px-3 py-1.5 text-sm font-medium text-ink-muted transition-colors hover:bg-paper-sunken hover:text-ink"
              onClick={() => {
                setDraft(message.content)
                setEditing(false)
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-ink-inverse transition-colors hover:bg-ink-soft disabled:cursor-not-allowed disabled:opacity-40"
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

  /* While a plan is streaming, ChatPage shows the week strip filling in day by
     day. A second "thinking" indicator here would be two answers to one
     question, so this renders nothing until there is text. */
  if (message.streaming && !message.content) return null

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
        <div
          className={
            isUser
              ? 'rounded-2xl bg-paper-sunken px-4 py-3 text-[0.9375rem] leading-relaxed text-ink'
              : 'text-[0.9375rem] leading-relaxed text-ink'
          }
        >
          <p className="m-0 whitespace-pre-wrap">
            {message.content}
            {message.streaming ? (
              <span
                className="ml-1 inline-block h-4 w-1.5 animate-pulse bg-accent align-middle"
                aria-hidden="true"
              />
            ) : null}
          </p>
          {message.hint ? (
            <small className="mt-2 block rounded-md bg-mark-tint p-2 text-xs text-mark">
              {message.hint}
            </small>
          ) : null}
        </div>

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
              <p className="grounding-line">
                <span>Grounded:</span>
                {grounded.map((c) => (
                  <Cite key={c} code={c} grounded />
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
                        <Cite code={u.code} grounded={false} />
                        <span className="grounding-line-miss">
                          not retrieved — {u.dayName}
                        </span>
                      </span>
                    ))}
                  </>
                ) : null}
              </p>
            ) : null}
          </div>
        ) : null}

        {message.planId || message.previewPlan ? (
          <div className="artifact-card fa-lift mt-3">
            <span className="artifact-card-tile">
              <FileText size={17} aria-hidden="true" />
            </span>
            <button
              type="button"
              className="flex min-w-0 flex-1 flex-col items-start gap-0.5 bg-transparent text-left"
              onClick={() => onOpenArtifact(message)}
            >
              <span className="artifact-card-title">
                {message.weekLabel || message.plan?.week_of || 'Weekly lesson plan'}
              </span>
              <span className="artifact-card-sub">
                {message.planId ? 'Word document · Florence template' : 'Drafting…'}
              </span>
            </button>
            {message.planId ? (
              <a
                className="artifact-card-download fa-press"
                href={api.planDownloadUrl(message.planId)}
                download
              >
                <Download size={13} aria-hidden="true" /> Download
              </a>
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
            onClick={() => copy(message.content)}
            aria-label={copied ? 'Copied' : 'Copy this message'}
          >
            {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          </button>
          {isUser ? (
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
