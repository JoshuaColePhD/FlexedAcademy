import { useEffect, useRef, useState } from 'react'
import { ChevronDown, FileText, Link as LinkIcon, Loader2, Upload } from 'lucide-react'

const formatFileSize = (bytes) => {
  if (!bytes) return ''
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const fileExtension = (name = '') => name.split('.').pop()?.toUpperCase() || 'FILE'

const fileTypeLabel = (file) => {
  const extension = fileExtension(file?.name)
  if (extension === 'PDF') return 'PDF document'
  if (extension === 'DOCX') return 'Word document'
  return `${extension} file`
}

/* Drag-and-drop file picker + paste-a-link fallback, shared by every place a
 * teacher hands over a school-level file (a district's lesson-plan template,
 * a school calendar) rather than a class's own document. ClassDocuments.jsx
 * already had drag-and-drop for a class's pacing guide/syllabus; this is the
 * same drop interaction, factored out so the school-level uploads (Settings'
 * SchoolPicker, OnboardingWizard's SchoolStep) get it too instead of staying
 * click-only.
 *
 * A pure picker: `onFile(file)` fires the same way on a click-to-browse pick
 * and on a drop, and the caller decides what happens next — upload the
 * instant a file lands (Settings) or just stage it in state until a
 * "Continue" button submits it (OnboardingWizard). `onUrlSubmit` is optional:
 * omit it where pasting a link only needs to update state, not a separate
 * submit action (OnboardingWizard's own Continue button covers that there).
 */
export function UploadDropzone({
  accept = '.pdf,.docx',
  uploading,
  label,
  selectedFileName,
  onFile,
  url,
  onUrlChange,
  onUrlSubmit,
  templateUpload = false,
  blankTemplateAttested = false,
  onBlankTemplateAttestedChange,
  uploadStatus = 'idle',
  compactGuidance = false,
  className = '',
}) {
  const fileRef = useRef(null)
  const [isDragging, setIsDragging] = useState(false)
  const [selectedFile, setSelectedFile] = useState(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [linkOpen, setLinkOpen] = useState(Boolean(url?.trim()))
  const [guidanceOpen, setGuidanceOpen] = useState(!compactGuidance && !blankTemplateAttested)

  useEffect(() => {
    if (!selectedFile || selectedFile.type !== 'application/pdf') {
      setPreviewUrl('')
      return undefined
    }

    const objectUrl = URL.createObjectURL(selectedFile)
    setPreviewUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [selectedFile])

  useEffect(() => {
    if (url?.trim()) setLinkOpen(true)
  }, [url])

  useEffect(() => {
    if (!blankTemplateAttested && !compactGuidance) setGuidanceOpen(true)
  }, [blankTemplateAttested, compactGuidance])

  const handleFiles = (fileList) => {
    const file = fileList?.[0]
    if (file) {
      setSelectedFile(file)
      onFile(file)
    }
  }

  const selectedName = selectedFile?.name || selectedFileName
  const statusMeta = {
    processing: { label: 'Processing', className: 'bg-sky-500/10 text-sky-700' },
    ready: { label: 'Ready', className: 'bg-emerald-500/10 text-emerald-700' },
    needs_review: { label: 'Needs review', className: 'bg-amber-500/10 text-amber-700' },
  }[uploadStatus]

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setIsDragging(true)
      }}
      onDragLeave={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setIsDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setIsDragging(false)
        handleFiles(e.dataTransfer.files)
      }}
      className={`relative mt-3 flex flex-col gap-2 rounded-lg border border-dashed p-2 transition-colors ${templateUpload ? 'items-stretch' : 'sm:flex-row sm:items-center'} ${
        isDragging ? 'border-accent bg-accent/5' : 'border-edge/60'
      } ${className}`}
    >
      {isDragging ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-paper-raised/90 backdrop-blur-sm">
          <p className="flex items-center gap-1.5 text-sm font-medium text-accent-text">
            <Upload size={14} aria-hidden="true" /> Drop to upload
          </p>
        </div>
      ) : null}
      {templateUpload ? (
        <div className={`rounded-lg border px-3 py-2 text-xs ${blankTemplateAttested ? 'border-ok/20 bg-ok/5' : 'border-amber-500/25 bg-amber-50/70'}`}>
          <button
            type="button"
            aria-expanded={guidanceOpen}
            onClick={() => setGuidanceOpen((open) => !open)}
            className="flex w-full items-center justify-between gap-2 text-left"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="font-semibold text-ink">Before you upload</span>
              <span className={`rounded-full px-1.5 py-0.5 text-2xs font-medium ${blankTemplateAttested ? 'bg-ok/10 text-ok' : 'bg-amber-500/10 text-amber-800'}`}>
                {blankTemplateAttested ? 'Confirmed' : 'Required'}
              </span>
            </span>
            <ChevronDown size={14} aria-hidden="true" className={`shrink-0 text-ink-muted transition-transform ${guidanceOpen ? 'rotate-180' : ''}`} />
          </button>
          {guidanceOpen ? (
            <div className="mt-2 border-t border-amber-500/15 pt-2 text-amber-900/80">
              <p>Remove names, dates, standards, activities, and completed cells. Keep the blank layout, labels, colors, tables, and formatting.</p>
              <label className="mt-2 flex cursor-pointer items-start gap-2 font-medium text-ink">
                <input
                  type="checkbox"
                  checked={blankTemplateAttested}
                  onChange={(e) => {
                    onBlankTemplateAttestedChange?.(e.target.checked)
                    if (e.target.checked) setGuidanceOpen(false)
                  }}
                />
                <span>I confirm this is a blank reusable format.</span>
              </label>
            </div>
          ) : null}
        </div>
      ) : null}
      {templateUpload && !selectedName ? (
        <div className="flex items-center gap-2 rounded-lg bg-paper-sunken px-3 py-2 text-xs text-ink-muted">
          <Upload size={14} className="shrink-0 text-accent-text" aria-hidden="true" />
          <span className="font-medium text-ink">Drop your format here</span>
          <span>or choose a PDF or Word file below</span>
        </div>
      ) : null}
      {templateUpload && selectedName ? (
        <div className="flex min-w-0 items-center gap-3 rounded-xl border border-edge/70 bg-paper-raised px-3 py-2.5">
          <div className="relative grid h-16 w-14 shrink-0 place-items-center overflow-hidden rounded-lg border border-edge/70 bg-paper-sunken">
            {previewUrl ? (
              <iframe title={`${selectedName} preview`} src={previewUrl} className="pointer-events-none h-20 w-16 border-0" />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-gradient-to-b from-paper to-paper-sunken text-accent-text">
                <FileText size={20} aria-hidden="true" />
                <span className="text-[9px] font-semibold tracking-wide">{fileExtension(selectedName)}</span>
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-ink">{selectedName}</p>
            <p className="mt-0.5 text-2xs text-ink-muted">
              {selectedFile ? `${fileTypeLabel(selectedFile)}${formatFileSize(selectedFile.size) ? ` · ${formatFileSize(selectedFile.size)}` : ''}` : 'Selected format'}
              {uploading ? ' · Reading…' : uploadStatus === 'processing' ? ' · Being analyzed' : ' · Ready to replace'}
            </p>
          </div>
          {statusMeta ? <span className={`hidden shrink-0 rounded-full px-2 py-1 text-2xs font-medium sm:inline-flex ${statusMeta.className}`}>{statusMeta.label}</span> : null}
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading || !blankTemplateAttested}
            className="btn shrink-0 text-2xs disabled:cursor-not-allowed disabled:opacity-50"
          >
            Replace
          </button>
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading || (templateUpload && !blankTemplateAttested)}
          className="neo-raised inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold text-ink transition-colors hover:bg-paper-inset disabled:opacity-50"
        >
          {uploading ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Upload size={14} aria-hidden="true" />}
          {uploading ? 'Reading…' : templateUpload && selectedName ? 'Replace file' : label}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files)
            e.target.value = ''
          }}
        />
        {templateUpload ? (
          <>
            <button
              type="button"
              onClick={() => setLinkOpen((open) => !open)}
              disabled={uploading || !blankTemplateAttested}
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium text-ink-muted transition-colors hover:bg-paper-sunken hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              <LinkIcon size={13} aria-hidden="true" />
              {linkOpen ? 'Hide Google Doc link' : 'Use a Google Doc link'}
            </button>
            {statusMeta ? <span className={`ml-auto inline-flex rounded-full px-2 py-1 text-2xs font-medium sm:hidden ${statusMeta.className}`}>{statusMeta.label}</span> : null}
          </>
        ) : (
          <>
            <span className="text-xs font-medium text-ink-subtle">OR</span>
            <div className="relative min-w-[12rem] flex-1">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-2.5">
                <LinkIcon size={13} className="text-ink-subtle" aria-hidden="true" />
              </div>
              <input
                type="url"
                placeholder="Paste Google Doc link"
                value={url}
                onChange={(e) => onUrlChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && url?.trim() && onUrlSubmit) {
                    e.preventDefault()
                    onUrlSubmit()
                  }
                }}
                disabled={uploading}
                className="w-full rounded-lg border border-edge bg-paper py-2 pl-7 pr-3 text-sm text-ink outline-none transition-colors focus:border-accent placeholder:text-ink-subtle disabled:opacity-50"
              />
            </div>
            {onUrlSubmit && url?.trim() ? (
              <button
                type="button"
                onClick={onUrlSubmit}
                disabled={uploading}
                className="fa-press neo-raised rounded-lg bg-paper-raised px-3 py-2 text-sm font-medium text-ink hover:bg-paper-sunken disabled:cursor-not-allowed disabled:opacity-40"
              >
                Use link
              </button>
            ) : null}
          </>
        )}
      </div>
      {templateUpload && linkOpen ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-edge/60 pt-2">
          <div className="relative min-w-[12rem] flex-1">
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-2.5">
              <LinkIcon size={13} className="text-ink-subtle" aria-hidden="true" />
            </div>
            <input
              type="url"
              placeholder="Paste a shareable Google Doc link"
              value={url}
              onChange={(e) => {
                onUrlChange(e.target.value)
                if (e.target.value) setSelectedFile(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && url?.trim() && onUrlSubmit) {
                  e.preventDefault()
                  onUrlSubmit()
                }
              }}
              disabled={uploading || !blankTemplateAttested}
              className="w-full rounded-lg border border-edge bg-paper py-2 pl-7 pr-3 text-sm text-ink outline-none transition-colors focus:border-accent placeholder:text-ink-subtle disabled:opacity-50"
            />
          </div>
          {onUrlSubmit ? (
            <button
              type="button"
              onClick={onUrlSubmit}
              disabled={uploading || !blankTemplateAttested || !url?.trim()}
              className="fa-press neo-raised rounded-lg bg-paper-raised px-3 py-2 text-sm font-medium text-ink hover:bg-paper-sunken disabled:cursor-not-allowed disabled:opacity-40"
            >
              Use link
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
