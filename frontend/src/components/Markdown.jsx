import { lazy, memo, Suspense } from 'react'

const Renderer = lazy(() => import('./MarkdownRenderer'))
// Preserve readable streamed content while the renderer loads. Public/auth
// routes no longer preload Markdown and math just because the shell exists.
export const MarkdownBlock = memo(function MarkdownBlock({ text }) {
  return <Suspense fallback={<span style={{ whiteSpace: 'pre-wrap' }}>{text}</span>}><Renderer text={text || ''} /></Suspense>
})
export function Markdown({ text }) { return <MarkdownBlock text={text} /> }
export default Markdown
