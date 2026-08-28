import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ExternalLink, Loader2, Upload } from 'lucide-react'
import { api } from '../lib/api'
import { copyPlanShareLink, stopSharingPlan } from '../lib/shareLink'
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
export function ShareDialog({ open, onClose, planId, isQuiz, quizId, documentName, returnTo }) {
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
  /* Whether THIS plan's /shared/{id} link currently works — null while
   * unknown. This dialog used to show the link and the "Copy" button
   * unconditionally, with no way to tell whether the plan was actually public
   * or to turn it back off: `stopSharingPlan` existed in lib/shareLink.js and
   * was never called from anywhere in the app. A teacher had no way to check
   * "is this still shared?" short of asking someone to try the link. */
  const [isPublic, setIsPublic] = useState(null)

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
    setIsPublic(null)
  }, [open, planId])

  // Independent of the Drive status effect below — the public link works
  // whether or not Drive is ever connected, so its state can't be gated
  // behind that fetch. GET /api/plans/{id} already returns `is_public`
  // (backend/db.py's _hydrate_plan does a plain SELECT * with no column
  // stripping), so no new endpoint was needed — this dialog just never read
  // the field that was already there.
  useEffect(() => {
    if (!open || isQuiz) return undefined
    let cancelled = false
    api
      .getPlan(planId)
      .then((p) => {
        if (!cancelled) setIsPublic(!!p.is_public)
      })
      .catch(() => {
        if (!cancelled) setIsPublic(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, planId, isQuiz])

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
    // returnTo was accepted by ArtifactPanel's own call site but never
    // actually used here — driveConnectUrl() with no argument sent
    // "undefined" as the return_to query param, which routes/drive.py's own
    // `return_to.startswith("/")` guard rejects, silently falling back to
    // "/" and stranding the teacher back at the app's front door instead of
    // the plan/quiz they were trying to share. Falls back to the CURRENT
    // page for callers that don't pass returnTo at all (the quiz share
    // dialogs, ArtifactRail.jsx/ArtifactDetailPanel.jsx) — always right,
    // since a share dialog only ever opens from the page it should return
    // to.
    window.location.assign(
      api.driveConnectUrl(returnTo || `${window.location.pathname}${window.location.search}`)
    )
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

  return createPortal(
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
        {/* Was "Export ..." with a "Download to your computer" section right
            below this heading — the header's own Download button (a real
            <a download>, not a click into this dialog any more) covers
            that directly now, and this dialog is the Cloud/Export
            button's own dedicated "more options" surface, Josh's own ask:
            "the share link and drive should be in the cloud button." What's
            left here is exactly the two things that only ever lived here —
            the public link, and Drive/Canvas. */}
        <h2 id="share-title">Share {documentName ? `“${documentName}”` : 'this file'}</h2>

        {!isQuiz && (
          <div className="mb-6 rounded-lg bg-paper-sunken p-4 border border-edge">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium">Share a read-only link</h3>
              {/* The dialog used to look identical whether the plan was public
                  or not — no way to tell, short of asking someone to try the
                  link. isPublic === null is "still checking", not "off",
                  so nothing renders here until the fetch above resolves. */}
              {isPublic ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-ok-tint px-2 py-0.5 text-2xs font-medium text-ok">
                  <Check size={11} aria-hidden="true" /> Shared
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-ink-soft mb-3">
              {isPublic
                ? 'Anyone with this link can read the week and copy it into their own classes — no account needed.'
                : "Copy the link to share this plan. Anyone who has it can read the week and copy it into their own classes — no account needed."}
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                readOnly
                value={`${window.location.origin}/shared/${planId}`}
                className="input flex-1 bg-paper-inset text-ink-muted select-all font-mono text-xs"
                onClick={e => e.target.select()}
              />
              {/* Both this and "Stop sharing" below await a network POST, and
                  both used to do it with no disabled state and no label
                  change — a dead-looking button for a whole round trip, and
                  re-clickable while the first request was still out. The
                  dialog already owned `submitting` for its other two
                  actions; these two just weren't using it. */}
              <button
                type="button"
                className="btn shrink-0"
                disabled={submitting}
                onClick={async () => {
                  if (submitting) return
                  setSubmitting(true)
                  try {
                    const ok = await copyPlanShareLink(planId, toast)
                    if (ok) setIsPublic(true)
                  } finally {
                    setSubmitting(false)
                  }
                }}
              >
                {submitting ? 'Copying…' : 'Copy'}
              </button>
              {/* stopSharingPlan (lib/shareLink.js) has existed since the
                  sharing fix landed and was never called from anywhere in the
                  app — this is the missing "turn it off" the dialog's own copy
                  above has always promised. */}
              {isPublic ? (
                <button
                  type="button"
                  className="btn shrink-0"
                  disabled={submitting}
                  onClick={async () => {
                    if (submitting) return
                    setSubmitting(true)
                    try {
                      const ok = await stopSharingPlan(planId, toast)
                      if (ok) setIsPublic(false)
                    } finally {
                      setSubmitting(false)
                    }
                  }}
                >
                  {submitting ? 'Stopping…' : 'Stop sharing'}
                </button>
              ) : null}
            </div>
          </div>
        )}

        {/* Was a static "Save to Google Drive" regardless of isQuiz — right
            for the plan branch below, wrong for this one: a quiz never
            gets a drive_file_id (no backend route for it), and the section
            underneath this heading has always shown a Canvas push instead. */}
        <h3 className="text-sm font-medium mb-3">{isQuiz ? 'Push to Canvas' : 'Save to Google Drive'}</h3>

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
    </div>,
    document.body
  )
}
