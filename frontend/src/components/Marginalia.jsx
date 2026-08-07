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
  if (!warnings?.length) return null

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

  return (
    <aside className="marginalia" aria-label="Grounding notes">
      <span className="marginalia-title">
        {warnings.length} note{warnings.length === 1 ? '' : 's'} on grounding
      </span>
      <ul>
        {warnings.map((w, i) => (
          <li key={i}>{renderWarning(w)}</li>
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
