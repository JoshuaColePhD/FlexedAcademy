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

export function GroundingStrip({ grounding }) {
  if (!grounding?.codes?.length) return null
  return (
    <div className="grounding-strip">
      <span className="eyebrow">Grounded in</span>
      {grounding.codes.map((c) => (
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
  )
}
