import { memo, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { ArrowUpRight, Check, Copy } from 'lucide-react'
import 'katex/dist/katex.min.css'
import { normalizeMathDelimiters } from '../lib/normalizeMath'
import { useCopy } from '../lib/useCopy'

/* Module-level constants, NOT inline literals.
 *
 * A fresh array on every render defeats react-markdown's internal memoization
 * and forces it to re-process even when the text is byte-identical. That would
 * silently undo the whole point of memoizing settled blocks in
 * StreamingMarkdown, so these must stay hoisted.
 *
 * singleDollarTextMath: false — a lesson plan says "supplies cost $5 and $12".
 * With single-dollar math on, "$5 and $" parses as math and the line renders as
 * garbage. This is why normalizeMathDelimiters emits $$, never $.
 *
 * throwOnError: false — required for streaming. A half-arrived \frac{ makes
 * KaTeX throw, and an uncaught throw during render takes out the transcript.
 * With this off it renders the raw source and self-heals on the next frame.
 *
 * trust defaults to false, which disables \href, \url and \includegraphics —
 * i.e. KaTeX's entire injection surface. It is stated here so nobody enables it.
 */
const REMARK_PLUGINS = [remarkGfm, [remarkMath, { singleDollarTextMath: false }]]
const REHYPE_PLUGINS = [[rehypeKatex, { throwOnError: false, strict: 'ignore', trust: false }]]

/* NO rehype-raw, ever, and therefore no rehype-sanitize either.
 *
 * react-markdown v10 does not render raw HTML unless rehype-raw is added, so
 * <script> in model output is escaped to text and there is no injection surface
 * to sanitize. urlTransform already strips javascript:, vbscript: and non-image
 * data: URLs by default — leave it at the default rather than passing a custom
 * one, which would have to re-implement that allowlist.
 *
 * If rehype-raw ever becomes necessary (say, HTML imported from an LMS), then
 * rehype-sanitize must be added WITH defaultSchema extended to allow className
 * on span/math/annotation and the katex* class prefix. Without that extension
 * sanitize strips every KaTeX span and math renders as unstyled character soup.
 */

function CodeBlock({ children }) {
  const { copied, copy } = useCopy()
  // The child is the <code> element; its text is what belongs on the clipboard.
  const text = useMemo(() => {
    const node = children?.props?.children
    return typeof node === 'string' ? node : Array.isArray(node) ? node.join('') : ''
  }, [children])
  return (
    <div className="msg-code">
      <button
        type="button"
        onClick={() => copy(text)}
        className="msg-code-copy"
        aria-label={copied ? 'Copied' : 'Copy code'}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
      <pre>{children}</pre>
    </div>
  )
}

/* Only the elements that need real behavior are overridden here. Everything
 * else — headings, lists, blockquote, hr, th/td, inline code — is styled by
 * descendant selectors under .msg-markdown in base.css, which keeps class names
 * out of JSX and keeps check:classes happy. */
const COMPONENTS = {
  a: ({ children, ...props }) => (
    <a {...props} target="_blank" rel="noreferrer noopener" className="msg-link">
      {children}
      <ArrowUpRight size={12} aria-hidden="true" />
    </a>
  ),
  // A five-column week table is wider than the 48rem assistant measure, so it
  // scrolls inside the column instead of forcing the whole transcript sideways.
  table: ({ children, ...props }) => (
    <div className="msg-table-wrap">
      <table {...props}>{children}</table>
    </div>
  ),
  pre: CodeBlock,
  // GFM task lists are a rendering of the reply, not a control.
  input: (props) => <input {...props} disabled readOnly />,
}

/** One markdown block. Memoized: a settled block never re-parses. */
export const MarkdownBlock = memo(function MarkdownBlock({ text }) {
  const source = useMemo(() => normalizeMathDelimiters(text), [text])
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      components={COMPONENTS}
    >
      {source}
    </ReactMarkdown>
  )
})

export function Markdown({ text }) {
  return <MarkdownBlock text={text || ''} />
}

export default Markdown
