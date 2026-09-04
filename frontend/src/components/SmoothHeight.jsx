/* Animates a panel's height between whatever its content happens to be.
 *
 * Measuring in a layout effect, BEFORE paint, is the whole point: it keeps a
 * content swap from rendering one frame at the new height before the animation
 * has even started.
 *
 * This lived in OnboardingWizard.jsx, was exported from there, and was then
 * only ever imported by VoiceModePanel — so the wizard it was written for
 * snapped between step heights while the panel that borrowed it animated. Two
 * comments in that file disagreed about which way the copying had gone; there
 * is one copy now, in a file named after it, owned by neither caller.
 *
 * The onboarding wizard no longer uses it: its card is a fixed height with a
 * scrolling content area, which is what makes the flow read calm instead of
 * lurching a step at a time. The insight below still matters there and is
 * recorded on .onboarding-card in base.css — a flex child's explicit height is
 * only a BASIS, so a short viewport can squeeze it below the height you set
 * and clip whatever sits at the bottom.
 */
import { useLayoutEffect, useRef, useState } from 'react'

export function SmoothHeight({ children }) {
  const contentRef = useRef(null)
  const [height, setHeight] = useState(null)

  useLayoutEffect(() => {
    const el = contentRef.current
    if (!el) return undefined
    const measure = () => {
      const next = el.getBoundingClientRect().height
      setHeight((prev) => (prev !== null && Math.abs(prev - next) < 0.5 ? prev : next))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [children])

  return (
    <div
      style={{
        height: height === null ? 'auto' : `${height}px`,
        transition: 'height 260ms cubic-bezier(0.4, 0, 0.2, 1)',
        overflow: 'hidden',
        // See the header comment: an explicit height on a flex child is only a
        // basis, and the panel above this is a flex column with its own
        // overflow-y-auto and a shrinking max-height.
        flexShrink: 0,
      }}
    >
      <div ref={contentRef}>{children}</div>
    </div>
  )
}
