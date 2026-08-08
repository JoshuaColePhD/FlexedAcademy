import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { api } from '../lib/api'

/* The public front door — a verification seal on violet, not a bordered grid.
 * The logo mark is a violet gem glowing on near-black; the page commits to
 * that as its real, fixed habitat rather than following the visitor's
 * light/dark preference. Gold is reserved for exactly one recurring
 * signature — the seal — so it always means "this claim was checked," never
 * generic decoration. The one warm, paper-toned section is the excerpt of an
 * actual standards document; everywhere else stays violet.
 *
 * <!-- impeccable:direction
 * THESIS: A verification seal on violet, not a bordered glass grid — one
 * signature motif (the seal) proves the mechanism instead of a layout metaphor
 * describing it.
 * OWN-WORLD: Fixed deep-violet ground (never following data-theme) + gold
 * seal accent + one warm paper section for the real document excerpt.
 * Bricolage Grotesque display, Source Serif 4 for quoted text, Inter/JetBrains
 * Mono elsewhere.
 * STORY: See the claim with its seal, watch the connector draw from claim to
 * source on scroll, see the three-stage thread that makes it true, start a
 * free week.
 * FIRST VIEWPORT: bar (mark, quiet sign-in) over a violet hero — headline
 * with a hand-drawn seal, sub, one gold CTA.
 * FORM: second pass via /frontend-design after the first (glazier-wall)
 * build read as generic/broadsheet; user-directed redesign.
 * FINISH: unreviewed and undocumented is unfinished; this build ends with
 * the finish review and an updated DESIGN.md.
 * -->
 */

function priceLine(data) {
  const p = data?.price
  if (!p?.amount) return null
  const money = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: p.currency || 'USD',
    minimumFractionDigits: p.amount % 100 === 0 ? 0 : 2,
  }).format(p.amount / 100)
  const every =
    p.interval_count > 1 ? `${p.interval_count} ${p.interval}s` : p.interval || 'month'
  const weeks = data.free_allowance === 1 ? 'Your first week is free' : `Your first ${data.free_allowance} weeks are free`
  return `${weeks}, then ${money} a ${every}. Cancel any time.`
}

function useInView() {
  const ref = useRef(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true)
          observer.disconnect()
        }
      },
      { threshold: 0.3 }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, inView]
}

function VerifySeal({ className }) {
  return (
    <svg viewBox="0 0 64 64" width="40" height="40" aria-hidden="true" className={className}>
      <circle
        cx="32"
        cy="32"
        r="27"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        className="land-seal-ring"
      />
      <path
        d="M20 33l8 8 16-18"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="land-seal-check"
      />
    </svg>
  )
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 16 10" width="16" height="10" aria-hidden="true" className="land-arrow">
      <path
        d="M0 5h14M9 1l5 4-5 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function LandingPage() {
  useDocumentTitle('Lesson planning, grounded')
  const [pricing, setPricing] = useState(null)
  const [proofRef, proofInView] = useInView()
  const [pipelineRef, pipelineInView] = useInView()

  useEffect(() => {
    let cancelled = false
    api
      .publicPrice()
      .then((d) => !cancelled && setPricing(priceLine(d)))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="land">
      <header className="land-bar">
        <span className="land-brand">Flexed Academy</span>
        <Link to="/login" className="land-signin">
          Sign in
        </Link>
      </header>

      <section className="land-hero">
        <div className="land-glow" aria-hidden="true" />
        <h1 className="land-title">
          A week of plans that cite their sources
          <VerifySeal className="land-seal land-seal--hero" />
        </h1>
        <p className="land-sub">
          Written from the verbatim text of the Alabama Course of Study — not a model's
          memory of it. Downloads as your district's own .docx.
        </p>
        <div className="land-actions">
          <Link to="/signup" className="land-cta">
            Start a week free
            <ArrowIcon />
          </Link>
          <span className="land-note">Built by a Florence, Alabama high school teacher</span>
        </div>
        {pricing ? <p className="land-price">{pricing}</p> : null}
      </section>

      <section ref={proofRef} className={`land-proof${proofInView ? ' is-inview' : ''}`}>
        <h2 className="land-heading">Every line traces back.</h2>
        <div className="land-excerpt">
          <div className="land-excerpt-plan">
            <div>
              <span className="land-tag">Example — illustrative, not a real class output</span>
              <p className="land-quote">
                Monday — Students annotate rhetorical shifts in paired excerpts, then draft a
                claim connecting tone to purpose.
                <sup className="land-cite">1</sup>
              </p>
            </div>
          </div>
          <svg className="land-connector" viewBox="0 0 200 90" preserveAspectRatio="none" aria-hidden="true">
            <path d="M6 14 C 120 14, 90 76, 194 76" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
          <div className="land-excerpt-source">
            <VerifySeal className="land-seal land-seal--source" />
            <div>
              <span className="land-tag">Cited standard</span>
              <p className="land-quote">
                AP Lang Skill 4.B — Reading: explain how word choice and syntax convey tone.
              </p>
              <span className="land-loc">source_docs/APLangSkills.pdf, p. 6</span>
            </div>
          </div>
        </div>
      </section>

      <section ref={pipelineRef} className={`land-pipeline${pipelineInView ? ' is-inview' : ''}`}>
        <div className="land-thread">
          <svg className="land-thread-line" viewBox="0 0 600 4" preserveAspectRatio="none" aria-hidden="true">
            <line x1="0" y1="2" x2="600" y2="2" stroke="currentColor" strokeWidth="2" />
          </svg>
          <div className="land-node">
            <span className="land-node-dot" />
            <span className="land-stage">Retrieve</span>
            <p>
              The verbatim standard text is pulled first. An off-topic question is refused
              outright, never answered from the nearest match.
            </p>
          </div>
          <div className="land-node">
            <span className="land-node-dot" />
            <span className="land-stage">Generate</span>
            <p>The plan is drafted from only what retrieval handed over — nothing recalled from memory.</p>
          </div>
          <div className="land-node">
            <span className="land-node-dot" />
            <span className="land-stage">Audit</span>
            <p>Every code in the output is checked against what retrieval supplied. Anything else is flagged, not hidden.</p>
          </div>
        </div>
        <p className="land-scope">
          Calibrated today for AP Lang, grade 11. Grades 9–12 across all Alabama Course of
          Study subjects are in the corpus; AP Lang is the fully tested path.
        </p>
      </section>

      <footer className="land-foot">
        <span>AP Lang, Grade 11 · Alabama Course of Study</span>
        <span>Florence, Alabama</span>
        <Link to="/signup" className="land-foot-cta">
          Start a week free
          <ArrowIcon />
        </Link>
      </footer>
    </div>
  )
}
