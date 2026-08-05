import { useEffect, useRef, useState } from 'react'
import { Check, Copy, FileText, Pencil, RotateCcw } from 'lucide-react'

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

  return (
    <div className={`group flex w-full ${isUser ? 'justify-end' : 'justify-start'}`}>
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

        {message.planId || message.previewPlan ? (
          <button
            type="button"
            className="mt-3 flex w-full max-w-sm items-center gap-3 rounded-xl bg-paper-sunken p-3 text-left transition-colors hover:bg-paper-inset"
            onClick={() => onOpenArtifact(message)}
          >
            <span className="rounded-lg bg-paper-raised p-2 text-ink-muted">
              <FileText size={18} aria-hidden="true" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <strong className="truncate text-sm font-medium text-ink">
                {message.weekLabel || 'Weekly lesson plan'}
              </strong>
              <small className="truncate text-xs text-ink-muted">
                {message.planId ? 'Open to review, revise or download' : 'Drafting…'}
              </small>
            </span>
          </button>
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
