import { useEffect, useRef } from 'react'
import { Check } from 'lucide-react'

/* What's been settled in the conversation so far (llm.extract_decisions) —
 * the running plan, building itself in front of the teacher.
 *
 * A vertical column, not a fanned deck: a deck reads as "a pile of things"
 * and only its top card is legible, which is exactly wrong for the job.
 * These are the durable decisions the week is being built from, and all of
 * them need to stay readable at once — so each new one drops in UNDER the
 * last, the column grows downward as the conversation goes, and the whole
 * set reads top to bottom like the outline it is. Newest at the bottom, in
 * the order they were decided, because that is the order the teacher said
 * them.
 *
 * Originally voice mode's own component; shared now with the normal text
 * chat (ChatPage.jsx), which used to have no equivalent at all — a teacher
 * typing never saw what had actually been settled, only voice mode did.
 */
export function DecisionStack({ decisions, fill = true }) {
  const endRef = useRef(null)
  // Keep the newest card in view as the column outgrows its container —
  // otherwise the one that just landed is the one you can't see.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [decisions.length])

  return (
    /* fill: stretch to the column (voice mode's desktop dialog, where three
       equal-height panels read as one composed layout). Otherwise hug the
       cards and grow downward as they land — in a narrow column or on a
       phone, stretching this to full height around three cards leaves most
       of the display as one empty embossed slab. */
    <div
      className={`neo-panel flex min-h-0 w-full flex-col overflow-hidden rounded-[28px] bg-paper-raised p-4 ${
        fill ? 'h-full' : 'max-h-full'
      }`}
    >
      <p className="eyebrow shrink-0 pb-2">The plan so far</p>
      {decisions.length ? (
        <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-0.5">
          {decisions.map((d, i) => (
            <li
              key={`${d.label}:${i}`}
              className="fa-card-drop neo-raised flex shrink-0 items-start gap-2.5 rounded-2xl bg-paper-raised px-3.5 py-2.5 text-left"
            >
              {/* Inset, not raised — a completed mark, something already
                  pressed into the card rather than another thing to tap. */}
              <span
                aria-hidden="true"
                className="neo-inset mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-accent-text"
              >
                <Check size={11} strokeWidth={3} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-2xs font-semibold uppercase tracking-wide text-ink-faint">
                  {d.label}
                </span>
                <span className="block text-sm leading-snug text-ink">{d.value}</span>
              </span>
            </li>
          ))}
          <li ref={endRef} aria-hidden="true" />
        </ul>
      ) : (
        <p className="text-xs leading-relaxed text-ink-muted">
          As you settle things — the week, the text, what they’ll be graded on — they’ll stack up
          here.
        </p>
      )}
    </div>
  )
}
