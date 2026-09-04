import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, FileText, Link2, Loader2, Trash2, Upload } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useConfirm } from '../lib/confirmContext'
import { useToast } from '../lib/toastContext'
import { qk } from '../lib/queryKeys'
import { errorParts } from '../lib/apiError'
import { KIND_LABEL } from './documentKinds'

function DocumentRow({ doc, removing, featured, onRemove }) {
  return (
    <li
      className={`flex items-center gap-3 px-3 py-3${removing ? ' fa-row-exit' : ''}`}
    >
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${featured ? 'bg-accent/10 text-accent' : 'bg-paper-raised text-ink-muted'}`}>
        <FileText size={15} aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-ink">{doc.original_name}</span>
          {featured ? <span className="shrink-0 rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold text-accent">Featured</span> : null}
        </span>
        <span className="block text-xs text-ink-muted">
          {KIND_LABEL[doc.kind] || doc.kind} · {(doc.chars || 0).toLocaleString()} characters
        </span>
      </span>
      <button
        type="button"
        className="btn-icon shrink-0"
        onClick={() => onRemove(doc)}
        aria-label={`Remove ${doc.original_name}`}
        title="Remove this document"
      >
        <Trash2 size={13} aria-hidden="true" />
      </button>
    </li>
  )
}

function AddMaterialsControls({ cls, kind, setKind, fileRef, uploading, upload, linkOpen, setLinkOpen, submitLink, compact = false }) {
  return (
    <div className={compact ? 'mt-3 border-t border-edge/30 pt-4' : 'mt-4 rounded-xl border border-dashed border-edge/60 bg-paper/30 p-5 transition-colors hover:border-edge/80'}>
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <label className="flex items-center gap-2 text-sm font-medium text-ink">
            <span className="text-ink-muted">Adding:</span>
            <select
              aria-label="Document type"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              className="neo-select cursor-pointer rounded-lg border border-edge/30 bg-paper py-1.5 pl-3 pr-8 text-xs font-semibold text-ink shadow-sm"
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
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-edge/40 bg-paper-raised px-4 py-2.5 text-sm font-medium text-ink shadow-sm transition-all hover:bg-paper-sunken disabled:opacity-50 sm:flex-none"
          >
            {uploading ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Upload size={16} className="text-ink-muted" aria-hidden="true" />}
            {uploading ? 'Uploading…' : 'Upload File'}
          </button>
          <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md,.csv" hidden onChange={upload} />

          <span className="px-1 text-xs font-medium text-ink-muted" aria-hidden="true">OR</span>

          <button
            type="button"
            onClick={() => setLinkOpen((open) => !open)}
            disabled={uploading}
            aria-pressed={linkOpen}
            className={`inline-flex flex-1 items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium transition-all disabled:opacity-50 sm:flex-none ${linkOpen
              ? 'border-edge/60 bg-paper-sunken text-ink shadow-inner'
              : 'border-dashed border-edge/50 bg-transparent text-ink-muted hover:border-edge/80 hover:bg-paper/50 hover:text-ink'
            }`}
          >
            <Link2 size={16} aria-hidden="true" />
            Paste Link
          </button>
        </div>

        {linkOpen ? (
          <form onSubmit={submitLink} className="fa-rise mt-1 flex flex-col items-stretch gap-2 border-t border-edge/30 pt-3 sm:flex-row sm:items-center">
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
              className="input min-w-0 flex-1 rounded-lg border-edge/40 bg-paper px-3 py-2 text-sm shadow-sm"
            />
            <button
              type="submit"
              disabled={uploading || !linkUrl.trim()}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-ink px-4 py-2 text-sm font-medium text-paper shadow-sm transition-all hover:bg-ink/90 disabled:opacity-50"
            >
              {uploading ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
              {uploading ? 'Reading…' : 'Add Link'}
            </button>
          </form>
        ) : null}
      </div>
    </div>
  )
}

function MaterialStep({ number, title, detail, state, connector = true }) {
  const complete = state === 'complete'
  const active = state === 'active'
  return (
    <li className="relative flex gap-3">
      {connector ? <span className="absolute left-3.5 top-8 h-[calc(100%+0.75rem)] w-px bg-edge" aria-hidden="true" /> : null}
      <span className={`relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${complete
        ? 'bg-ok/15 text-ok'
        : active
          ? 'bg-accent text-white shadow-sm'
          : 'border border-edge bg-paper-sunken text-ink-faint'
      }`}>
        {complete ? <CheckCircle2 size={16} aria-hidden="true" /> : number}
      </span>
      <span className="min-w-0 pt-0.5">
        <span className={`block text-sm font-semibold ${active || complete ? 'text-ink' : 'text-ink-muted'}`}>{title}</span>
        <span className="mt-0.5 block text-xs text-ink-muted">{detail}</span>
      </span>
    </li>
  )
}

function OnboardingMaterialsFlow({
  cls,
  pacingGuides,
  supportingDocs,
  removingIds,
  onRemove,
  fileRef,
  uploading,
  upload,
  kind,
  setKind,
  linkOpen,
  setLinkOpen,
  submitLink,
  supportingOpen,
  setSupportingOpen,
}) {
  const hasPacingGuide = pacingGuides.length > 0
  const hasSupportingDocs = supportingDocs.length > 0
  return (
    <div className="space-y-4" aria-label="Teaching materials setup">
      <ol className="onboarding-glass-pane rounded-xl p-4" aria-label="Teaching materials steps">
        <MaterialStep
          number="1"
          title="Planning source"
          detail={hasPacingGuide ? 'Pacing source added.' : 'Pacing guide or curriculum map recommended.'}
          state={hasPacingGuide ? 'complete' : 'active'}
        />
        <MaterialStep
          number="2"
          title="Supporting materials"
          detail={hasSupportingDocs ? `${supportingDocs.length} ${supportingDocs.length === 1 ? 'source' : 'sources'} added.` : 'Optional: syllabus, rubric, or another source.'}
          state={hasSupportingDocs ? 'complete' : hasPacingGuide ? 'active' : 'upcoming'}
          connector={false}
        />
      </ol>

      <section className={`onboarding-glass-pane rounded-xl p-5 ${hasPacingGuide ? 'border-ok/25 bg-ok/5' : 'border-accent/25 bg-accent/5'}`} aria-labelledby={`pacing-guide-step-${cls.id}`}>
        <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div>
          <p className="eyebrow text-accent">Step 1 · Planning source</p>
          <h3 id={`pacing-guide-step-${cls.id}`} className="mt-1 text-base font-semibold text-ink">{hasPacingGuide ? 'Your planning source' : 'Add your planning source'}</h3>
          <p className="mt-1 max-w-xl text-xs text-ink-muted">Add a pacing guide, curriculum map, or syllabus—the source FlexEd uses to organize your plans.</p>
          </div>
          <span className={`shrink-0 rounded-full px-2 py-1 text-2xs font-semibold ${hasPacingGuide ? 'bg-ok/10 text-ok' : 'bg-accent/10 text-accent-text'}`}>
            {hasPacingGuide ? 'Ready for plans' : 'Recommended'}
          </span>
        </div>
        {hasPacingGuide ? (
          <ul className="neo-inset mt-4 divide-y divide-edge overflow-hidden rounded-lg bg-paper-sunken">
            {pacingGuides.map((doc) => (
              <DocumentRow key={doc.id} doc={doc} featured removing={removingIds.has(doc.id)} onRemove={onRemove} />
            ))}
          </ul>
        ) : (
          <button
            type="button"
            onClick={() => {
              setKind('pacing_guide')
              fileRef.current?.click()
            }}
            disabled={uploading}
            className="group mt-5 flex min-h-40 w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-accent/30 bg-paper/35 p-6 text-center transition-colors hover:border-accent/60 hover:bg-accent/10 disabled:opacity-50"
          >
            {uploading ? <Loader2 size={24} className="animate-spin text-accent-text" aria-hidden="true" /> : <Upload size={24} className="text-accent-text transition-transform group-hover:-translate-y-0.5" aria-hidden="true" />}
            <span className="text-sm font-semibold text-ink">Drop your primary source here</span>
            <span className="text-xs text-ink-muted">or click to choose a PDF, DOCX, TXT, MD, or CSV file</span>
          </button>
        )}
      </section>

      <details
        className="onboarding-glass-pane rounded-xl p-4"
        open={supportingOpen}
        onToggle={(event) => setSupportingOpen(event.currentTarget.open)}
      >
        <summary className="cursor-pointer list-none text-sm font-semibold text-ink marker:hidden">
          <span className="mr-2 text-accent-text">2.</span> Supporting materials
          <span className="ml-2 text-xs font-normal text-ink-muted">optional</span>
        </summary>
        {hasSupportingDocs ? (
          <ul className="neo-inset mt-4 divide-y divide-edge overflow-hidden rounded-lg bg-paper-sunken">
            {supportingDocs.map((doc) => (
              <DocumentRow key={doc.id} doc={doc} removing={removingIds.has(doc.id)} onRemove={onRemove} />
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-xs text-ink-muted">Add a syllabus, rubric, curriculum map, or another source if it will help the AI understand this class.</p>
        )}
        <AddMaterialsControls
          cls={cls}
          kind={kind}
          setKind={setKind}
          fileRef={fileRef}
          uploading={uploading}
          upload={upload}
          linkOpen={linkOpen}
          setLinkOpen={setLinkOpen}
          submitLink={submitLink}
          compact
        />
      </details>

    </div>
  )
}

/* ── documents for one class ───────────────────────────────────────────────
   A class holds several: the old table allowed exactly one per framework, so
   uploading a syllabus silently deactivated the pacing guide.

   A standalone file (not defined inline in ClassPage.jsx, where this used to
   live) so AddDocumentDialog can render the exact same upload flow from the
   composer without pulling ClassPage's own page-level code (FrameworkPicker,
   SchoolSelect, its framer-motion animations) into whatever bundle imports
   it. */
export function ClassDocuments({ cls, onChanged, onKindChange, variant = 'default' }) {
  const onboarding = variant === 'onboarding'
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
  const [supportingOpen, setSupportingOpen] = useState(false)
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
  const pacingGuides = rows.filter((doc) => doc.kind === 'pacing_guide')
  const supportingDocs = rows.filter((doc) => doc.kind !== 'pacing_guide')

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
      {onboarding && !docs.isLoading && !docs.isError ? (
        <OnboardingMaterialsFlow
          cls={cls}
          pacingGuides={pacingGuides}
          supportingDocs={supportingDocs}
          removingIds={removingIds}
          onRemove={removeDoc}
          fileRef={fileRef}
          uploading={uploading}
          upload={upload}
          kind={kind}
          setKind={setKind}
          linkOpen={linkOpen}
          setLinkOpen={setLinkOpen}
          submitLink={submitLink}
          supportingOpen={supportingOpen}
          setSupportingOpen={setSupportingOpen}
        />
      ) : rows.length ? (
        <div className="space-y-4">
          <section className="rounded-xl border border-accent/25 bg-accent/5 p-4" aria-labelledby={`pacing-guide-${cls.id}`}>
            <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
              <div>
                <p className="eyebrow text-accent">Featured source</p>
                <h4 id={`pacing-guide-${cls.id}`} className="mt-1 text-sm font-semibold text-ink">Pacing guide</h4>
                <p className="mt-1 text-xs text-ink-muted">The primary roadmap FlexEd uses to place lessons in the right week.</p>
              </div>
              <span className={`shrink-0 text-xs font-semibold ${pacingGuides.length ? 'text-ok' : 'text-flag'}`}>
                {pacingGuides.length ? 'Ready for plans' : 'Not added yet'}
              </span>
            </div>
            {pacingGuides.length ? (
              <ul className="neo-inset mt-4 divide-y divide-edge overflow-hidden rounded-lg bg-paper-sunken">
                {pacingGuides.map((doc) => (
                  <DocumentRow key={doc.id} doc={doc} featured removing={removingIds.has(doc.id)} onRemove={removeDoc} />
                ))}
              </ul>
            ) : (
              <p className="mt-4 rounded-lg border border-dashed border-accent/30 bg-paper/40 px-3 py-3 text-xs text-ink-muted">
                Choose <span className="font-medium text-ink">Pacing guide</span> below, then upload the roadmap for this class.
              </p>
            )}
          </section>

          {supportingDocs.length ? (
            <section aria-labelledby={`supporting-docs-${cls.id}`}>
              <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                  <h4 id={`supporting-docs-${cls.id}`} className="text-sm font-semibold text-ink">Supporting documents</h4>
                  <p className="mt-0.5 text-xs text-ink-muted">Rubrics, syllabi, and other class context.</p>
                </div>
                <span className="text-xs text-ink-muted">{supportingDocs.length} {supportingDocs.length === 1 ? 'document' : 'documents'}</span>
              </div>
              <ul className="neo-inset divide-y divide-edge overflow-hidden rounded-lg bg-paper-sunken">
                {supportingDocs.map((doc) => (
                  <DocumentRow key={doc.id} doc={doc} removing={removingIds.has(doc.id)} onRemove={removeDoc} />
                ))}
              </ul>
            </section>
          ) : null}
        </div>
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

      {!onboarding ? (
        <AddMaterialsControls
          cls={cls}
          kind={kind}
          setKind={setKind}
          fileRef={fileRef}
          uploading={uploading}
          upload={upload}
          linkOpen={linkOpen}
          setLinkOpen={setLinkOpen}
          submitLink={submitLink}
        />
      ) : null}
    </div>
  )
}
