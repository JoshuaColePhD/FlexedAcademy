import { createPortal } from 'react-dom'
import { useRef, useState } from 'react'
import { Mail, Send, X } from 'lucide-react'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useExitTransition } from '../hooks/useExitTransition'
import { api } from '../lib/api'
import { useAuth } from '../lib/authContext'
import { SUPPORT_EMAIL, SUPPORT_SUBJECT } from '../lib/support'

/* A small, human support composer. Contact support stays inside FlexEd, with
 * the account's reply address and Josh's destination visible before sending.
 * The backend owns the actual delivery so the teacher never has to leave the
 * app or copy context into another mail client. */
export function SupportDialog({ open, onClose }) {
  const { mounted, closing } = useExitTransition(open, 200)

  if (!mounted) return null

  return createPortal(
    <SupportDialogContent
      closing={closing}
      onClose={onClose}
    />,
    document.body,
  )
}

function SupportDialogContent({ closing, onClose }) {
  // Keep the trap hook in a component that is only mounted while the portal is
  // present. This also makes focus return to the Contact support trigger after
  // the exit transition completes.
  const dialogRef = useRef(null)
  const { user } = useAuth()
  const [subject, setSubject] = useState(SUPPORT_SUBJECT)
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  useFocusTrap(dialogRef, { active: true, trap: true, onEscape: onClose })

  const sendMessage = async (event) => {
    event.preventDefault()
    const trimmedMessage = message.trim()
    if (!trimmedMessage || sending) return
    setSending(true)
    setError('')
    try {
      await api.sendSupportMessage({ subject: subject.trim() || SUPPORT_SUBJECT, message: trimmedMessage })
      setSent(true)
    } catch (err) {
      setError(err?.message || 'Could not send your message right now.')
    } finally {
      setSending(false)
    }
  }

  return (
    <div
      className={`dialog-scrim dialog-scrim--panel${closing ? ' is-closing' : ''}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="support-dialog-title"
        className={`dialog dialog-support${closing ? ' is-closing' : ''}`}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="m-0 text-2xs font-semibold uppercase tracking-[0.16em] text-mark">
              FlexEd Academy support
            </p>
            <h2 id="support-dialog-title" className="mt-2">Let’s make FlexEd better.</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close support dialog"
            title="Close"
            className="-mr-2 -mt-2 grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-muted transition-colors hover:bg-paper-inset hover:text-ink"
          >
            <X size={17} aria-hidden="true" />
          </button>
        </div>

        {sent ? (
          <div className="mt-5 rounded-xl border border-ok/30 bg-ok-tint p-4" role="status">
            <div className="flex items-start gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-ok-tint text-ok">
                <Mail size={16} aria-hidden="true" />
              </span>
              <div>
                <p className="m-0 font-semibold text-ink">Message sent to Josh.</p>
                <p className="mt-1 text-sm leading-relaxed text-ink-soft">He can reply directly to {user?.email || 'your account email'}.</p>
              </div>
            </div>
            <div className="dialog-actions mt-5">
              <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
            </div>
          </div>
        ) : (
          <form className="mt-5" onSubmit={sendMessage}>
            <div className="rounded-xl border border-edge bg-paper-sunken p-3">
              <div className="grid gap-2 text-xs">
                <div className="flex items-baseline gap-3">
                  <span className="w-12 shrink-0 font-semibold uppercase tracking-wider text-ink-muted">From</span>
                  <span className="min-w-0 truncate text-ink">{user?.email || 'Your account email'}</span>
                </div>
              </div>
              <p className="mt-3 border-t border-edge pt-3 text-2xs leading-relaxed text-ink-muted">
                Sent securely to Josh Cole at {SUPPORT_EMAIL}. Josh can reply directly to this email.
              </p>
            </div>

            <label className="mt-4 grid gap-1.5 text-sm font-semibold text-ink">
              Subject
              <input
                type="text"
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                maxLength={120}
                className="input w-full"
              />
            </label>
            <label className="mt-4 grid gap-1.5 text-sm font-semibold text-ink">
              Message
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                maxLength={5000}
                rows={6}
                required
                autoFocus
                placeholder="Tell Josh what you noticed, what you were trying to do, or what you would improve."
                className="input support-message-input min-h-32 w-full resize-y leading-relaxed"
              />
            </label>
            {error ? <p className="mt-2 text-sm text-mark" role="alert">{error}</p> : null}

            <div className="dialog-actions mt-5">
              <button type="button" className="btn" onClick={onClose} disabled={sending}>Maybe later</button>
              <button type="submit" className="btn btn-primary" disabled={!message.trim() || sending}>
                <Send size={14} className="mr-1.5" aria-hidden="true" />
                {sending ? 'Sending…' : 'Send message'}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  )
}
