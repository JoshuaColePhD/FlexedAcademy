/* Grounding warnings as marginalia rather than a banner — the apparatus of a
   marked-up text, which is the register this whole app is working in. These are
   warnings, not errors: a plan with an ungrounded citation is still usable, the
   teacher just needs to know which line to check. */
export function Marginalia({ warnings }) {
  if (!warnings?.length) return null
  return (
    <aside className="marginalia" aria-label="Grounding notes">
      <span className="marginalia-title">
        {warnings.length} note{warnings.length === 1 ? '' : 's'} on grounding
      </span>
      <ul>
        {warnings.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
    </aside>
  )
}

/* The grounding seal.
 *
 * This is the most distinctive thing in the app and it was rendering as a
 * wrapped row of grey chips with the word "Grounded in" over it — which states
 * a fact without making the claim. The claim IS the product: these codes were
 * retrieved and quoted, not recalled by a model that is good at sounding
 * confident about standard numbers. So it says so, in one sentence, and then
 * shows its work. */
export function GroundingStrip({ grounding, framework }) {
  const codes = grounding?.codes || []
  if (!codes.length) return null
  const n = codes.length
  return (
    <div className="grounding-seal">
      <p className="grounding-claim">
        Every code below is quoted verbatim from{' '}
        <strong>{framework || 'the Alabama Course of Study'}</strong> — {n} standard
        {n === 1 ? '' : 's'} retrieved for this week.
      </p>
      <div className="grounding-strip">
        {codes.map((c) => (
          <code className="cite" key={c} style={{ cursor: 'default' }}>
            {c}
          </code>
        ))}
        {grounding.thin ? (
          <span className="tag is-warn">
            thin coverage — only {grounding.count} standard{grounding.count === 1 ? '' : 's'}
          </span>
        ) : null}
      </div>
    </div>
  )
}
