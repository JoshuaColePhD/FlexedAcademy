import { Link } from 'react-router-dom'
import { Info } from 'lucide-react'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { SplitLayout } from '../components/SplitLayout'

const TABS = [
  { id: 'who', label: 'Who this app is for' },
  { id: 'what', label: 'What\'s stored, and where' },
  { id: 'third-parties', label: 'Third parties' },
  { id: 'data', label: 'Your data, on request' },
  { id: 'questions', label: 'Questions' },
]

export function PrivacyPage() {
  useDocumentTitle('Privacy')
  return (
    <SplitLayout
      title="Privacy & Data Policy"
      icon={Info}
      tabs={TABS}
      backPath="/"
    >
      <div className="prose">
        <p className="text-sm font-medium text-ink-muted mb-8">Last updated 2026-08-15</p>

        <div id="section-who" className="scroll-mt-8 mb-12">
          <h2 className="text-xl font-bold text-ink mb-4">Who this app is for</h2>
          <p className="text-sm text-ink-soft leading-relaxed mb-4">
            Flexed Academy is a planning tool for teachers. It does not collect student names,
            grades, essays, or disciplinary records, and it has no student-facing accounts. The
            account you create, and every row in the database tied to it, belongs to you as the
            teacher — lesson plans, chat history, quizzes, and any curriculum documents you
            upload.
          </p>
          <p className="text-sm text-ink-soft leading-relaxed mb-4">
            <strong>The one place student information can end up in this app is content you
            choose to paste in</strong> — for example, a student's essay excerpt in a chat
            message asking for feedback. Avoid including a student's name or other identifying
            details in anything you type into the app; ask about the writing or the standard
            instead of the student.
          </p>
        </div>

        <div id="section-what" className="scroll-mt-8 mb-12">
          <h2 className="text-xl font-bold text-ink mb-4">What's stored, and where</h2>
          <ul className="list-disc pl-5 text-sm text-ink-soft leading-relaxed mb-4 space-y-2">
            <li>Your account: name, email, school, and a hashed password (or Google sign-in).</li>
            <li>Classes, lesson plans, quizzes, and chat history you create.</li>
            <li>Curriculum documents you upload, and text extracted from them for search.</li>
            <li>Usage totals (token counts) used to apply the free-tier weekly limit.</li>
          </ul>
          <p className="text-sm text-ink-soft leading-relaxed mb-4">
            All of it lives in a single hosted PostgreSQL database (Supabase), encrypted in
            transit, with row-level security so one account's rows are not reachable through
            another account's session.
          </p>
        </div>

        <div id="section-third-parties" className="scroll-mt-8 mb-12">
          <h2 className="text-xl font-bold text-ink mb-4">Third parties this app sends data to</h2>
          <p className="text-sm text-ink-soft leading-relaxed mb-4">
            Generating a lesson plan, quiz, or chat reply sends the relevant prompt text (your
            request, retrieved curriculum context, and anything you typed) to OpenAI's API to
            produce the response. Voice features send audio or text to OpenAI's transcription and
            speech endpoints. No other third party receives plan, chat, or curriculum content.
            Billing, when enabled, is handled by Stripe and only sees what a payment requires
            (email, payment method) — never lesson or chat content.
          </p>
        </div>

        <div id="section-data" className="scroll-mt-8 mb-12">
          <h2 className="text-xl font-bold text-ink mb-4">Your data, on request</h2>
          <p className="text-sm text-ink-soft leading-relaxed mb-4">
            From your account menu you can export everything the app has stored for you as a
            single JSON file, or permanently delete your account and everything under it. Account
            deletion is immediate and cannot be undone.
          </p>
        </div>

        <div id="section-questions" className="scroll-mt-8 mb-12">
          <h2 className="text-xl font-bold text-ink mb-4">Questions</h2>
          <p className="text-sm text-ink-soft leading-relaxed mb-4">
            Reach out to your school's Flexed Academy administrator, or the app's operator.
          </p>
        </div>
      </div>
    </SplitLayout>
  )
}
