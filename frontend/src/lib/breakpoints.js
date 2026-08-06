/* The ONLY place a breakpoint number is written.
 *
 * tailwind.config.js imports `screens` from here; useMediaQuery imports the
 * helpers. They cannot drift — which is the bug that ate the artifact-panel
 * overlay. useMediaQuery.js used to say "both of these are duplicated in
 * components.css… keep them in step"; components.css was then deleted, the JS
 * kept trapping focus, and the CSS that was supposed to actually cover the page
 * went with it. Two copies of a number is one copy too many.
 *
 * Deliberately NOT in tokens.css: a media query cannot read a custom property,
 * so a token there would be a value nothing could use — a lie in the one file
 * that is supposed to be the source of truth.
 *
 * The numbers themselves come from the layout, not from a framework default:
 *   lg 1024 — the sidebar (264) plus one --measure (46rem = 736) plus gutters is
 *             ~1040. The old 900 docked the sidebar and then immediately
 *             squeezed the measure the whole surface was designed around.
 *   xl 1280 — --measure (736) plus --artifact-w (480) is 1216 before any gutter.
 *             The old 1180 was under that.
 */
export const BP = {
  sm: 480, // large phone
  md: 768, // tablet portrait — the review/author line
  lg: 1024, // the sidebar can dock
  xl: 1280, // the artifact can dock beside the plan
  '2xl': 1536,
}

/** Tailwind's `theme.screens`. Replaces the defaults rather than extending them. */
export const screens = Object.fromEntries(
  Object.entries(BP).map(([k, v]) => [k, `${v}px`])
)

/* 0.02px, not 1px: browsers report fractional widths, and a device at exactly
   1023.5px would otherwise match neither below('lg') nor atLeast('lg'). */
export const below = (k) => `(max-width: ${BP[k] - 0.02}px)`
export const atLeast = (k) => `(min-width: ${BP[k]}px)`
export const between = (a, b) => `${atLeast(a)} and ${below(b)}`

/** A touch device, regardless of width — an iPad in landscape is 1024px wide and
 *  still has no hover. Size decides layout; this decides affordances. */
export const COARSE = '(hover: none) and (pointer: coarse)'
