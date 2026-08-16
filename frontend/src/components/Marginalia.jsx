import { useEffect, useState } from 'react'
import { codeRe } from '../lib/codes'
import { locateCode } from '../lib/grounding'

/* Grounding warnings as marginalia rather than a banner — the apparatus of a
   marked-up text, which is the register this whole app is working in. These are
   warnings, not errors: a plan with an ungrounded citation is still usable, the
   teacher just needs to know which line to check.

   What changed: the codes inside a warning used to be plain text, so the note
   told you a cell was wrong and then left you to find it. Each one is now a
   button that opens the inline tweak on the cell that cites it. That is the
   one-click path from "you were warned" to "fixed", and it is the only reason
   this component knows about the plan at all. */
export function Marginalia({ warnings, plan, retrievedCodes, onFixCitation }) {
  /* A fixed warning used to just vanish the instant the revised plan came
     back — the array shrank, React reconciled, the row was gone before the
     eye caught up. Every other list in the app (a deleted plan, a chat) plays
     fa-row-exit for the identical "the list closes ranks" moment; keeping a
     local copy is what gives a removed warning somewhere to linger while
     that plays, since `warnings` itself is server state that just stops
     containing it. Matched by text, not index — the same key the render
     below already used, and there's no id a warning string carries. */
  const [rows, setRows] = useState(() => (warnings || []).map((w) => ({ text: w, removing: false })))

  useEffect(() => {
    setRows((prev) => {
      const next = warnings || []
      const nextSet = new Set(next)
      const prevTexts = new Set(prev.map((r) => r.text))
      const kept = prev
        .filter((r) => nextSet.has(r.text) || r.removing)
        .map((r) => (nextSet.has(r.text) ? r : { ...r, removing: true }))
      const added = next.filter((w) => !prevTexts.has(w)).map((w) => ({ text: w, removing: false }))
      return [...kept, ...added]
    })
  }, [warnings])

  // Drops a row for good once its exit animation has had time to play.
  useEffect(() => {
    const leaving = rows.filter((r) => r.removing)
    if (!leaving.length) return undefined
    const timers = leaving.map((r) =>
      setTimeout(() => {
        setRows((cur) => cur.filter((x) => x.text !== r.text))
      }, 200)
    )
    return () => timers.forEach(clearTimeout)
  }, [rows])

  if (!rows.length) return null

  const renderWarning = (text) => {
    if (!onFixCitation || !plan) return text
    // Split on the code pattern; odd indices are the codes themselves.
    const parts = String(text).split(codeRe())
    return parts.map((part, i) => {
      if (i % 2 === 0) return part
      const at = locateCode(plan, retrievedCodes, part)
      if (!at) return part
      return (
        <button
          key={i}
          type="button"
          className="marginalia-fix cite is-ungrounded"
          onClick={() => onFixCitation({ dayIndex: at.dayIndex, field: at.field })}
          aria-label={`${part} was not retrieved — revise ${at.dayName}’s ${
            at.field === 'act_alignment' ? 'ACT alignment' : 'standards'
          }`}
        >
          {part}
        </button>
      )
    })
  }

  const activeCount = rows.filter((r) => !r.removing).length

  return (
    <aside className="marginalia" aria-label="Grounding notes">
      <span className="marginalia-title">
        {activeCount} note{activeCount === 1 ? '' : 's'} on grounding
      </span>
      <ul>
        {rows.map((r) => (
          <li key={r.text} className={r.removing ? 'fa-row-exit' : undefined}>
            {renderWarning(r.text)}
          </li>
        ))}
      </ul>
    </aside>
  )
}

/* GroundingStrip lived here — the claim ("every code below is quoted verbatim
   from X") over a row of citations, rendered inside the document panel.
   It is gone because the panel it lived in is closed by default now, and a
   grounding seal nobody opens proves nothing. The claim moved into the chat
   message as a one-line strip, where it is seen: see the `.grounding-line` in
   Message.jsx. Its one signal without another home — thin coverage — went with
   it rather than being dropped. */
