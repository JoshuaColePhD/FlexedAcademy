import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'

/**
 * A validated DOCX download. Native download links cannot distinguish a Word
 * file from the API's JSON error envelope, so this control always goes through
 * the API download helper before asking the browser to save anything. A caller
 * can provide downloadRequest for another DOCX artifact such as a quiz.
 */
export function DocxDownloadButton({ planId, downloadRequest, children, className = '', disabled = false, ...props }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const download = async (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (busy || disabled || !planId) return
    setBusy(true)
    try {
      await (downloadRequest ? downloadRequest() : api.downloadPlan(planId))
    } catch (error) {
      toast.apiError('Could not download the DOCX', error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      {...props}
      className={`${className} disabled:cursor-wait disabled:opacity-60`}
      onClick={download}
      disabled={busy || disabled || !planId}
      aria-busy={busy || undefined}
    >
      {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
      {children}
    </button>
  )
}
