import { useEffect, useRef } from 'react'

/* Focus handling for the overlays, which had none: the artifact panel mounted
   without moving focus and returned it nowhere, and the citation popover declared
   role="dialog" while never being focused or trapped — which is worse than not
   claiming to be a dialog at all.

   `trap` is the interesting option. The artifact panel is a modal overlay below
   1180px but a docked column above it, sitting right beside a live composer.
   Trapping Tab in the docked case would lock the teacher out of the input they
   were about to type in, so there the hook only moves focus in and restores it
   on close. Same overlay, two correct behaviours. */

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function tabbable(container) {
  if (!container) return []
  return Array.from(container.querySelectorAll(FOCUSABLE)).filter(
    // offsetParent is null for display:none subtrees; also skip inert ones.
    (el) => el.offsetParent !== null && !el.closest('[inert]')
  )
}

/**
 * @param {{current: HTMLElement|null}} containerRef
 * @param {{
 *   active?: boolean,
 *   trap?: boolean,
 *   onEscape?: () => void,
 *   initialFocus?: {current: HTMLElement|null},
 *   restoreFocus?: boolean,
 * }} [opts]
 */
export function useFocusTrap(
  containerRef,
  { active = true, trap = true, onEscape, initialFocus, restoreFocus = true } = {}
) {
  const onEscapeRef = useRef(onEscape)
  onEscapeRef.current = onEscape

  /* Focus-in and restore, keyed on `active` ALONE. This used to also depend
     on `trap` and `restoreFocus`, sharing one effect with the keydown
     listener below — so the artifact panel's overlay/docked switch on resize
     (which flips `trap`, not `active`) tore this effect down and reran it: it
     captured a fresh `document.activeElement` (wherever the teacher's focus
     actually was — e.g. a cell-tweak input) and immediately yanked focus away
     from it to the first tabbable element. An activation should move focus in
     exactly once; anything after that is the teacher's to control until this
     closes. */
  useEffect(() => {
    const container = containerRef.current
    if (!active || !container) return undefined

    const previous = document.activeElement
    const target = initialFocus?.current || tabbable(container)[0] || container
    // Needs tabIndex={-1} on the container for the last fallback to take.
    target?.focus?.({ preventScroll: true })

    return () => {
      if (restoreFocus && previous instanceof HTMLElement && document.contains(previous)) {
        previous.focus({ preventScroll: true })
      }
    }
    // restoreFocus intentionally excluded — it's a fixed choice per caller,
    // not something that should re-run the focus-in step if it ever changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  useEffect(() => {
    const container = containerRef.current
    if (!active || !container) return undefined

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        // Let the innermost handler win — a revise box inside the panel has its
        // own Escape, and this listener is scoped to the container rather than
        // the document precisely so it doesn't steal that.
        if (!e.defaultPrevented) {
          e.stopPropagation()
          onEscapeRef.current?.()
        }
        return
      }
      if (!trap || e.key !== 'Tab') return
      const items = tabbable(container)
      if (!items.length) {
        e.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    container.addEventListener('keydown', onKeyDown)
    return () => container.removeEventListener('keydown', onKeyDown)
    // containerRef is a ref object — stable identity, safe to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, trap])
}
