import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../lib/api'

/* THE SIGNATURE ELEMENT — the grounding apparatus.

   A standard code is a citation, so it is set like one: mono, hairline-underlined,
   and it opens to show the verbatim standard text with its source document and
   page. A code the retrieval step never supplied is marked in claret with a
   reference mark (※), the way a critical edition flags a doubtful reading.

   This is the app's actual differentiator made visible. Everything else in the
   design stays quiet so this can carry the weight. */

// Families and shapes present in the corpus, plus the two (CLR, IKI) that
// KNOWN_GAPS.md says can never be grounded.
const CODE_RE =
  /(\d\.[A-C]|Grade\d{1,2}-\d{1,2}[a-c]?|R\d{1,2}|(?:TOD|ORG|KLA|SST|USG|PUN|CLR|IKI)\s?\d{3})/g

const cache = new Map()

function normalize(code) {
  return code.replace(/\s+/g, ' ').trim().toUpperCase()
}

function Popover({ code, anchorRef, onClose }) {
  const [record, setRecord] = useState(() => cache.get(normalize(code)))
  const [error, setError] = useState(null)
  const [pos, setPos] = useState(null)
  const popRef = useRef(null)

  useEffect(() => {
    const key = normalize(code)
    if (cache.has(key)) {
      setRecord(cache.get(key))
      return
    }
    let alive = true
    api
      .getStandard(code)
      .then((r) => {
        cache.set(key, r)
        if (alive) setRecord(r)
      })
      .catch((e) => alive && setError(e))
    return () => {
      alive = false
    }
  }, [code])

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (!anchor) return
    const r = anchor.getBoundingClientRect()
    const width = Math.min(340, window.innerWidth - 16)
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
    const below = r.bottom + 8
    const popH = popRef.current?.offsetHeight ?? 160
    const top = below + popH > window.innerHeight - 8 ? Math.max(8, r.top - popH - 8) : below
    setPos({ left, top })
  }, [anchorRef, record, error])

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    const onDocClick = (e) => {
      if (!popRef.current?.contains(e.target) && !anchorRef.current?.contains(e.target)) onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDocClick)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDocClick)
    }
  }, [onClose, anchorRef])

  return (
    <div
      ref={popRef}
      className="cite-pop"
      role="dialog"
      aria-label={`Standard ${code}`}
      style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}
    >
      <span className="cite-pop-code">{code}</span>
      {error ? (
        <p>
          Not in the standards corpus. {error.code === 'standard_not_found' ? 'Nothing in the ' : ''}
          source documents defines this code.
        </p>
      ) : !record ? (
        <p style={{ color: 'var(--ink-muted)' }}>Looking it up…</p>
      ) : (
        <>
          <p>{record.description}</p>
          {record.parent_text ? (
            <p style={{ marginTop: 'var(--sp-2)', color: 'var(--ink-muted)' }}>
              Part of {record.parent_code}: {record.parent_text}
            </p>
          ) : null}
          <div className="cite-pop-src">
            <code>{record.source_document}</code>
            {record.source_page_or_section ? ` · ${record.source_page_or_section}` : ''}
            {record.verbatim_ok ? ' · verified verbatim' : ''}
          </div>
        </>
      )}
    </div>
  )
}

function Cite({ code, grounded }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`cite${grounded ? '' : ' is-ungrounded'}`}
        aria-expanded={open}
        aria-label={
          grounded
            ? `Standard ${code} — show the source text`
            : `Standard ${code} — not among the standards retrieved for this plan`
        }
        onClick={() => setOpen((o) => !o)}
      >
        {code}
      </button>
      {open ? <Popover code={code} anchorRef={ref} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

/**
 * Renders text with every standard code turned into a citation.
 * `groundedCodes` is the set retrieval actually supplied; anything else is
 * flagged rather than quietly rendered as fact.
 */
export function CitedText({ text, groundedCodes }) {
  if (!text) return null
  const known = groundedCodes instanceof Set ? groundedCodes : new Set(groundedCodes || [])
  // No grounding info available (e.g. a stored plan) — don't cry wolf.
  const checking = known.size > 0

  const parts = String(text).split(CODE_RE)
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <Cite key={i} code={part} grounded={!checking || known.has(normalize(part))} />
        ) : (
          part
        )
      )}
    </>
  )
}
