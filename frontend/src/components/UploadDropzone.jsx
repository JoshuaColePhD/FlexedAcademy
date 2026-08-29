import { useRef, useState } from 'react'
import { Link as LinkIcon, Loader2, Upload } from 'lucide-react'

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
}) {
  const fileRef = useRef(null)
  const [isDragging, setIsDragging] = useState(false)

  const handleFiles = (fileList) => {
    const file = fileList?.[0]
    if (file) onFile(file)
  }

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
      className={`relative mt-3 flex flex-col gap-2 rounded-lg border border-dashed p-2 transition-colors sm:flex-row sm:items-center ${
        isDragging ? 'border-accent bg-accent/5' : 'border-edge/60'
      }`}
    >
      {isDragging ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-paper-raised/90 backdrop-blur-sm">
          <p className="flex items-center gap-1.5 text-sm font-medium text-accent-text">
            <Upload size={14} aria-hidden="true" /> Drop to upload
          </p>
        </div>
      ) : null}
      {templateUpload ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-50/70 px-2.5 py-2 text-xs text-amber-900 sm:col-span-2">
          <p className="font-semibold">Upload the blank, reusable district form only.</p>
          <p className="mt-0.5">Keep labels, colors, tables, and formatting. Remove teacher/student names, dates, standards, activities, and completed weekday cells.</p>
          <label className="mt-2 flex cursor-pointer items-start gap-2 font-medium text-ink">
            <input type="checkbox" checked={blankTemplateAttested} onChange={(e) => onBlankTemplateAttestedChange?.(e.target.checked)} />
            <span>I confirm this is a blank reusable template, not a completed example or packet.</span>
          </label>
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={uploading || (templateUpload && !blankTemplateAttested)}
        className="neo-raised inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-paper-inset disabled:opacity-50"
      >
        {uploading ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Upload size={14} aria-hidden="true" />}
        {uploading ? 'Reading…' : selectedFileName || label}
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
      <span className="text-xs text-ink-subtle font-medium text-center sm:text-left">OR</span>
      <div className="relative flex-1">
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
          disabled={uploading || (templateUpload && !blankTemplateAttested)}
          className="w-full rounded-lg border border-edge bg-paper py-2 pl-7 pr-3 text-sm text-ink outline-none transition-colors focus:border-accent placeholder:text-ink-subtle disabled:opacity-50"
        />
      </div>
      {onUrlSubmit && url?.trim() ? (
        <button
          type="button"
          onClick={onUrlSubmit}
          disabled={uploading || (templateUpload && !blankTemplateAttested)}
          className="fa-press neo-raised rounded-lg bg-paper-raised px-3 py-2 text-sm font-medium text-ink hover:bg-paper-sunken disabled:cursor-not-allowed disabled:opacity-40"
        >
          Use link
        </button>
      ) : null}
    </div>
  )
}
