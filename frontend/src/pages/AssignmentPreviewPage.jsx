import { Link, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  Lightbulb,
  ShieldCheck,
} from 'lucide-react'

const steps = [
  {
    title: 'Choose a public message',
    copy: 'Select a speech, editorial, advertisement, campaign post, podcast segment, or other short message with a clear audience and purpose.',
  },
  {
    title: 'Annotate the situation',
    copy: 'Mark details that reveal the rhetor, audience, purpose, context, and constraints. Note two choices the rhetor makes.',
  },
  {
    title: 'Write your snapshot',
    copy: 'In 350–500 words, explain how one rhetorical choice responds to the situation and shapes the message’s effect on its audience.',
  },
]

const successCriteria = [
  'Names the rhetorical situation precisely.',
  'Uses two specific details from the message as evidence.',
  'Explains the connection between a choice, the audience, and the purpose.',
  'Moves beyond summary to make a defensible claim about effect.',
  'Uses clear paragraphs and thoughtful transitions.',
]

const rubricRows = [
  ['Rhetorical situation', 'Identifies the rhetor, audience, purpose, context, and constraints with precision.'],
  ['Evidence and reasoning', 'Uses specific details and explains how a choice responds to the situation.'],
  ['Clarity and control', 'Presents a focused claim in organized, readable prose.'],
]

