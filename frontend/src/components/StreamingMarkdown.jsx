import { useDeferredValue, useMemo } from 'react'
import { MarkdownBlock } from './Markdown'
import { splitBlocks, closeOpenMarks } from '../lib/markdownBlocks'

/** Render markdown progressively, the way ChatGPT and Claude do.
 *
 * This replaces both halves of the old arrangement, where a streaming reply was
 * pre-wrapped plain text that snapped into formatting at settle. Rendering the
 * same component before and after settle means the DOM is identical across that
 * boundary, so the snap does not shrink — it disappears.
 *
 * Settled blocks are memoized and keyed by index, which is safe only because
 * splitBlocks is append-only (see the invariant test in
 * scripts/test-markdown-blocks.mjs). Only the last, still-growing block is
 * re-parsed, and useDeferredValue keeps even that interruptible so a scroll, a
 * keystroke, or the Stop button never waits behind a parse.
 */
export function StreamingMarkdown({ text }) {
  const deferred = useDeferredValue(text || '')
  const { stable, tail } = useMemo(() => splitBlocks(deferred), [deferred])
  const shown = useMemo(() => closeOpenMarks(tail), [tail])
  return (
    <>
      {stable.map((block, i) => (
        // eslint-disable-next-line react/no-array-index-key -- blocks are append-only
        <MarkdownBlock key={i} text={block} />
      ))}
      {shown ? <MarkdownBlock text={shown} /> : null}
    </>
  )
}

export default StreamingMarkdown
