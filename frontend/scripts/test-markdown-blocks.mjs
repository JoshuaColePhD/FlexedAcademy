import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeMathDelimiters as norm } from '../src/lib/normalizeMath.js'
import { splitBlocks, closeOpenMarks } from '../src/lib/markdownBlocks.js'

test('math: OpenAI delimiters become the ones remark-math understands', () => {
  // The exact shape from the transcript that rendered as literal source.
  assert.match(norm('\\[ x=\\frac{-(-8)}{2(2)}=2 \\]'), /\n\$\$\nx=\\frac\{-\(-8\)\}\{2\(2\)\}=2\n\$\$\n/)
  assert.equal(norm('see \\(y=x^2\\) here'), 'see $$y=x^2$$ here')
  // Double-escaped forms some models emit.
  assert.equal(norm('\\\\(y=x^2\\\\)'), '$$y=x^2$$')
})

test('math: unbalanced and non-math are left alone', () => {
  // Mid-stream: the closer has not arrived. Rewriting here would swallow the
  // rest of the reply into one math node.
  assert.equal(norm('\\[ x = 1'), '\\[ x = 1')
  assert.equal(norm('\\( y'), '\\( y')
  // Why singleDollarTextMath is off and why this emits $$ rather than $.
  assert.equal(norm('supplies cost $5 and $12'), 'supplies cost $5 and $12')
  assert.equal(norm('no math here'), 'no math here')
})

test('math: code is never rewritten', () => {
  assert.equal(norm('`echo \\(x\\)` done'), '`echo \\(x\\)` done')
  const fenced = '```\ngrep \\(a\\) f\n```'
  assert.equal(norm(fenced), fenced)
})

test('blocks: a fence is never split, even unterminated', () => {
  const { stable, tail } = splitBlocks('intro\n\n```js\nconst a = 1\n\nconst b = 2\n```\n\nafter\n')
  assert.equal(stable[0], 'intro')
  assert.ok(stable.some((b) => b.includes('const a = 1') && b.includes('const b = 2')),
    'the blank line inside the fence must not create a boundary')
  assert.ok(!tail.includes('```') || tail.trim() === 'after' || tail === '')
})

test('blocks: a loose list stays one list', () => {
  const { stable } = splitBlocks('- a\n\n- b\n\nparagraph\n\nend\n')
  assert.ok(stable.some((b) => b.includes('- a') && b.includes('- b')),
    'splitting a loose list yields two <ul>s with different margins')
})

test('blocks: a table is never split from its continuation', () => {
  const { stable, tail } = splitBlocks('| a | b |\n|---|---|\n| 1 | 2 |\n\ntext\n\nmore\n')
  const table = [...stable, tail].find((b) => b.includes('| a | b |'))
  assert.ok(table.includes('|---|---|'), 'header and delimiter row must stay together')
})

test('blocks: emitted blocks are append-only as text streams in', () => {
  // The invariant StreamingMarkdown's index-keyed React.memo depends on. If a
  // stable block could change after being emitted, memoized blocks would go
  // stale and the transcript would silently render the wrong thing.
  const doc = [
    '## Monday',
    '',
    'Open with a **quick** check.',
    '',
    '- one',
    '',
    '- two',
    '',
    '| day | task |',
    '|---|---|',
    '| Mon | graph |',
    '',
    '```js',
    'const x = 1',
    '```',
    '',
    'Display math: \\[ x=\\frac{1}{2} \\]',
    '',
    'Done.',
  ].join('\n')

  const seen = []
  for (let i = 1; i <= doc.length; i++) {
    const { stable } = splitBlocks(doc.slice(0, i))
    stable.forEach((block, idx) => {
      if (seen[idx] === undefined) seen[idx] = block
      else assert.equal(block, seen[idx],
        `block ${idx} changed after being emitted (at ${i} chars)`)
    })
    assert.ok(stable.length >= seen.filter((s) => s !== undefined).length - 0,
      'blocks must never be withdrawn')
  }
  assert.ok(seen.length > 3, 'the fixture should actually produce several blocks')
})

test('marks: unterminated inline syntax is closed for the frame', () => {
  assert.equal(closeOpenMarks('a **bold'), 'a **bold**')
  assert.equal(closeOpenMarks('use `code'), 'use `code`')
  assert.equal(closeOpenMarks('an *ital'), 'an *ital*')
  assert.ok(closeOpenMarks('```js\nconst a = 1').endsWith('\n```'))
  // Balanced input is returned untouched.
  assert.equal(closeOpenMarks('a **bold** and `code`'), 'a **bold** and `code`')
  assert.equal(closeOpenMarks(''), '')
})

test('marks: a table with no delimiter row yet is held back', () => {
  // Otherwise the reader sees a paragraph of pipes that snaps into a table.
  assert.equal(closeOpenMarks('Here it is:\n\n| day | task |'), 'Here it is:\n')
  // Once the delimiter row arrives it renders.
  const complete = 'Here it is:\n\n| day | task |\n|---|---|'
  assert.equal(closeOpenMarks(complete), complete)
})

test('marks: $$ is never auto-closed', () => {
  // A wrong guess hands KaTeX a malformed expression instead of plain text.
  assert.equal(closeOpenMarks('math: $$x=\\frac{'), 'math: $$x=\\frac{')
})
