import { useRef, useState } from 'react'
import { FileText, Loader2, Trash2, Upload } from 'lucide-react'
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
export function ClassDocuments({ cls, onChanged }) {
  const confirm = useConfirm()
  const toast = useToast()
  const fileRef = useRef(null)
  const [kind, setKind] = useState('pacing_guide')
  const [uploading, setUploading] = useState(false)
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

  const upload = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true)
    try {
      // classId and kind are what make the upload land where the list reads.
      const res = await api.uploadCurriculumMap(cls.subject, file, { classId: cls.id, kind })
      toast.success(
        `${KIND_LABEL[kind]} saved`,
        res?.weeks_parsed ? `${res.weeks_parsed} weeks read from it.` : undefined
      )
      docs.refetch()
      onChanged?.()
    } catch (err) {
      toast.apiError('Could not read that file', err)
    } finally {
      setUploading(false)
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
    <div className="mt-2 space-y-2">
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
        <p className="text-xs text-ink-muted">
          No documents yet. A pacing guide lets plans follow your own sequence and unit names.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Document type"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className="neo-select neo-inset rounded-lg bg-paper-raised py-1.5 pl-2 pr-7 text-xs text-ink"
        >
          {Object.entries(KIND_LABEL).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="neo-raised inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:text-ink disabled:opacity-50"
        >
          {uploading ? (
            <Loader2 size={13} className="animate-spin" aria-hidden="true" />
          ) : (
            <Upload size={13} aria-hidden="true" />
          )}
          {uploading ? 'Reading…' : 'Add a document'}
        </button>
        <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md,.csv" hidden onChange={upload} />
      </div>
    </div>
  )
}
