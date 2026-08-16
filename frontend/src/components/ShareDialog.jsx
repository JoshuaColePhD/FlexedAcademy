import { useEffect, useRef, useState } from 'react'
import { Check, ExternalLink, Loader2 } from 'lucide-react'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useExitTransition } from '../hooks/useExitTransition'

/* "Share via Google" — a real Google Doc, shared with Drive's own
 * permissions.create, not a link this app invented. See backend/routes/drive.py
 * and routes/plans.py's /share endpoint for the two Google integrations this
 * sits on top of (sign-in is a separate, much narrower one).
 *
 * Three things this dialog can be looking at, and it renders exactly one:
 *
 *   unconfigured — the account itself has no Drive integration turned on.
 *                  Nothing to click; this is a statement, not a dead end.
 *   disconnected — configured, but THIS teacher hasn't granted Drive access
 *                  yet. One button, which is a real page navigation (Google's
 *                  consent screen can't be an iframe or a fetch).
 *   connected    — the actual share form: an email, a role, a Share button,
 *                  and whoever this plan has already been shared with.
 */
export function ShareDialog({ open, onClose, planId, weekLabel, returnTo }) {
  const toast = useToast()
  const { mounted, closing } = useExitTransition(open, 200)
  const dialogRef = useRef(null)
  const emailRef = useRef(null)

  const [status, setStatus] = useState('loading') // loading | unconfigured | disconnected | connected
  const [shares, setShares] = useState([])
  const [webLink, setWebLink] = useState(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('reader')
  const [submitting, setSubmitting] = useState(false)
  // The account-level default folder (Settings → Google Drive), shown here
  // so a teacher isn't surprised where this lands — read-only in this
  // dialog on purpose; changing it lives in Settings, not buried in a
  // per-share form.
  const [defaultFolderName, setDefaultFolderName] = useState(null)

  // Reset to a clean loading state every time the dialog opens on a
  // (possibly different) plan, rather than flashing the previous plan's
  // shares for a frame before the fetch below replaces them.
  useEffect(() => {
    if (!open) return
    setStatus('loading')
    setShares([])
    setWebLink(null)
    setEmail('')
    setRole('reader')
  }, [open, planId])

  useEffect(() => {
    if (!open) return undefined
    let cancelled = false
    ;(async () => {
      try {
        const s = await api.driveStatus()
        if (cancelled) return
        if (!s.enabled) return setStatus('unconfigured')
        if (!s.connected) return setStatus('disconnected')
        setDefaultFolderName(s.default_folder_name || null)
        const { web_link, shares: existing } = await api.listPlanShares(planId)
        if (cancelled) return
        setWebLink(web_link || null)
        setShares(existing || [])
        setStatus('connected')
      } catch {
        if (!cancelled) setStatus('unconfigured')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, planId])

  useFocusTrap(dialogRef, {
    active: open,
    trap: true,
    initialFocus: status === 'connected' ? emailRef : undefined,
    onEscape: onClose,
  })

  const connect = () => {
    window.location.assign(api.driveConnectUrl(returnTo))
  }

  const submit = async (e) => {
    e.preventDefault()
    if (submitting) return
    setSubmitting(true)
    try {
      const result = await api.sharePlan(planId, { email: email.trim(), role })
      setWebLink(result.web_link)
      setShares(result.shares || [])
      setEmail('')
      // The backend already retried into My Drive root and forgot the stale
      // folder (see routes/plans.py's share_plan) — this is just telling the
      // teacher it happened, and why their next share won't ask about a
      // folder that isn't there anymore.
      if (result.folder_fallback) {
        setDefaultFolderName(null)
        toast.info(
          'Saved to My Drive instead',
          'Your chosen folder wasn’t accessible, so this went to My Drive. Pick a new default in Settings if you’d like.'
        )
      } else {
        toast.success('Saved to Drive', `${weekLabel || 'The plan'} is now in your Google Drive.`)
      }
    } catch (err) {
      toast.apiError('Could not save to Drive', err)
    } finally {
      setSubmitting(false)
    }
  }

  if (!mounted) return null

  return (
    <div
      className={`dialog-scrim${closing ? ' is-closing' : ''}`}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className={`dialog${closing ? ' is-closing' : ''}`}
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-title"
      >
        <h2 id="share-title">Share {weekLabel ? `“${weekLabel}”` : 'this plan'}</h2>

        {status === 'loading' ? (
          <p className="flex items-center gap-2">
            <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Checking Google Drive…
          </p>
        ) : status === 'unconfigured' ? (
          <>
            <p>Sharing via Google isn’t set up for this account yet.</p>
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : status === 'disconnected' ? (
          <>
            <p>Connect your Google account to share this week as a Google Doc.</p>
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary fa-press" onClick={connect}>
                Connect Google Drive
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={submit}>
            <p>
              Save the .docx to your Google Drive as a real, editable Google Doc — into{' '}
              <strong>{defaultFolderName || 'My Drive'}</strong>
              {defaultFolderName ? '' : ', unless you set a default folder in Settings'}. You can
              optionally share it with a colleague's Google account right now.
            </p>
            <label className="mt-4 block">
              <span className="mb-1 block text-xs text-ink-muted">Google account email (optional)</span>
              <input
                ref={emailRef}
                type="email"
                className="input"
                placeholder="name@school.org"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label className="mt-3 block">
              <span className="mb-1 block text-xs text-ink-muted">Access</span>
              <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="reader">Can view</option>
                <option value="writer">Can edit</option>
              </select>
            </label>

            {shares.length ? (
              <div className="mt-4">
                <span className="mb-1 block text-xs text-ink-muted">Already shared with</span>
                <ul className="flex flex-col gap-1">
                  {shares.map((s) => (
                    <li key={`${s.email}-${s.created_at}`} className="flex items-center gap-1.5 text-sm text-ink-soft">
                      <Check size={13} className="shrink-0 text-ok" aria-hidden="true" />
                      {s.email} <span className="text-ink-faint">· {s.role === 'writer' ? 'can edit' : 'can view'}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {webLink ? (
              <a
                href={webLink}
                target="_blank"
                rel="noreferrer"
                className="mt-3 flex items-center gap-1.5 text-sm text-accent-text"
              >
                Open the Google Doc <ExternalLink size={13} aria-hidden="true" />
              </a>
            ) : null}

            <div className="dialog-actions">
              <button type="button" className="btn" onClick={onClose}>
                Close
              </button>
              <button
                type="submit"
                className="btn btn-primary fa-press"
                disabled={submitting}
              >
                {submitting ? 'Saving…' : email.trim() ? 'Save & Share' : 'Save to My Drive'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
