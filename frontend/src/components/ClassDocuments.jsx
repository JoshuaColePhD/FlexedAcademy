import { useEffect, useRef, useState } from 'react'
import { FileText, Link2, Loader2, Trash2, Upload } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useConfirm } from '../lib/confirmContext'
import { useToast } from '../lib/toastContext'
import { qk } from '../lib/queryKeys'
import { errorParts } from '../lib/apiError'
import { KIND_LABEL } from './documentKinds'

/* ── documents for one class ───────────────────────────────────────────────
   A class holds several: the old table allowed exactly one per framework, so
   uploading a syllabus silently deactivated the pacing guide.

   A standalone file (not defined inline in ClassPage.jsx, where this used to
   live) so AddDocumentDialog can render the exact same upload flow from the
   composer without pulling ClassPage's own page-level code (FrameworkPicker,
   SchoolSelect, its framer-motion animations) into whatever bundle imports
   it. */
export function ClassDocuments({ cls, onChanged, onKindChange }) {
  const confirm = useConfirm()
  const toast = useToast()
  const fileRef = useRef(null)
  const [kind, setKind] = useState('pacing_guide')
  // AddDocumentDialog mirrors `kind` into its own state (to name the
  // selected type in its heading) — this is the only thing ClassDocuments
  // reports upward beyond onChanged. A no-op for ClassPage's own inline
  // usage, which doesn't pass it.
  useEffect(() => {
    onKindChange?.(kind)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind])
  const [uploading, setUploading] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  // A live Google Doc (or any other public link) as the alternative to a
  // file — see routes/curriculum.py's _resolve_source, which already knows
  // how to pull real .docx bytes out of a Google Docs URL specifically, and
  // falls back to scraping plain text out of anything else public.
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  // Removal calls the API then refetches — the row's actual disappearance
  // rides on that refetch's own timing, not a local splice. Same reasoning
  // as PlansPage/HistoryPage's deletingIds: flag it closing the moment
  // it's confirmed (fa-row-exit is already invisible/collapsed well before
  // the refetch lands), only ever cleared on failure.
  const [removingIds, setRemovingIds] = useState(new Set())
  const docs = useQuery({
    queryKey: qk.classDocuments(cls.id),
    queryFn: () => api.listClassDocuments(cls.id),
    retry: false,
  })

  const save = async (fileOrNull, sourceUrl) => {
    setUploading(true)
    try {
      // classId and kind are what make the upload land where the list reads.
      const res = await api.uploadCurriculumMap(cls.subject, fileOrNull, { classId: cls.id, kind, sourceUrl })
      toast.success(
        `${KIND_LABEL[kind]} saved`,
        res?.weeks_parsed ? `${res.weeks_parsed} weeks read from it.` : undefined
      )
      docs.refetch()
      onChanged?.()
      return true
    } catch (err) {
      toast.apiError(sourceUrl ? 'Could not read that link' : 'Could not read that file', err)
      return false
    } finally {
      setUploading(false)
    }
  }

  const upload = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    save(file, null)
  }

  // Same drag-and-drop shape as Composer.jsx's own attach handling — this
  // dialog sits right next to a composer that's accepted a dropped file
  // for a while now, so a browse-only button here read as an inconsistency
  // once the two were side by side.
  const handleDragOver = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  const handleDragLeave = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  const handleDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    save(file, null)
  }

  const submitLink = async (e) => {
    e.preventDefault()
    const url = linkUrl.trim()
    if (!url || uploading) return
    const ok = await save(null, url)
    if (ok) {
      setLinkUrl('')
      setLinkOpen(false)
    }
  }

  const removeDoc = async (doc) => {
    const ok = await confirm({
      title: `Remove “${doc.original_name}”?`,
      body: 'Plans already built from it are unaffected.',
      confirmLabel: 'Remove',
      tone: 'danger',
    })
    if (!ok) return
    setRemovingIds((prev) => new Set(prev).add(doc.id))
    try {
      await api.deleteCurriculumMap(doc.id)
      docs.refetch()
      onChanged?.()
    } catch (err) {
      setRemovingIds((prev) => {
        const next = new Set(prev)
        next.delete(doc.id)
        return next
      })
      toast.apiError('Could not remove that document', err)
    }
  }

  const rows = docs.data || []

  return (
    <div
      className={`relative mt-2 space-y-2 rounded-xl transition-all ${isDragging ? 'ring-2 ring-accent' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragging ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-paper-raised/90 backdrop-blur-sm">
          <p className="flex items-center gap-2 text-sm font-semibold text-accent-text">
            <Upload size={16} aria-hidden="true" /> Drop file to add
          </p>
        </div>
      ) : null}
      {rows.length ? (
        <ul className="neo-inset divide-y divide-edge overflow-hidden rounded-lg bg-paper-sunken">
          {rows.map((d) => (
            <li
              key={d.id}
              className={`flex items-center gap-2.5 px-3 py-2${removingIds.has(d.id) ? ' fa-row-exit' : ''}`}
            >
              <FileText size={14} aria-hidden="true" className="shrink-0 text-ink-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-ink">{d.original_name}</span>
                <span className="text-xs text-ink-muted">
                  {KIND_LABEL[d.kind] || d.kind} · {(d.chars || 0).toLocaleString()} characters
                </span>
              </span>
              <button
                type="button"
                className="btn-icon shrink-0"
                onClick={() => removeDoc(d)}
                aria-label={`Remove ${d.original_name}`}
                title="Remove this document"
              >
                <Trash2 size={13} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : docs.isLoading ? (
        <div className="flex flex-col items-center justify-center p-6 bg-paper-sunken/30 rounded-xl border border-dashed border-edge/30">
          <Loader2 size={24} className="animate-spin text-ink-muted mb-2" />
          <p className="text-xs text-ink-muted">Loading documents…</p>
        </div>
      ) : docs.isError ? (
        <div className="p-4 bg-mark/5 border border-mark/20 rounded-xl">
          <p className="text-xs text-mark">
            Couldn’t load documents. {errorParts(docs.error).message}
          </p>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center p-8 bg-paper-sunken/30 rounded-xl border border-dashed border-edge/30 text-center">
          <div className="bg-paper p-3 rounded-full shadow-sm border border-edge/20 mb-3">
            <FileText size={24} className="text-ink-muted" />
          </div>
          <p className="text-sm font-medium text-ink">No documents yet</p>
          <p className="text-xs text-ink-muted mt-1 max-w-xs">Upload your pacing guides, rubrics, and syllabi to give the AI context about this class.</p>
        </div>
      )}

      <div className="mt-4 rounded-xl border border-dashed border-edge/60 bg-paper/30 p-5 transition-colors hover:border-edge/80">
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <label className="flex items-center gap-2 text-sm font-medium text-ink">
              <span className="text-ink-muted">Adding:</span>
              <select
                aria-label="Document type"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                className="neo-select rounded-lg bg-paper border border-edge/30 py-1.5 pl-3 pr-8 text-xs font-semibold text-ink shadow-sm cursor-pointer"
              >
                {Object.entries(KIND_LABEL).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="flex-1 sm:flex-none inline-flex items-center justify-center gap-2 rounded-lg bg-paper-raised px-4 py-2.5 text-sm font-medium text-ink hover:bg-paper-sunken border border-edge/40 shadow-sm transition-all disabled:opacity-50"
            >
              {uploading ? (
                <Loader2 size={16} className="animate-spin" aria-hidden="true" />
              ) : (
                <Upload size={16} className="text-ink-muted" aria-hidden="true" />
              )}
              {uploading ? 'Uploading…' : 'Upload File'}
            </button>
            <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md,.csv" hidden onChange={upload} />
            
            <span className="text-xs text-ink-muted font-medium px-1" aria-hidden="true">OR</span>
            
            <button
              type="button"
              onClick={() => setLinkOpen((open) => !open)}
              disabled={uploading}
              aria-pressed={linkOpen}
              className={`flex-1 sm:flex-none inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium border transition-all disabled:opacity-50 ${
                linkOpen 
                  ? 'bg-paper-sunken border-edge/60 text-ink shadow-inner' 
                  : 'bg-transparent border-dashed border-edge/50 text-ink-muted hover:border-edge/80 hover:text-ink hover:bg-paper/50'
              }`}
            >
              <Link2 size={16} aria-hidden="true" />
              Paste Link
            </button>
          </div>

          {linkOpen ? (
            <form onSubmit={submitLink} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 pt-3 border-t border-edge/30 mt-1 fa-rise">
              <label className="visually-hidden" htmlFor={`doc-link-${cls.id}`}>
                Google Doc or other public link
              </label>
              <input
                id={`doc-link-${cls.id}`}
                type="url"
                inputMode="url"
                autoFocus
                required
                placeholder="Paste a Google Doc link (or any public URL)"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                className="input min-w-0 flex-1 text-sm bg-paper shadow-sm py-2 px-3 rounded-lg border-edge/40"
              />
              <button
                type="submit"
                disabled={uploading || !linkUrl.trim()}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-ink px-4 py-2 text-sm font-medium text-paper transition-all hover:bg-ink/90 disabled:opacity-50 shadow-sm"
              >
                {uploading ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
                {uploading ? 'Reading…' : 'Add Link'}
              </button>
            </form>
          ) : null}
        </div>
      </div>
    </div>
  )
}
