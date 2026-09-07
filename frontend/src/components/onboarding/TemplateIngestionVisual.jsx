import { Check, FileText, Sparkles } from 'lucide-react'
import './template-ingestion.css'

// An illustration of structure, never a fabricated preview of the uploaded file.
// The scan is indeterminate: only the API response advances the actual steps.
export function TemplateIngestionVisual({ processing = false }) {
  return (
    <div className="template-reading-art" data-processing={processing} aria-hidden="true">
      <div className="template-reading-orbit" />
      <div className="template-reading-paper">
        <FileText size={22} />
        <span /><span /><span /><span />
        {processing ? <div className="template-reading-scan" /> : null}
      </div>
      <div className="template-reading-spark"><Sparkles size={22} /></div>
    </div>
  )
}

export function TemplateSectionList({ sections }) {
  return (
    <ol className="template-section-list" aria-label="Detected sections in order">
      {sections.map((section, index) => (
        <li key={`${section.name || section.title || 'section'}-${index}`} style={{ animationDelay: `${Math.min(index * 70, 420)}ms` }}>
          <span className="template-section-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
          <span>{section.name || section.title || `Section ${index + 1}`}</span>
          <Check size={16} aria-hidden="true" />
        </li>
      ))}
    </ol>
  )
}
