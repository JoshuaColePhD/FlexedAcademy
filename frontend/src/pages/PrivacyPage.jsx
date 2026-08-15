import { Link } from 'react-router-dom'
import { useDocumentTitle } from '../hooks/useDocumentTitle'

/* What this app actually stores, why, and how to get it back or gone —
 * plain text answers to the questions a teacher, a district FERPA officer,
 * or a parent would actually ask. See COMPLIANCE.md in the repo for the
 * engineering-level detail this page summarizes (schema, third-party data
 * flows, retention, the admin audit log). This is the one page that has to
 * stay readable to someone who has never seen the code, so it stays plain
 * markup rather than the app's usual component styling. */
export function PrivacyPage() {
  useDocumentTitle('Privacy')
  return (
    <div className="column">
      <div className="page">
        <div className="prose">
          <p>
            <Link to="/">&larr; Back to Flexed Academy</Link>
          </p>
          <h1>Privacy &amp; data policy</h1>
          <p className="prose-meta">Last updated 2026-08-15</p>

          <h2>Who this app is for</h2>
          <p>
            Flexed Academy is a planning tool for teachers. It does not collect student names,
            grades, essays, or disciplinary records, and it has no student-facing accounts. The
            account you create, and every row in the database tied to it, belongs to you as the
            teacher — lesson plans, chat history, quizzes, and any curriculum documents you
            upload.
          </p>
          <p>
            <strong>The one place student information can end up in this app is content you
            choose to paste in</strong> — for example, a student's essay excerpt in a chat
            message asking for feedback. Avoid including a student's name or other identifying
            details in anything you type into the app; ask about the writing or the standard
            instead of the student.
          </p>

          <h2>What's stored, and where</h2>
          <ul>
            <li>Your account: name, email, school, and a hashed password (or Google sign-in).</li>
            <li>Classes, lesson plans, quizzes, and chat history you create.</li>
            <li>Curriculum documents you upload, and text extracted from them for search.</li>
            <li>Usage totals (token counts) used to apply the free-tier weekly limit.</li>
          </ul>
          <p>
            All of it lives in a single hosted PostgreSQL database (Supabase), encrypted in
            transit, with row-level security so one account's rows are not reachable through
            another account's session.
          </p>

          <h2>Third parties this app sends data to</h2>
          <p>
            Generating a lesson plan, quiz, or chat reply sends the relevant prompt text (your
            request, retrieved curriculum context, and anything you typed) to OpenAI's API to
            produce the response. Voice features send audio or text to OpenAI's transcription and
            speech endpoints. No other third party receives plan, chat, or curriculum content.
            Billing, when enabled, is handled by Stripe and only sees what a payment requires
            (email, payment method) — never lesson or chat content.
          </p>

          <h2>Your data, on request</h2>
          <p>
            From your account menu you can export everything the app has stored for you as a
            single JSON file, or permanently delete your account and everything under it. Account
            deletion is immediate and cannot be undone.
          </p>

          <h2>Questions</h2>
          <p>Reach out to your school's Flexed Academy administrator, or the app's operator.</p>
        </div>
      </div>
    </div>
  )
}
