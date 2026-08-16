import { useEffect, useRef, useState } from 'react'
import { Check, Pencil } from 'lucide-react'
import { splitDecisions } from '../lib/decisionChecklist'

/* One row. Three states: still open (empty circle, informational only —
 * there's nothing to edit yet, the teacher just hasn't said it), settled
 * (checkmark, tappable if onRevise exists), or being edited right now
 * (a real input, not a modal — this is a short correction, not a form). */
function DecisionRow({ label, value, onRevise }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value || '')
  const inputRef = useRef(null)
  const settled = value != null

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  /* extract_decisions re-reads the WHOLE transcript on every turn, so
     several rows can settle (or get corrected) in one update — with no
     signal beyond that, the whole list just silently looked different from
     one moment to the next, which is exactly what made it easy to lose
     track of which decision just landed. fa-flash (already this app's one
     "what changed" animation — see base.css — used for a revised document
     cell) answers the same question here: briefly tint whichever row's
     VALUE actually changed, not just whether it's settled. Compared against
     the previous value rather than settled/not-settled so a correction to
     an already-settled item flashes too, not only a first-time answer. */
  const prevValue = useRef(value)
  const [justChanged, setJustChanged] = useState(false)
  useEffect(() => {
    if (value != null && value !== prevValue.current) setJustChanged(true)
    prevValue.current = value
  }, [value])

  const cancel = () => {
    setDraft(value || '')
    setEditing(false)
  }

  const save = () => {
    const next = draft.trim()
    setEditing(false)
    // Phrased as an instruction, not just restated as a fact — this goes
    // straight into the conversation the same way a spoken correction
    // would (see VoiceModePanel's onRevise), and "Skill focus: X" reads to
    // the model as ambiguous between a correction and just repeating it
    // back.
    if (next && next !== value) onRevise(label, next)
  }

  if (editing) {
    return (
      <li className="fa-card-drop neo-raised flex shrink-0 flex-col gap-2 rounded-2xl bg-paper-raised px-3.5 py-2.5 text-left">
        <span className="block text-2xs font-semibold uppercase tracking-wide text-ink-faint">{label}</span>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
            if (e.key === 'Escape') cancel()
          }}
          className="w-full border-none bg-transparent text-sm leading-snug text-ink outline-none"
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={save}
            className="neo-raised rounded-full bg-accent-tint px-3 py-1 text-xs font-medium text-accent-text transition-shadow"
          >
            Save
          </button>
          <button
            type="button"
            onClick={cancel}
            className="neo-raised rounded-full px-3 py-1 text-xs font-medium text-ink-soft transition-shadow"
          >
            Cancel
          </button>
        </div>
      </li>
    )
  }

  const inner = (
    <>
      {/* Inset once settled — the same "pressed into the card" mark
          QuestionCards uses for an answered question — raised and empty
          while still open, so a glance says which of these still need a
          word from the teacher. */}
      <span
        aria-hidden="true"
        className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full transition-shadow duration-300 ${
          settled ? 'neo-inset text-accent-text' : 'neo-raised text-ink-faint'
        }`}
      >
        {/* key={value}: remounts the icon on every settle AND every later
            correction (not just the first checkmark), so .fa-pop's
            "arriving with overshoot" spring replays each time — the same
            reasoning WeekStrip's own day-completion checkmark already uses
            (see its own comment), just keyed on the value instead of a
            remounted row, since this row's editing state has to survive
            the value changing underneath it. */}
        {settled ? <Check key={value} size={11} strokeWidth={3} className="fa-pop" /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-2xs font-semibold uppercase tracking-wide text-ink-faint">{label}</span>
        <span
          className={`block text-sm leading-snug transition-colors duration-300 ${
            settled ? 'text-ink' : 'italic text-ink-faint'
          }`}
        >
          {settled ? value : 'Not yet decided'}
        </span>
      </span>
      {settled && onRevise ? (
        <Pencil
          size={12}
          aria-hidden="true"
          className="mt-1 shrink-0 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100"
        />
      ) : null}
    </>
  )

  const clearFlash = (e) => {
    if (e.animationName === 'fa-flash') setJustChanged(false)
  }

  // Only a settled item with somewhere to send the correction is tappable —
  // an open slot has no value yet to edit, and DecisionStack's other caller
  // (the text chat's rail, ArtifactRail.jsx) passes no onRevise at all, so
  // it stays a plain read-only summary there.
  if (settled && onRevise) {
    return (
      <li
        className={`fa-card-drop neo-raised group flex shrink-0 rounded-2xl bg-paper-raised text-left ${justChanged ? 'fa-flash' : ''}`}
        onAnimationEnd={clearFlash}
      >
        <button
          type="button"
          onClick={() => {
            setDraft(value)
            setEditing(true)
          }}
          aria-label={`Change ${label}`}
          className="flex w-full items-start gap-2.5 px-3.5 py-2.5 text-left"
        >
          {inner}
        </button>
      </li>
    )
  }

  return (
    <li
      onAnimationEnd={clearFlash}
      className={`fa-card-drop flex shrink-0 items-start gap-2.5 rounded-2xl px-3.5 py-2.5 text-left ${
        settled ? 'neo-raised bg-paper-raised' : ''
      } ${justChanged ? 'fa-flash' : ''}`}
    >
      {inner}
    </li>
  )
}

/* What's been settled in the conversation so far (llm.extract_decisions),
 * plus the core checklist above it — the running plan, building itself in
 * front of the teacher, with an honest picture of what's left.
 *
 * A vertical column, not a fanned deck: a deck reads as "a pile of things"
 * and only its top card is legible, which is exactly wrong for the job.
 *
 * `onRevise(label, newValue)`, when given, is what makes a settled row
 * tappable — see VoiceModePanel, which wires it straight into the same
 * onUtterance a spoken correction would use, so tapping "Skill focus" and
 * typing a new one is just a typed version of saying it out loud.
 */
export function DecisionStack({ decisions, fill = true, onRevise }) {
  const endRef = useRef(null)
  // Keep the newest extra card in view as the column outgrows its container
  // — otherwise the one that just landed is the one you can't see. The four
  // checklist rows are always present, so this only matters once there's
  // overflow from extras.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [decisions.length])

  const { checklist, extra } = splitDecisions(decisions)

  return (
    /* fill: stretch to the column (voice mode's desktop dialog, where three
       equal-height panels read as one composed layout). Otherwise hug the
       cards and grow downward as they land — in a narrow column or on a
       phone, stretching this to full height leaves most of the display as
       one empty embossed slab. */
    <div
      className={`neo-panel flex min-h-0 w-full flex-col overflow-hidden rounded-[28px] bg-paper-raised p-4 ${
        fill ? 'h-full' : 'max-h-full'
      }`}
    >
      <p className="eyebrow shrink-0 pb-2">The plan so far</p>
      <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-0.5">
        {checklist.map((item) => (
          <DecisionRow key={item.key} label={item.label} value={item.value} onRevise={onRevise} />
        ))}
        {extra.map((item) => (
          <DecisionRow key={item.key} label={item.label} value={item.value} onRevise={onRevise} />
        ))}
        <li ref={endRef} aria-hidden="true" />
      </ul>
    </div>
  )
}
