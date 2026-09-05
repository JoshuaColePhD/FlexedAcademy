import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { PHONE, useMediaQuery } from '../hooks/useMediaQuery'
import { codeRe, groundedSet, normalizeCode } from '../lib/codes'
import { errorParts, isNotFound } from '../lib/apiError'
import { fetchStandard, getCached } from '../lib/standardsCache'

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

/* Only one popover open at a time. Every Cite owned its own `open` state, so
   clicking three codes left three popovers stacked over each other. */
let closeOpenPopover = null

const normalize = normalizeCode

function Popover({ code, subject, state, anchorRef, onClose, popoverId }) {
  // The lookup and its cache both live in lib/standardsCache.js now, shared
  // with the rail's Standards panel — see that module for why `subject` (and
  // now `state`) is part of the cache key, not just the request. Omitting
  // `state` would fall back to Alabama server-side (backend/retrieval.py's
  // chunk_for_code default) regardless of the class's own state — exactly
  // the cross-state leak a Georgia teacher's own cited code must never hit.
  const [record, setRecord] = useState(() => getCached(code, subject, state))
  const [error, setError] = useState(null)
  const [pos, setPos] = useState(null)
  const popRef = useRef(null)

  useEffect(() => {
    const cached = getCached(code, subject, state)
    if (cached !== undefined) {
      setRecord(cached)
      return
    }
    const controller = new AbortController()
    fetchStandard(code, { subject, state, signal: controller.signal })
      .then(setRecord)
      .catch((e) => {
        if (e?.name !== 'AbortError') setError(e)
      })
    return () => controller.abort()
  }, [code, subject, state])

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

  /* Portaled straight to <body>. `position: fixed` only measures against the
     viewport when nothing in its ancestor chain runs a transform — and Message
     wraps every bubble in `.fa-rise`, a transform-based entrance animation.
     Chrome keeps the compositing layer that animation creates even once it has
     finished (fill-mode: both), so a popover left in that subtree inherited a
     containing block hundreds of pixels off from the viewport instead of the
     anchor it was measured against. Escaping the subtree is the fix; trimming
     the animation would only move the bug to the next transform someone adds. */
  return createPortal(
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
        <div className="flex animate-pulse flex-col gap-2 mt-1">
          <div className="h-3.5 w-full rounded bg-paper-inset" />
          <div className="h-3.5 w-5/6 rounded bg-paper-inset" />
          <div className="mt-1 h-3 w-1/3 rounded bg-paper-inset" />
        </div>
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
    </div>,
    document.body
  )
}

let citeSeq = 0

export function Cite({ code, subject, state, grounded }) {
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
        <Popover code={code} subject={subject} state={state} anchorRef={ref} onClose={close} popoverId={idRef.current} />
      ) : null}
    </>
  )
}

/**
 * Renders text with every standard code turned into a citation.
 * `groundedCodes` is the set retrieval actually supplied; anything else is
 * flagged rather than quietly rendered as fact.
 */
export function CitedText({ text, groundedCodes, subject, state }) {
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
          <Cite key={i} code={part} subject={subject} state={state} grounded={!checking || known.has(normalize(part))} />
        ) : (
          part
        )
      )}
    </>
  )
}
