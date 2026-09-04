/* One question per screen.
 *
 * Replaces StepHeader, which stacked three off-scale type treatments: a
 * `tracking-[0.18em] text-ink-faint` progress line (--ink-faint is documented
 * in tokens.css as NOT text, at 2.4:1), an uppercase `text-accent-text`
 * eyebrow, and a `text-3xl font-bold tracking-display` h2.
 *
 * text-2xl font-semibold tracking-tight is the app's real page-heading idiom —
 * StandardsPage, ClassPage, SettingsPage, LegalLayout and Greeting all use it.
 * text-3xl appeared exactly once in the whole product, in the header this
 * replaces; --fs-3xl and --fs-4xl belong to the landing page and BootScreen.
 * The reference layout's heading reads large because of its ratio to a narrow
 * column and a lot of whitespace, not because of an absolute size, and going
 * bigger here would make setup the loudest type in the app.
 *
 * Both the progress line and the eyebrow are gone. The rail beside this
 * carries "where am I", and "Welcome to FlexEd" was a kicker introducing the
 * product to someone who had just signed into it. (DESIGN.md's "don't add an
 * eyebrow above a heading" is landing-scoped — AdminPage does it in six
 * places — so this is a judgement about duplication, not that rule.)
 *
 * The id stays `onboarding-title`: the modal's aria-labelledby points at it.
 * Only one step is mounted at a time, because AnimatePresence mode="wait"
 * unmounts the outgoing step before mounting the next, so the id is never
 * duplicated even mid-transition. One more reason to keep mode="wait".
 */

export function OnboardingQuestion({ question, lead, children, className = '' }) {
  return (
    <header className={`onboarding-question ${className}`.trim()}>
      <h2 id="onboarding-title" className="text-2xl font-semibold tracking-tight text-ink">
        {question}
      </h2>
      {lead ? <p className="onboarding-lead">{lead}</p> : null}
      {children}
    </header>
  )
}

/* The reference layout's "Choose an avatar:" — a small bold label naming the
 * control below it. Deliberately not .eyebrow, which is uppercase --fs-2xs
 * with caps tracking: that is a section tag, and this is a field label, so it
 * stays sentence case at body size. */
export function OnboardingChoiceLabel({ children, as: Tag = 'p' }) {
  return <Tag className="onboarding-choice-label">{children}</Tag>
}
