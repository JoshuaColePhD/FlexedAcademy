import { Link } from 'react-router-dom'
import { useDocumentTitle } from '../hooks/useDocumentTitle'

/* The public front door.
 *
 * Until now there wasn't one: an anonymous visitor to flexedacademy.com was
 * routed straight to /login, so the only thing the product said to someone who
 * had never seen it was "email and password". This is the page that has to earn
 * the signup.
 *
 * It lives INSIDE the app rather than on a separate marketing host, which is
 * what makes "Start a week free" a real route rather than a cross-domain hop:
 * one deploy, one set of tokens, one session.
 *
 * The violet is --brand and appears nowhere else. See tokens.css: --accent is
 * the district blue printed in the .docx and it means something, so the product
 * keeps it. Violet outside the door, district blue inside.
 *
 * The claim in the headline is the only one worth making — that a code in a
 * plan traces to a real document — so the page says it once, large, and then
 * spends the rest of its space getting out of the way.
 */
export function LandingPage() {
  useDocumentTitle('Lesson planning, grounded')

  return (
    <div className="landing">
      <header className="landing-head">
        <span className="landing-brand">
          <span className="landing-mark" aria-hidden="true" />
          Flexed Academy
        </span>
        <Link to="/login" className="landing-signin">
          Sign in
        </Link>
      </header>

      <main className="landing-main">
        <p className="landing-eyebrow">Lesson planning, grounded</p>

        <h1 className="landing-title">
          A week of plans that cite their sources.
        </h1>

        <p className="landing-sub">
          Written from the verbatim text of the Alabama standards, not from a model’s memory of
          them. Downloads as your district’s .docx.
        </p>

        <div className="landing-actions">
          <Link to="/signup" className="landing-cta">
            Start a week free
          </Link>
          <span className="landing-note">Built by a high-school teacher</span>
        </div>
      </main>

      <footer className="landing-foot">
        <span>Grades 9–12 · Alabama Course of Study</span>
        <span>Every code traces to a real document</span>
        <span>Florence, Alabama</span>
      </footer>
    </div>
  )
}
