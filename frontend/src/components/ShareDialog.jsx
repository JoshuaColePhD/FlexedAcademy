import { useEffect, useRef, useState } from 'react'
import { Check, Download, ExternalLink, Loader2, Upload } from 'lucide-react'
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
export function ShareDialog({ open, onClose, planId, isQuiz, quizId, documentName, downloadUrl }) {
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
    if (!open || isQuiz) return undefined
    let cancelled = false
    ;(async () => {
      try {
        const s = await api.driveStatus()
        if (cancelled) return
        if (!s.enabled) return setStatus('unconfigured')
        if (!s.connected) return setStatus('disconnected')
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
  }, [open, planId, isQuiz])

  useFocusTrap(dialogRef, {
    active: open,
    trap: true,
    initialFocus: isQuiz ? undefined : status === 'connected' ? emailRef : undefined,
    onEscape: onClose,
  })

  const connect = () => {
    window.location.assign(api.driveConnectUrl())
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
      toast.success('Saved to Drive', `${documentName || 'The plan'} is now in your Google Drive.`)
    } catch (err) {
      toast.apiError('Could not save to Drive', err)
    } finally {
      setSubmitting(false)
    }
  }

  const uploadToCanvas = async () => {
    if (submitting) return
    setSubmitting(true)
    try {
      await api.exportQuizToCanvas(planId, quizId)
      toast.success('Synced to Canvas', `${documentName || 'The quiz'} has been pushed to your Canvas courses.`)
      onClose()
    } catch (err) {
      toast.apiError('Could not sync to Canvas', err)
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
        <h2 id="share-title">Export {documentName ? `“${documentName}”` : 'this file'}</h2>

        <div className="mb-6 rounded-lg bg-paper-sunken p-4 border border-edge">
          <h3 className="text-sm font-medium">Download to your computer</h3>
          <p className="mt-1 text-sm text-ink-soft">
            {isQuiz 
              ? 'Download the quiz as a QTI .zip file, which you can import directly into Canvas.'
              : 'Download the lesson plan as a Microsoft Word (.docx) file.'}
          </p>
          <div className="mt-4">
            <a href={downloadUrl} className="btn w-full justify-center" download onClick={onClose}>
              <Download size={14} className="mr-1.5" aria-hidden="true" /> Download {isQuiz ? 'Quiz' : 'Plan'}
            </a>
          </div>
        </div>

        <h3 className="text-sm font-medium mb-3">Save to Google Drive</h3>
        
        {isQuiz ? (
          <>
            <p className="text-sm text-ink-soft mb-4">
              Since your school doesn't use the Canvas API yet, we've set up a test environment where you can preview how this 1-click sync would work!
            </p>
            <button 
              type="button" 
              className="btn btn-primary w-full justify-center" 
              onClick={uploadToCanvas}
              disabled={submitting}
            >
              {submitting ? <Loader2 size={14} className="mr-1.5 animate-spin" aria-hidden="true" /> : <Upload size={14} className="mr-1.5" aria-hidden="true" />}
              {submitting ? 'Pushing to Canvas…' : 'Push to Canvas'}
            </button>
          </>
        ) : status === 'loading' ? (
          <p className="flex items-center gap-2 text-sm text-ink-soft">
            <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Checking Google Drive…
          </p>
        ) : status === 'unconfigured' ? (
          <>
            <p className="text-sm text-ink-soft">Sharing via Google isn’t set up for this account yet.</p>
            <div className="dialog-actions mt-4">
              <button type="button" className="btn" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : status === 'disconnected' ? (
          <>
            <p className="text-sm text-ink-soft">Connect your Google account to share this week as a Google Doc.</p>
            <div className="dialog-actions mt-4">
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
            <p className="text-sm text-ink-soft">
              Save the .docx to your Google Drive as a real, editable Google Doc. 
              You can optionally share it with a colleague's Google account right now.
            </p>
            <label className="mt-4 block">
              <span className="mb-1 block text-xs text-ink-muted">Google account email (optional)</span>
              <input
                ref={emailRef}
                type="email"
                className="input w-full"
                placeholder="name@school.org"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label className="mt-3 block">
              <span className="mb-1 block text-xs text-ink-muted">Access</span>
              <select className="input w-full" value={role} onChange={(e) => setRole(e.target.value)}>
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

            <div className="dialog-actions mt-6">
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
