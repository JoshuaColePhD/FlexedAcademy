import { createPortal } from 'react-dom'
import { useRef } from 'react'
import { ExternalLink, Mail, X } from 'lucide-react'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useExitTransition } from '../hooks/useExitTransition'
import { SUPPORT_EMAIL, SUPPORT_GMAIL } from '../lib/support'

/* A small, human support handoff. Contact support should feel like part of
 * FlexEd, not like a browser-specific mailto side effect. The dialog gives the
 * teacher enough context to decide whether to reach out, then hands the final
 * send action to Gmail with the recipient and subject already filled in. */
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
  useFocusTrap(dialogRef, { active: true, trap: true, onEscape: onClose })

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
        className={`dialog${closing ? ' is-closing' : ''}`}
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

        <p>
          FlexEd Academy is built by Josh Cole to help teachers turn their curriculum,
          calendars, and school templates into dependable lesson plans.
        </p>

        <div className="mt-5 rounded-xl border border-edge bg-paper-sunken p-4">
          <p className="m-0 text-sm leading-relaxed text-ink-soft">
            Have a question, comment, or idea? Send a note with the school, course,
            and what you were trying to do. That context makes it much easier to help.
          </p>
        </div>

        <div className="mt-5 flex items-center gap-3 border-t border-edge pt-4">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-mark-tint text-mark">
            <Mail size={16} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="m-0 text-2xs font-semibold uppercase tracking-wider text-ink-muted">Email Josh</p>
            <p className="m-0 truncate text-sm font-medium text-ink">{SUPPORT_EMAIL}</p>
          </div>
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>Maybe later</button>
          <a
            href={SUPPORT_GMAIL}
            target="_blank"
            rel="noreferrer"
            className="btn btn-primary"
            onClick={onClose}
          >
            <ExternalLink size={14} className="mr-1.5" aria-hidden="true" /> Open email
          </a>
        </div>
      </section>
    </div>
  )
}
