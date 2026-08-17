import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { LegalLayout } from './LegalLayout'

/* Reflects what this app actually does and actually charges — see
 * config.py's own trial_period_days/subscriber_weekly_token_cap and
 * routes/billing.py for the real billing behavior this describes. Not a
 * substitute for a lawyer's review (see the note at the very bottom).
 */
export function TermsPage() {
  useDocumentTitle('Terms of Service')
  return (
    <LegalLayout title="Terms of Service" updated="August 16, 2026">
      <p>
        These terms govern your use of FlexEd Academy, operated by Joshua Cole ("we," "us"). By
        creating an account, you agree to them. If you don't agree, please don't use the service.
      </p>

      <section>
        <h2 className="text-base font-semibold text-ink">Who can use this</h2>
        <p className="mt-2">
          FlexEd Academy is for teachers and other adult education professionals. You must be at
          least 18 to create an account. It is not directed at children, and no one under 13
          should use it.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">What the service does</h2>
        <p className="mt-2">
          FlexEd Academy generates weekly lesson plans and quizzes, citing standards retrieved
          from your state's own course of study, based on what you tell it in chat. It downloads
          as an editable document in your district's format.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">Review what it builds</h2>
        <p className="mt-2">
          This service uses an AI model to generate content. We ground every generation in
          retrieved standards and check citations after the fact, but AI-generated content can
          still contain mistakes — a misworded objective, an activity that needs adjusting for
          your specific class, or, despite our grounding checks, an occasional citation error.
          <strong className="text-ink"> You are responsible for reviewing every plan and quiz
          before using it with students</strong>, the same way you'd review any lesson plan from
          any source before teaching it.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">Your account</h2>
        <p className="mt-2">
          You're responsible for keeping your password confidential and for everything that
          happens under your account. Tell us right away if you think someone else has access to
          it — Settings has a "Sign out of all devices" option for exactly that.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">Subscriptions and billing</h2>
        <p className="mt-2">
          New accounts get a free trial period; after it ends, continued access to the paid tier
          is billed on a recurring basis at the price shown at checkout, through Stripe. You can
          cancel anytime from Settings or the Stripe billing portal — cancellation stops future
          renewals but does not refund the current billing period, except where required by law.
          We may change pricing going forward; we'll show you the new price before it applies to
          you.
        </p>
        <p className="mt-2">
          The free tier and the paid tier both carry a weekly usage allowance, intended to cover
          ordinary lesson-planning use for one teacher. We may adjust these allowances, and may
          throttle or pause generation for an account that's abusing the allowance (for example,
          automated or scripted use rather than a teacher planning their own weeks).
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">Acceptable use</h2>
        <p className="mt-2">You agree not to:</p>
        <ul className="mt-2 list-disc pl-5">
          <li>Use the service for anything illegal, or to generate content that's unlawful, harassing, or discriminatory;</li>
          <li>Attempt to access another account, or share your own credentials with someone else;</li>
          <li>Reverse-engineer, scrape, or resell the service, or use automated means to generate content at a scale beyond ordinary personal lesson-planning;</li>
          <li>Interfere with the service's normal operation or attempt to bypass its usage limits.</li>
        </ul>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">Ownership</h2>
        <p className="mt-2">
          You own the lesson plans, quizzes, and other content generated from your own
          conversations, and may use them however you like — with your students, your district,
          or anyone else. We own the FlexEd Academy software, design, and the underlying standards
          corpus we've assembled; using the service doesn't give you rights to any of that beyond
          what's needed to use the app itself.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">Termination</h2>
        <p className="mt-2">
          You can delete your account at any time from Settings, which permanently removes your
          content. We may suspend or terminate an account that violates these terms, is used
          fraudulently, or repeatedly fails payment, and will try to notify you first except where
          the violation requires immediate action.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">Disclaimer of warranties</h2>
        <p className="mt-2">
          The service is provided "as is," without warranty of any kind, express or implied,
          including any warranty that it will be uninterrupted, error-free, or that generated
          content will be accurate or fit for a particular purpose. You use it at your own
          discretion, and remain responsible for reviewing everything it produces before relying
          on it.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">Limitation of liability</h2>
        <p className="mt-2">
          To the fullest extent permitted by law, Joshua Cole will not be liable for any indirect,
          incidental, or consequential damages arising from your use of the service, and our total
          liability for any claim will not exceed the amount you paid us in the twelve months
          before the claim arose.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">Changes to these terms</h2>
        <p className="mt-2">
          We may update these terms as the service changes. We'll post the update here and change
          the date at the top; for a material change, we'll try to notify you by email before it
          takes effect.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">Governing law</h2>
        <p className="mt-2">
          These terms are governed by the laws of the State of Alabama, without regard to its
          conflict-of-laws principles.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">Contact</h2>
        <p className="mt-2">
          Questions about these terms — reach Joshua Cole at{' '}
          <a className="text-accent-text hover:underline" href="mailto:joshuacolephd@gmail.com">
            joshuacolephd@gmail.com
          </a>
          .
        </p>
      </section>
    </LegalLayout>
  )
}
