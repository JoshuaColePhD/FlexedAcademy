import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { PHONE, useMediaQuery } from '../hooks/useMediaQuery'
import { api } from '../lib/api'
import { codeRe, groundedSet, normalizeCode } from '../lib/codes'
import { errorParts, isNotFound } from '../lib/apiError'

/* THE SIGNATURE ELEMENT — the grounding apparatus.

   A standard code is a citation, so it is set like one: mono, hairline-underlined,
   and it opens to show the verbatim standard text with its source document and
   page. A code the retrieval step never supplied is marked in claret with a
   reference mark (※), the way a critical edition flags a doubtful reading.

   This is the app's actual differentiator made visible. Everything else in the
   design stays quiet so this can carry the weight. */

/* The code pattern moved to lib/codes.js — the grounding line in the chat
   message and the marginalia "which cell cites this?" lookup need the same
   recognition, and a second copy of that regex is how the screen and the
   backend audit would drift. */

const cache = new Map()

/* Only one popover open at a time. Every Cite owned its own `open` state, so
   clicking three codes left three popovers stacked over each other. */
let closeOpenPopover = null

const normalize = normalizeCode

function Popover({ code, anchorRef, onClose, popoverId }) {
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
    const controller = new AbortController()
    api
      .getStandard(code, { signal: controller.signal })
      .then((r) => {
        cache.set(key, r)
        setRecord(r)
      })
      .catch((e) => {
        if (e?.name !== 'AbortError') setError(e)
      })
    return () => controller.abort()
  }, [code])

  /* Below --md this is a bottom sheet, not a popover.
     A getBoundingClientRect-positioned card is fiddly on a phone and lands
     off-screen for a code near an edge — and standard text is long enough that
     a 340px card at the bottom of a 375px viewport has nowhere to go. Same
     fetch, same module-level cache, different presentation. */
  const isPhone = useMediaQuery(PHONE)

  useLayoutEffect(() => {
    if (isPhone) return
    const anchor = anchorRef.current
    if (!anchor) return
    const r = anchor.getBoundingClientRect()
    const width = Math.min(340, window.innerWidth - 16)
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
    const below = r.bottom + 8
    const popH = popRef.current?.offsetHeight ?? 160
    const top = below + popH > window.innerHeight - 8 ? Math.max(8, r.top - popH - 8) : below
    setPos({ left, top })
  }, [anchorRef, record, error, isPhone])

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
    /* Deliberately NOT role="dialog". It used to claim that while never being
       focused, trapped, or restoring focus — a dialog a screen reader is never
       moved into is worse than a plain disclosure. It holds no focusable content,
       so the trigger keeps focus and this is just the expanded region. */
    <div
      ref={popRef}
      id={popoverId}
      className={isPhone ? 'cite-sheet' : 'cite-pop'}
      style={isPhone ? undefined : pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}
    >
      <span className="cite-pop-code">{code}</span>
      {error ? (
        /* The old copy was assembled from a fragment and read
           "Not in the standards corpus. source documents defines this code." for
           any error other than a 404 — malformed, and it blamed the corpus for
           what was usually a dropped connection. */
        isNotFound(error) ? (
          <p>Not in the standards corpus — no source document we hold defines this code.</p>
        ) : (
          <p>
            Couldn’t look this up. {errorParts(error).message}
            {errorParts(error).hint ? (
              <>
                {' '}
                <span style={{ color: 'var(--ink-muted)' }}>{errorParts(error).hint}</span>
              </>
            ) : null}
          </p>
        )
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

let citeSeq = 0

export function Cite({ code, grounded }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const idRef = useRef(null)
  if (idRef.current === null) idRef.current = `cite-pop-${++citeSeq}`

  const close = () => {
    setOpen(false)
    if (closeOpenPopover === close) closeOpenPopover = null
    // Focus never left the trigger, but say so explicitly: an outside click can
    // move it, and the trigger is where the reader expects to be.
    ref.current?.focus?.({ preventScroll: true })
  }

  const toggle = (e) => {
    /* The cell around this is now click-to-tweak. A click on a citation means
       "show me the standard" and never "revise this cell", so it stops here. */
    e.stopPropagation()
    if (open) {
      close()
      return
    }
    closeOpenPopover?.()
    closeOpenPopover = close
    setOpen(true)
  }

  useEffect(() => () => {
    if (closeOpenPopover === close) closeOpenPopover = null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`cite${grounded ? '' : ' is-ungrounded'}`}
        aria-expanded={open}
        aria-controls={open ? idRef.current : undefined}
        aria-label={
          grounded
            ? `Standard ${code} — show the source text`
            : `Standard ${code} — not among the standards retrieved for this plan`
        }
        onClick={toggle}
      >
        {code}
      </button>
      {open ? (
        <Popover code={code} anchorRef={ref} onClose={close} popoverId={idRef.current} />
      ) : null}
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
  // Normalize BOTH sides. The backend stores retrieved ids upper-cased, but a
  // plan loaded from elsewhere may not be, and a case mismatch would falsely
  // brand a properly grounded code as invented — the worst possible direction for
  // this particular error to fail in.
  const known = groundedSet(groundedCodes)
  // No grounding info available (e.g. a stored plan) — don't cry wolf.
  const checking = known.size > 0

  const parts = String(text).split(codeRe())
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