export function AssignmentPreviewPage() {
  const { classId } = useParams()
  const chatPath = `/c/${classId}/chat/seed1`

  return (
    <main className="flex h-full min-h-0 flex-col overflow-y-auto bg-paper">
      <header className="border-b border-edge/20 bg-paper/80 px-4 py-4 backdrop-blur sm:px-6">
        <div className="mx-auto flex max-w-screen-2xl items-center justify-between gap-4">
          <div className="min-w-0">
            <Link
              to={chatPath}
              className="mb-2 inline-flex min-h-touch items-center gap-1.5 text-xs font-semibold text-ink-muted transition-colors hover:text-accent"
            >
              <ArrowLeft size={14} aria-hidden="true" />
              Back to conversation
            </Link>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-accent/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-accent">
                Assignment preview
              </span>
              <span className="text-xs text-ink-muted">Student handout + teacher notes</span>
            </div>
          </div>
          <div className="hidden shrink-0 items-center gap-2 rounded-xl border border-edge/30 bg-paper-sunken/40 px-3 py-2 text-xs text-ink-muted sm:flex">
            <FileText size={15} aria-hidden="true" className="text-accent" />
            Draft artifact
          </div>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-screen-2xl flex-1 gap-4 p-4 sm:p-6 xl:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]">
        <article className="min-w-0 rounded-2xl border border-edge/30 bg-paper shadow-sm">
          <div className="border-b border-edge/20 bg-paper-sunken/30 p-5 sm:p-7">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <p className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-accent">AP Language &amp; Composition</p>
                <h1 className="max-w-3xl text-2xl font-bold tracking-tight text-ink sm:text-3xl">Rhetorical Situation Snapshot</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-muted sm:text-base">
                  Analyze how a real-world message responds to its rhetorical situation.
                </p>
              </div>
              <div className="hidden shrink-0 rounded-xl bg-accent/10 p-3 text-accent sm:block">
                <ClipboardCheck size={24} aria-hidden="true" />
              </div>
            </div>
            <div className="flex flex-wrap gap-2 text-xs font-medium text-ink-muted">
              <span className="rounded-full border border-edge/30 px-3 py-1.5">2 class periods</span>
              <span className="rounded-full border border-edge/30 px-3 py-1.5">350–500 words</span>
              <span className="rounded-full border border-edge/30 px-3 py-1.5">Individual work</span>
            </div>
          </div>

          <div className="space-y-8 p-5 sm:p-7">
            <section>
              <h2 className="text-base font-bold text-ink">Why you are doing this</h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-ink-soft">
                Strong rhetorical analysis begins with the situation around a message—not just the devices inside it. This snapshot helps you practice connecting a writer’s choices to a specific audience, purpose, and context.
              </p>
            </section>

            <section className="rounded-xl border border-accent/20 bg-accent/5 p-4 sm:p-5">
              <h2 className="flex items-center gap-2 text-base font-bold text-ink">
                <Lightbulb size={17} aria-hidden="true" className="text-accent" />
                Your target
              </h2>
              <p className="mt-2 text-sm font-medium leading-6 text-ink-soft">
                I can explain how a rhetorical choice responds to the situation and shapes a message’s effect on its audience.
              </p>
            </section>

            <section>
              <h2 className="text-base font-bold text-ink">The task</h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-ink-soft">
                Choose a short public message and write a rhetorical situation snapshot. Identify the situation, name one meaningful rhetorical choice, and explain how that choice serves the audience and purpose. Include two specific details from the message.
              </p>
            </section>

            <section>
              <h2 className="text-base font-bold text-ink">What to do</h2>
              <ol className="mt-3 space-y-3">
                {steps.map((step, index) => (
                  <li key={step.title} className="flex gap-3 rounded-xl border border-edge/20 bg-paper-sunken/25 p-4">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-bold text-white" aria-hidden="true">
                      {index + 1}
                    </span>
                    <div>
                      <h3 className="text-sm font-bold text-ink">{step.title}</h3>
                      <p className="mt-1 text-sm leading-6 text-ink-muted">{step.copy}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </section>

            <section>
              <h2 className="text-base font-bold text-ink">Evidence to collect</h2>
              <div className="mt-3 overflow-hidden rounded-xl border border-edge/25">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">Evidence checklist for the rhetorical situation snapshot</caption>
                  <thead className="bg-paper-sunken/50 text-xs uppercase tracking-wider text-ink-muted">
                    <tr>
                      <th scope="col" className="px-4 py-3 font-bold">Notice</th>
                      <th scope="col" className="px-4 py-3 font-bold">Ask yourself</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-edge/15">
                    <tr><th scope="row" className="px-4 py-3 font-semibold text-ink">Audience</th><td className="px-4 py-3 text-ink-muted">What does this audience value, fear, or need?</td></tr>
                    <tr><th scope="row" className="px-4 py-3 font-semibold text-ink">Choice</th><td className="px-4 py-3 text-ink-muted">What does the rhetor choose to say, show, emphasize, or leave out?</td></tr>
                    <tr><th scope="row" className="px-4 py-3 font-semibold text-ink">Effect</th><td className="px-4 py-3 text-ink-muted">How might that choice move this audience toward the purpose?</td></tr>
                  </tbody>
                </table>
              </div>
            </section>

            <section>
              <h2 className="text-base font-bold text-ink">Submit</h2>
              <p className="mt-2 text-sm leading-6 text-ink-soft">Turn in one polished paragraph set with the source linked or attached. Bring your annotations to the next class discussion.</p>
            </section>

            <section>
              <h2 className="text-base font-bold text-ink">Success criteria</h2>
              <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                {successCriteria.map((criterion) => (
                  <li key={criterion} className="flex gap-2 text-sm leading-6 text-ink-soft">
                    <CheckCircle2 size={17} aria-hidden="true" className="mt-1 shrink-0 text-accent" />
                    <span>{criterion}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-edge/20 bg-paper-sunken/25 p-4">
                <h2 className="text-sm font-bold text-ink">Support</h2>
                <p className="mt-1 text-sm leading-6 text-ink-muted">Use the sentence frame: “Because the audience…, the rhetor uses… to…, which…”</p>
              </div>
              <div className="rounded-xl border border-edge/20 bg-paper-sunken/25 p-4">
                <h2 className="text-sm font-bold text-ink">AI-use note</h2>
                <p className="mt-1 text-sm leading-6 text-ink-muted">You may use AI to brainstorm questions or check clarity. Your source choice, evidence, reasoning, and final wording must be your own.</p>
              </div>
            </section>
          </div>
        </article>

        <aside className="min-w-0 space-y-4">
          <section className="rounded-2xl border border-edge/30 bg-paper p-5 shadow-sm sm:p-6">
            <div className="mb-4 flex items-start gap-3">
              <div className="rounded-xl bg-mark-tint p-2.5 text-mark"><ShieldCheck size={19} aria-hidden="true" /></div>
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-mark">Teacher view</p>
                <h2 className="mt-1 text-lg font-bold text-ink">Design notes</h2>
              </div>
            </div>
            <div className="space-y-4 text-sm leading-6 text-ink-soft">
              <div>
                <h3 className="font-bold text-ink">Rationale</h3>
                <p className="mt-1">The task isolates one transferable AP skill: explaining the relationship between a rhetorical choice and the situation it answers.</p>
              </div>
              <div>
                <h3 className="font-bold text-ink">Assessment signal</h3>
                <p className="mt-1">Look for reasoning that connects evidence to audience and purpose, not a list of rhetorical terms.</p>
              </div>
            </div>
          </section>

          <section className="rounded-2xl border border-edge/30 bg-paper p-5 shadow-sm sm:p-6">
            <h2 className="text-base font-bold text-ink">Single-point rubric</h2>
            <div className="mt-3 overflow-hidden rounded-xl border border-edge/20">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Single-point rubric for the assignment</caption>
                <tbody className="divide-y divide-edge/15">
                  {rubricRows.map(([criterion, description]) => (
                    <tr key={criterion}>
                      <th scope="row" className="w-2/5 px-3 py-3 align-top text-xs font-bold text-ink">{criterion}</th>
                      <td className="px-3 py-3 text-xs leading-5 text-ink-muted">{description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-2xl border border-edge/30 bg-paper p-5 shadow-sm sm:p-6">
            <h2 className="text-base font-bold text-ink">Differentiation</h2>
            <ul className="mt-3 space-y-2 text-sm leading-6 text-ink-muted">
              <li><span className="font-semibold text-ink">Scaffold:</span> provide a teacher-curated source and a filled-in rhetorical situation chart.</li>
              <li><span className="font-semibold text-ink">Extension:</span> compare two messages addressing the same situation.</li>
              <li><span className="font-semibold text-ink">Revision:</span> highlight the sentence where evidence becomes reasoning, then strengthen that connection.</li>
            </ul>
          </section>
        </aside>
      </div>
    </main>
  )
}
