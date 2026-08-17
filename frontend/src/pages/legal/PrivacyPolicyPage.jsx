import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { LegalLayout } from './LegalLayout'

/* Reflects what this app actually does — see backend/routes/*.py and
 * db.py's own table comments for the real data flows this describes. Not a
 * substitute for a lawyer's review (see the note at the very bottom); it's
 * a genuine first draft of what's true today, not filled-in boilerplate.
 * Update this alongside any change to what data the app collects, who it's
 * sent to, or what a teacher can do about it.
 */
export function PrivacyPolicyPage() {
  useDocumentTitle('Privacy Policy')
  return (
    <LegalLayout title="Privacy Policy" updated="August 16, 2026">
      <p>
        FlexEd Academy ("FlexEd Academy," "we," "us") is operated by Joshua Cole. This policy
        explains what information the app collects from a teacher who creates an account, why,
        who it's shared with, and what control a teacher has over it.
      </p>

      <section>
        <h2 className="text-base font-semibold text-ink">Who this is for</h2>
        <p className="mt-2">
          FlexEd Academy is built for teachers and other adult education professionals. It is not
          directed at, and we do not knowingly collect personal information from, children under
          13. The app does not ask a teacher to upload a class roster, student names, or student
          grades — the content it works with is curriculum (lesson plans, quizzes, standards),
          not individual student records.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">Information we collect</h2>
        <p className="mt-2">
          <strong className="text-ink">Account information.</strong> Your name and email address,
          and either a password (stored as a salted hash, never in plain text) or, if you sign in
          with Google, the confirmation of your Google identity — signing in with Google does not
          give this app access to your Google account beyond confirming who you are.
        </p>
        <p className="mt-2">
          <strong className="text-ink">Class and preference information.</strong> The classes you
          add (name, subject, grade), your school's teaching calendar selection, and any custom
          instructions you write for how you like plans formatted.
        </p>
        <p className="mt-2">
          <strong className="text-ink">Content you create.</strong> The messages you type or
          speak in chat, any file you attach, and the lesson plans and quizzes the app builds from
          those conversations.
        </p>
        <p className="mt-2">
          <strong className="text-ink">Usage information.</strong> How many tokens a request used,
          when you last built a plan, and how many plans you've built — used to enforce the
          weekly usage allowance described in our Terms and to operate the service reliably.
        </p>
        <p className="mt-2">
          <strong className="text-ink">Billing information.</strong> If you subscribe, your
          subscription status and renewal date. Your card number is never seen or stored by this
          app — payment is handled entirely by Stripe (see "Third parties" below).
        </p>
        <p className="mt-2">
          <strong className="text-ink">Google Drive (optional).</strong> If you choose to connect
          Google Drive to export a plan or quiz as a real Google Doc, we request only the ability
          to create and manage files this app itself creates in your Drive — never access to
          files already there. You can disconnect this at any time in Settings.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">How we use this information</h2>
        <p className="mt-2">
          To generate lesson plans and quizzes grounded in your state's course of study, to build
          the document you download, to enforce the usage allowance tied to your plan, to bill a
          subscription if you have one, and to operate, secure, and improve the service. We do not
          sell your information, and we do not use your content to train a general-purpose AI
          model for anyone else.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">Third parties we share information with</h2>
        <p className="mt-2">
          We use a small number of outside services to run FlexEd Academy, each only for the
          purpose named:
        </p>
        <ul className="mt-2 list-disc pl-5">
          <li>
            <strong className="text-ink">OpenAI</strong> — the content of your chat messages and
            custom instructions is sent to OpenAI's API to generate plans and quizzes. OpenAI
            processes this under its own API data-use terms, which (as of this writing) exclude
            API content from being used to train OpenAI's models by default.
          </li>
          <li>
            <strong className="text-ink">Stripe</strong> — handles payment and subscription
            billing. We never receive or store your full card number.
          </li>
          <li>
            <strong className="text-ink">Google</strong> — verifies your identity if you sign in
            with Google, and, only if you connect it, provides the Drive access described above.
          </li>
          <li>
            <strong className="text-ink">Render and Supabase</strong> — host the application and
            its database. Both are infrastructure providers; they do not use your data for their
            own purposes.
          </li>
        </ul>
        <p className="mt-2">
          We do not otherwise sell, rent, or share your personal information with third parties
          for their own marketing purposes.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">Your control over your data</h2>
        <p className="mt-2">
          From Settings, you can download every plan, chat, class, and pacing guide you've put in
          as a single file, sign out of every device at once, or permanently delete your account
          and everything in it. Deleting your account removes your content from our active
          database; it does not retroactively withdraw a document already generated from OpenAI's
          own transient processing, which OpenAI does not retain by default for API requests.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">Data retention</h2>
        <p className="mt-2">
          We keep your account information and content for as long as your account is active, so
          the app can keep showing you the plans you've already built. If you delete your
          account, we delete your personal data and content within a reasonable period, except
          where we're required to keep limited billing records for tax or accounting purposes.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">Security</h2>
        <p className="mt-2">
          Passwords are hashed, not stored in plain text. All traffic to the app is encrypted in
          transit (HTTPS), and session cookies are marked Secure in production. No method of
          storage or transmission is perfectly secure, and we can't guarantee absolute security,
          but we take reasonable, industry-standard steps to protect your information.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">Districts and schools</h2>
        <p className="mt-2">
          If your district requires a data privacy agreement or vendor review before you use a
          tool like this one, contact us at the address below — we're glad to work through it.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">Changes to this policy</h2>
        <p className="mt-2">
          If we make a material change to this policy, we'll post the update here and change the
          date at the top; for a significant change, we'll also try to notify you by email.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">Contact</h2>
        <p className="mt-2">
          Questions about this policy, or a request about your data — reach Joshua Cole at{' '}
          <a className="text-accent-text hover:underline" href="mailto:joshuacolephd@gmail.com">
            joshuacolephd@gmail.com
          </a>
          .
        </p>
      </section>
    </LegalLayout>
  )
}
