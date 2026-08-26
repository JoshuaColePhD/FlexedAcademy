import { Shield } from 'lucide-react'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { SplitLayout } from '../../components/SplitLayout'

/* Reflects what this app actually does — see backend/routes/*.py and
 * db.py's own table comments for the real data flows this describes. Not a
 * substitute for a lawyer's review (see the note at the very bottom); it's
 * a genuine first draft of what's true today, not filled-in boilerplate.
 * Update this alongside any change to what data the app collects, who it's
 * sent to, or what a teacher can do about it.
 */

const TABS = [
  { id: 'who', label: 'Who this is for' },
  { id: 'collect', label: 'Information we collect' },
  { id: 'use', label: 'How we use this information' },
  { id: 'third-parties', label: 'Third parties' },
  { id: 'control', label: 'Your control over your data' },
  { id: 'retention', label: 'Data retention' },
  { id: 'security', label: 'Security' },
  { id: 'schools', label: 'Districts and schools' },
  { id: 'changes', label: 'Changes to this policy' },
  { id: 'contact', label: 'Contact' },
]

export function PrivacyPolicyPage() {
  useDocumentTitle('Privacy Policy')
  return (
    <SplitLayout
      title="Privacy Policy"
      icon={Shield}
      tabs={TABS}
      backPath="/"
    >
      <div className="prose">
        <p className="text-sm font-medium text-ink-muted mb-8">Last updated August 16, 2026</p>

        <p className="text-sm text-ink-soft leading-relaxed mb-8">
          FlexEd Academy ("FlexEd Academy," "we," "us") is operated by Joshua Cole. This policy
          explains what information the app collects from a teacher who creates an account, why,
          who it's shared with, and what control a teacher has over it.
        </p>

        <div id="section-who" className="scroll-mt-8 mb-12">
          <h2 className="text-xl font-bold text-ink mb-4">Who this is for</h2>
          <p className="text-sm text-ink-soft leading-relaxed">
            FlexEd Academy is built for teachers and other adult education professionals. It is not
            directed at, and we do not knowingly collect personal information from, children under
            13. The app does not ask a teacher to upload a class roster, student names, or student
            grades — the content it works with is curriculum (lesson plans, quizzes, standards),
            not individual student records.
          </p>
        </div>

        <div id="section-collect" className="scroll-mt-8 mb-12">
          <h2 className="text-xl font-bold text-ink mb-4">Information we collect</h2>
          <p className="text-sm text-ink-soft leading-relaxed mb-4">
            <strong className="text-ink">Account information.</strong> Your name and email address,
            and either a password (stored as a salted hash, never in plain text) or, if you sign in
            with Google, the confirmation of your Google identity — signing in with Google does not
            give this app access to your Google account beyond confirming who you are.
          </p>
          <p className="text-sm text-ink-soft leading-relaxed mb-4">
            <strong className="text-ink">Class and preference information.</strong> The classes you
            add (name, subject, grade), your school's teaching calendar selection, and any custom
            instructions you write for how you like plans formatted.
          </p>
          <p className="text-sm text-ink-soft leading-relaxed mb-4">
            <strong className="text-ink">Content you create.</strong> The messages you type or
            speak in chat, any file you attach, and the lesson plans and quizzes the app builds from
            those conversations.
          </p>
          <p className="text-sm text-ink-soft leading-relaxed mb-4">
            <strong className="text-ink">Usage information.</strong> How many tokens a request used,
            when you last built a plan, and how many plans you've built — used to enforce the
            weekly usage allowance described in our Terms and to operate the service reliably.
          </p>
          <p className="text-sm text-ink-soft leading-relaxed mb-4">
            <strong className="text-ink">Billing information.</strong> If you subscribe, your
            subscription status and renewal date. Your card number is never seen or stored by this
            app — payment is handled entirely by Stripe (see "Third parties" below).
          </p>
          <p className="text-sm text-ink-soft leading-relaxed mb-4">
            <strong className="text-ink">Google Drive (optional).</strong> If you choose to connect
            Google Drive to export a plan or quiz as a real Google Doc, we request only the ability
            to create and manage files this app itself creates in your Drive — never access to
            files already there. You can disconnect this at any time in Settings.
          </p>
        </div>

        <div id="section-use" className="scroll-mt-8 mb-12">
          <h2 className="text-xl font-bold text-ink mb-4">How we use this information</h2>
          <p className="text-sm text-ink-soft leading-relaxed">
            To generate lesson plans and quizzes grounded in your state's course of study, to build
            the document you download, to enforce the usage allowance tied to your plan, to bill a
            subscription if you have one, and to operate, secure, and improve the service. We do not
            sell your information, and we do not use your content to train a general-purpose AI
            model for anyone else.
          </p>
        </div>

        <div id="section-third-parties" className="scroll-mt-8 mb-12">
          <h2 className="text-xl font-bold text-ink mb-4">Third parties we share information with</h2>
          <p className="text-sm text-ink-soft leading-relaxed mb-4">
            We use a small number of outside services to run FlexEd Academy, each only for the
            purpose named:
          </p>
          <ul className="list-disc pl-5 text-sm text-ink-soft leading-relaxed mb-4 space-y-2">
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
          <p className="text-sm text-ink-soft leading-relaxed">
            We do not otherwise sell, rent, or share your personal information with third parties
            for their own marketing purposes.
          </p>
        </div>

        <div id="section-control" className="scroll-mt-8 mb-12">
          <h2 className="text-xl font-bold text-ink mb-4">Your control over your data</h2>
          <p className="text-sm text-ink-soft leading-relaxed">
            From Settings, you can download every plan, chat, class, and pacing guide you've put in
            as a single file, sign out of every device at once, or permanently delete your account
            and everything in it. Deleting your account removes your content from our active
            database; it does not retroactively withdraw a document already generated from OpenAI's
            own transient processing, which OpenAI does not retain by default for API requests.
          </p>
        </div>

        <div id="section-retention" className="scroll-mt-8 mb-12">
          <h2 className="text-xl font-bold text-ink mb-4">Data retention</h2>
          <p className="text-sm text-ink-soft leading-relaxed">
            We keep your account information and content for as long as your account is active, so
            the app can keep showing you the plans you've already built. If you delete your
            account, we delete your personal data and content within a reasonable period, except
            where we're required to keep limited billing records for tax or accounting purposes.
          </p>
        </div>

        <div id="section-security" className="scroll-mt-8 mb-12">
          <h2 className="text-xl font-bold text-ink mb-4">Security</h2>
          <p className="text-sm text-ink-soft leading-relaxed">
            Passwords are hashed, not stored in plain text. All traffic to the app is encrypted in
            transit (HTTPS), and session cookies are marked Secure in production. No method of
            storage or transmission is perfectly secure, and we can't guarantee absolute security,
            but we take reasonable, industry-standard steps to protect your information.
          </p>
        </div>

        <div id="section-schools" className="scroll-mt-8 mb-12">
          <h2 className="text-xl font-bold text-ink mb-4">Districts and schools</h2>
          <p className="text-sm text-ink-soft leading-relaxed">
            If your district requires a data privacy agreement or vendor review before you use a
            tool like this one, contact us at the address below — we're glad to work through it.
          </p>
        </div>

        <div id="section-changes" className="scroll-mt-8 mb-12">
          <h2 className="text-xl font-bold text-ink mb-4">Changes to this policy</h2>
          <p className="text-sm text-ink-soft leading-relaxed">
            If we make a material change to this policy, we'll post the update here and change the
            date at the top; for a significant change, we'll also try to notify you by email.
          </p>
        </div>

        <div id="section-contact" className="scroll-mt-8 mb-12">
          <h2 className="text-xl font-bold text-ink mb-4">Contact</h2>
          <p className="text-sm text-ink-soft leading-relaxed">
            Questions about this policy, or a request about your data — reach Joshua Cole at{' '}
            <a className="text-accent-text hover:underline" href="mailto:joshuacolephd@gmail.com">
              joshuacolephd@gmail.com
            </a>
            .
          </p>
        </div>
      </div>
    </SplitLayout>
  )
}
