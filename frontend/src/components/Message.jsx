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
      <div className="msg is-user">
        <div className="msg-body" style={{ maxWidth: '100%', width: '100%' }}>
          <div className="msg-edit">
            <label className="visually-hidden" htmlFor={`edit-${message.id}`}>
              Edit your message
            </label>
            <textarea
              id={`edit-${message.id}`}
              ref={ref}
              value={draft}
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
            <div className="msg-edit-actions">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setDraft(message.content)
                  setEditing(false)
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
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
      </div>
    )
  }

  return (
    <div className={`msg is-${message.role}${message.isError ? ' is-error' : ''}`}>
      {!isUser ? (
        <span className="msg-avatar">
          <img src="/logo.png" alt="" aria-hidden="true" />
        </span>
      ) : null}

      <div className="msg-body">
        <p className="msg-text">
          {message.content}
          {message.streaming ? <span className="caret" aria-hidden="true" /> : null}
          {message.hint ? <small className="msg-error-hint">{message.hint}</small> : null}
        </p>

        {message.planId || message.previewPlan ? (
          <button type="button" className="artifact-card" onClick={() => onOpenArtifact(message)}>
            <FileText size={17} aria-hidden="true" />
            <span className="artifact-card-text">
              <strong>{message.weekLabel || 'Weekly lesson plan'}</strong>
              <small>
                {message.planId
                  ? 'Florence City Schools template · open to review and download'
                  : 'Drafting…'}
              </small>
            </span>
          </button>
        ) : null}

        <div className="msg-actions">
          <button
            type="button"
            className="btn-icon"
            onClick={() => copy(message.content)}
            aria-label={copied ? 'Copied' : 'Copy this message'}
          >
            {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          </button>
          {isUser ? (
            <button
              type="button"
              className="btn-icon"
              onClick={() => setEditing(true)}
              aria-label="Edit and send again"
            >
              <Pencil size={14} aria-hidden="true" />
            </button>
          ) : null}
          {!isUser && isLast && onRetry ? (
            <button
              type="button"
              className="btn-icon"
              onClick={onRetry}
              aria-label="Try generating again"
            >
              <RotateCcw size={14} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
