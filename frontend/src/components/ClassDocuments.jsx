import { useEffect, useRef, useState } from 'react'
import { FileText, Link2, Loader2, Trash2, Upload } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useConfirm } from '../lib/confirmContext'
import { useToast } from '../lib/toastContext'
import { qk } from '../lib/queryKeys'
import { errorParts } from '../lib/apiError'

export const KIND_LABEL = {
  pacing_guide: 'Pacing guide',
  syllabus: 'Syllabus',
  curriculum_map: 'Curriculum map',
  other: 'Other',
}

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
        <p className="text-xs text-ink-muted">Loading documents…</p>
      ) : docs.isError ? (
        /* Was indistinguishable from "no documents": rows fell back to [] on
           any error, so a failed request read as an empty class. */
        <p className="text-xs text-mark">
          Couldn’t load documents. {errorParts(docs.error).message}
        </p>
      ) : (
        <p className="text-xs text-ink-muted">No documents yet — add one below.</p>
      )}

      <div className="mt-1 flex flex-col gap-2.5">
        <label className="flex items-center gap-2 text-xs text-ink-muted">
          Save as
          <select
            aria-label="Document type"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="neo-select neo-inset rounded-lg bg-paper-raised py-1.5 pl-2 pr-7 text-xs font-medium text-ink"
          >
            {Object.entries(KIND_LABEL).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="fa-press neo-raised inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium text-ink transition-colors hover:bg-paper-sunken disabled:cursor-not-allowed disabled:opacity-50"
          >
            {uploading ? (
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            ) : (
              <Upload size={14} aria-hidden="true" />
            )}
            {uploading ? 'Reading…' : 'Add a document'}
          </button>
          <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md,.csv" hidden onChange={upload} />
          <span className="text-xs text-ink-faint" aria-hidden="true">or</span>
          <button
            type="button"
            onClick={() => setLinkOpen((open) => !open)}
            disabled={uploading}
            aria-pressed={linkOpen}
            className={`fa-press inline-flex items-center gap-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
              linkOpen ? 'text-accent-text' : 'text-ink-muted hover:text-ink hover:underline'
            }`}
          >
            <Link2 size={12} aria-hidden="true" />
            paste a link instead
          </button>
        </div>

        {linkOpen ? (
          <form onSubmit={submitLink} className="fa-context-pop flex flex-wrap items-center gap-2">
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
              className="input min-w-0 flex-1 text-xs"
            />
            <button
              type="submit"
              disabled={uploading || !linkUrl.trim()}
              className="neo-raised inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              {uploading ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : null}
              {uploading ? 'Reading…' : 'Add'}
            </button>
          </form>
        ) : null}
      </div>
    </div>
  )
}
