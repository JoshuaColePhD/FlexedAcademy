import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { api } from '../lib/api'
import { handleViewTransitionNavigation } from '../lib/viewTransitions'
import { SignInForm } from '../components/SignInForm'

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
 * early access.
 * FIRST VIEWPORT: bar (mark, quiet sign-in) over a violet hero — headline
 * with a hand-drawn seal, sub, one gold CTA.
 * FORM: second pass via /frontend-design after the first (glazier-wall)
 * build read as generic/broadsheet; user-directed redesign.
 * FINISH: unreviewed and undocumented is unfinished; this build ends with
 * the finish review and an updated DESIGN.md.
 * -->
 */

// Plans are unlimited on the free tier now (a rolling weekly usage cap
// replaced "one free plan, ever" — see backend/entitlement.py). A raw token
// number means nothing to a teacher deciding whether to sign up, so this
// stays qualitative — the same choice ChatGPT/Claude make for their own free
// tiers — rather than printing free_weekly_token_cap here.
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
  // The real trial length, read from the same place Checkout itself reads
  // it (routes/billing.py) — not hardcoded here, so this line can't
  // promise a number Stripe isn't actually configured to honor.
  const days = data?.trial_period_days
  return days > 0
    ? `Try FlexEd free for ${days} days — no credit card required. Then ${money} a ${every}.`
    : `Join early access — ${money} a ${every}.`
}

/* Reveal-on-scroll, with a backstop that does not depend on
 * IntersectionObserver having fired.
 *
 * What this guards is worth stating plainly, because the failure is silent and
 * total rather than partial: the three sections using this hook start at
 * `opacity: 0` / `transform: scale(0)` in CSS (.land-mech-step,
 * .land-node-dot, .land-connector-*) and are revealed ONLY by the .is-inview
 * class this hook decides to add. So anything that stops the observer from
 * delivering a callback doesn't degrade the animation — it leaves the section
 * that explains how the product works as blank space with the connecting
 * arrows still drawn around it, on the public landing page, for a visitor who
 * has never seen the product. Same shape as the AnimatePresence stall fixed in
 * ClassPage: content whose visibility is contingent on an animation callback.
 *
 * Two changes:
 *  - A plain geometric check on mount, on scroll, and on resize. It is a few
 *    lines, it is deterministic, and it covers the cases an observer alone can
 *    miss: an element already on screen at mount, a scroll container that is
 *    not the document (.land is `overflow-y: auto`, and index.html's body is
 *    overflow-hidden, so the document itself never scrolls here), and a first
 *    callback that never arrives. Whichever mechanism notices first wins —
 *    they both just set the same flag once.
 *  - threshold 0.3 -> 0.2, and the manual check uses a simple "any part of it
 *    is past 85% of the viewport" test. 30% of a section had to be on screen
 *    before anything appeared, which on a phone meant scrolling well into a
 *    blank region before it filled in.
 *
 * The reveal still only happens on approach, so the effect is unchanged for
 * anyone whose observer works normally.
 */
function useInView() {
  const ref = useRef(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    let done = false
    const reveal = () => {
      if (done) return
      done = true
      setInView(true)
    }

    // Geometric backstop. Cheap enough to run on scroll: one
    // getBoundingClientRect against the viewport, and it stops listening the
    // moment it fires.
    const check = () => {
      if (done) return
      const r = el.getBoundingClientRect()
      const vh = window.innerHeight || 0
      if (r.top < vh * 0.85 && r.bottom > 0) {
        reveal()
        detach()
      }
    }

    /* Listen on whatever actually scrolls, found by walking up.
     *
     * The first version of this used a single capture-phase listener on
     * `window`, on the theory that capture sees non-bubbling element scroll
     * events on the way down. Measured in a real browser: a window capture
     * listener received ZERO of .land's scroll events. Scroll on an element is
     * dispatched to that element, and relying on capture to catch it is a
     * coin-flip across engines — so this subscribes to the real scrollers
     * instead, which needs no assumptions about propagation at all.
     *
     * window is included as well, for the ordinary document-scroll case: this
     * hook shouldn't silently stop working if .land ever loses its own
     * overflow. */
    const scrollers = [window]
    for (let n = el.parentElement; n; n = n.parentElement) {
      const oy = getComputedStyle(n).overflowY
      if (oy === 'auto' || oy === 'scroll') scrollers.push(n)
    }
    const detach = () => {
      for (const s of scrollers) s.removeEventListener('scroll', check)
      window.removeEventListener('resize', check)
      document.removeEventListener('visibilitychange', check)
    }
    for (const s of scrollers) s.addEventListener('scroll', check, { passive: true })
    window.addEventListener('resize', check, { passive: true })
    /* A tab opened in the background (cmd-click, "open in new tab") loads with
     * document.visibilityState === 'hidden', and a hidden page is not required
     * to deliver intersection callbacks or scroll events. Re-checking when it
     * becomes visible is what makes that a normal first paint rather than a
     * blank section. */
    document.addEventListener('visibilitychange', check)

    let observer
    if (typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) {
            reveal()
            observer.disconnect()
            detach()
          }
        },
        { threshold: 0.2 }
      )
      observer.observe(el)
    }

    // After layout has settled, not during this commit — a rect measured
    // before the fonts and the hero have sized themselves is not the rect the
    // visitor is looking at.
    const raf = requestAnimationFrame(check)

    return () => {
      cancelAnimationFrame(raf)
      if (observer) observer.disconnect()
      detach()
    }
  }, [])
  return [ref, inView]
}

function VerifySeal({ className }) {
  return (
    <svg viewBox="0 0 64 64" width="40" height="40" aria-hidden="true" className={className}>
      {/* A stamped seal is a raised, physical object, not a flat outline —
          this disc is the same material as whatever's behind it (its own
          fill matches the ground, see .land-seal-disc), embossed via the
          two-shadow filter on .land-seal itself. The ring and check stay
          exactly as before, just drawn on top of something with depth now. */}
      <circle cx="32" cy="32" r="29" className="land-seal-disc" />
      {/* The stamp's perforated edge — more of the "seal" this icon is named
          for, and literally more connecting lines around the mark, not just
          the one ring. Sits outside the disc, inside the viewBox's own
          margin, so it never clips. */}
      <circle
        cx="32"
        cy="32"
        r="30.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        strokeDasharray="1.6 3.4"
        className="land-seal-ticks"
      />
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

function ArrowIcon({ className }) {
  return (
    <svg
      viewBox="0 0 16 10"
      width="16"
      height="10"
      aria-hidden="true"
      className={className ? `land-arrow ${className}` : 'land-arrow'}
    >
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

/* Was a plain <Link to="/login">, so the one click a visitor is likeliest to
 * make on this page — "I already have an account" — cost a full navigation
 * away from the world this page just spent a screen convincing them of. Now
 * it opens right where they're already looking: hover on desktop (a nav
 * dropdown is the pattern everyone already knows), click for touch/keyboard,
 * closes on Escape, an outside click, or a successful sign-in (Gate swaps
 * the whole route tree the moment status flips to 'authed', which unmounts
 * this page — nothing left to close).
 *
 * The panel itself is a light paper card, not violet — same call the proof
 * section already made for its warm-paper excerpt: the sign-in FORM is
 * borrowed from the app's own world (paper/ink/accent tokens), not the
 * landing page's fixed brand one, because that's the palette its inputs and
 * focus rings are actually built against. */
function SignInPopover() {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  const closeTimer = useRef(null)
  // Once a field inside the panel has ever had focus, the mouse-driven timer
  // below (closeSoon) permanently stands down — see its own comment for why.
  const engagedRef = useRef(false)

  const openNow = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    setOpen(true)
  }
  // A short delay, not instant-close-on-mouseleave: the trigger and the
  // panel aren't touching (there's a gap for the panel to drop into), so
  // crossing that gap on the way from one to the other would otherwise
  // close it before the pointer ever reaches the form.
  //
  // Disabled outright once engagedRef is set — a field has had focus at
  // least once. Rechecking focus when the delay fires (rather than at the
  // moment the pointer left) already covers plain typing: a stray drift of
  // the mouse doesn't un-focus the field. But a saved-password suggestion or
  // the browser's own autofill dropdown is UA chrome, not a page element —
  // choosing one can report the pointer leaving to nothing at all (no
  // element to be "inside" wrapRef), which no amount of rechecking focus at
  // fire-time can tell apart from a genuine mouseleave if the click also
  // races a blur. Once the panel is actually being used, only a real signal
  // — an outside click, Escape, or focus handing off to a concrete element
  // elsewhere (below) — closes it; the pointer stops being consulted at all.
  const closeSoon = () => {
    if (engagedRef.current) return
    closeTimer.current = setTimeout(() => {
      if (!wrapRef.current?.contains(document.activeElement)) setOpen(false)
    }, 200)
  }
  // The other half: focus itself should keep the panel open independent of
  // the pointer (clicking a field, then moving the mouse away to type,
  // shouldn't be distinguishable from clicking it and leaving the mouse
  // right there), and losing focus to somewhere outside the panel — Tab past
  // the last field, not just a stray click — should close it the same way an
  // outside click already does.
  // Guarded on a REAL relatedTarget, not just "focus left" — autofill/the
  // password manager blur the field toward UA chrome with no relatedTarget
  // at all (it isn't a DOM node), and that used to read as "left the panel"
  // and close it out from under the very suggestion being clicked. Tab and
  // a real click elsewhere both hand off to an actual element, so this
  // still catches those.
  const onFocusWithin = () => {
    engagedRef.current = true
    openNow()
  }
  const onBlurWithin = (e) => {
    if (e.relatedTarget && !wrapRef.current?.contains(e.relatedTarget)) {
      closeTimer.current = setTimeout(() => setOpen(false), 200)
    }
  }

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => e.key === 'Escape' && setOpen(false)
    const onDocClick = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDocClick)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDocClick)
    }
  }, [open])

  useEffect(() => () => closeTimer.current && clearTimeout(closeTimer.current), [])

  return (
    <div
      ref={wrapRef}
      className="land-signin-wrap"
      onMouseEnter={openNow}
      onMouseLeave={closeSoon}
      onFocus={onFocusWithin}
      onBlur={onBlurWithin}
    >
      <button
        type="button"
        className="land-signin"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((o) => !o)}
      >
        Sign in
      </button>
      {open ? (
        <div className="land-signin-pop" role="dialog" aria-label="Sign in">
          <SignInForm compact idPrefix="land-" onClose={() => setOpen(false)} />
        </div>
      ) : null}
    </div>
  )
}

export function LandingPage() {
  useDocumentTitle('Lesson plans, cited to the standard')
  const navigate = useNavigate()
  const [pricing, setPricing] = useState(null)
  const [proofRef, proofInView] = useInView()
  const [pipelineRef, pipelineInView] = useInView()
  const [mechRef, mechInView] = useInView()
  const landRef = useRef(null)
  const [barHidden, setBarHidden] = useState(false)

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

  /* Was permanently pinned (position: sticky just keeps it AT the top once
     scrolled there — it never actually leaves, sticky alone doesn't hide
     anything), which on a page this long meant the bar sat over content for
     the entire scroll. Now it hides on the way down and reappears the
     moment you reverse direction — the "give the page back, but hand the
     nav straight back on the way up" pattern most long pages use. A small
     dead zone (4px) around each scroll event ignores the sub-pixel jitter
     some trackpads/mice report as direction changes on an otherwise still
     page; snapping back to visible below 8px means it's never hidden while
     sitting at the very top. */
  useEffect(() => {
    const el = landRef.current
    if (!el) return undefined
    let lastY = el.scrollTop
    const onScroll = () => {
      const y = el.scrollTop
      const delta = y - lastY
      if (y < 8) setBarHidden(false)
      else if (delta > 4) setBarHidden(true)
      else if (delta < -4) setBarHidden(false)
      lastY = y
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <div className="land" ref={landRef}>
      <header className={`land-bar${barHidden ? ' land-bar--hidden' : ''}`}>
        <span className="land-brand">
          <VerifySeal className="land-brand-mark" />
          FlexEd Academy
        </span>
        <SignInPopover />
      </header>

      <section className="land-hero">
        <div className="land-blob" aria-hidden="true" />
        {/* .land-eyebrow already existed in base.css (the glass pill sized
            and positioned for exactly this spot, over the aurora blob) but
            had no caller — wired up here rather than inventing a new class.
            Honest about where the product actually is right now: several
            subjects' relevance floors are still unmeasured (README's own
            "Multi-subject" section) and onboarding itself only started
            working reliably today. A visitor deciding whether to trust this
            with real curriculum should know that going in, not discover it
            from a rough edge. */}
        <span className="land-eyebrow">Early access</span>
        <h1 className="land-title">A week of lesson plans, cited to the standard</h1>
        <p className="land-sub">
          Generated from the verbatim text of the Alabama Course of Study — not a model's
          memory of it. Downloads as your district's own .docx.
        </p>
        <div className="land-actions">
          <Link
            to="/signup"
            className="land-cta"
            onClick={(event) => handleViewTransitionNavigation(event, navigate, '/signup')}
          >
            Join early access
            <ArrowIcon />
          </Link>
          <span className="land-note">Built by an Alabama high school teacher</span>
        </div>
        {pricing ? <p className="land-price">{pricing}</p> : null}
      </section>

      <section ref={proofRef} className={`land-proof${proofInView ? ' is-inview' : ''}`}>
        <h2 className="land-heading">Every line cites where it came from.</h2>
        <div className="land-excerpt">
          <div className="land-excerpt-plan">
            <div>
              <span className="land-tag">Lesson plan line</span>
              <p className="land-quote">
                Monday — Students annotate rhetorical shifts in paired excerpts, then draft a
                claim connecting tone to purpose.
                <sup className="land-cite">1</sup>
              </p>
            </div>
          </div>
          {/* A bundle converging on a single junction, not one bare line —
              the mechanism isn't "text points at text," it's several
              things (the phrase, the code, the source) resolving to one
              checked match. Each strand still gets the same scroll-triggered
              draw-in as the original single path (see .land-connector path
              below); the node itself fades in once they've all arrived. */}
          <svg className="land-connector" viewBox="0 0 200 90" preserveAspectRatio="none" aria-hidden="true">
            <path className="land-connector-line" d="M6 4 C 80 4, 92 40, 100 45" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <path className="land-connector-line" d="M6 14 C 90 14, 96 42, 100 45" fill="none" stroke="currentColor" strokeWidth="2" />
            <path className="land-connector-line" d="M6 24 C 80 24, 92 44, 100 45" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <path className="land-connector-line" d="M100 45 C 104 46, 114 68, 194 68" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <path className="land-connector-line" d="M100 45 C 104 45, 110 76, 194 76" fill="none" stroke="currentColor" strokeWidth="2" />
            <path className="land-connector-line" d="M100 45 C 104 44, 114 84, 194 84" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <circle cx="100" cy="45" r="3" className="land-connector-node" />
          </svg>
          <div className="land-excerpt-source">
            <VerifySeal className="land-seal land-seal--source" />
            <div>
              <span className="land-tag land-tag--cited">Cited standard</span>
              <p className="land-quote">
                ELA Reading Standard 4.B — Reading: explain how word choice and syntax convey tone.
              </p>
              <span className="land-loc">source_docs/ELAReadingStandards.pdf, p. 6</span>
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
          Grades 9–12 across all Alabama Course of Study subjects are in the corpus.
        </p>
      </section>

      <section ref={mechRef} className={`land-mech${mechInView ? ' is-inview' : ''}`}>
        <h2 className="land-heading">One pass through the mechanism.</h2>
        <div className="land-mech-steps">
          <div className="land-mech-step">
            <span className="land-tag">Retrieved</span>
            <p className="land-quote">
              ELA Reading Standard 4.B — Reading: explain how{' '}
              <mark className="land-mark">word choice and syntax convey tone</mark>.
            </p>
            <span className="land-loc">source_docs/ELAReadingStandards.pdf, p. 6</span>
          </div>
          <ArrowIcon className="land-mech-arrow" />
          <div className="land-mech-step">
            <span className="land-tag land-tag--cited">Generated</span>
            <p className="land-quote">
              Monday — Students annotate rhetorical shifts in paired excerpts, then draft a
              claim connecting <mark className="land-mark">tone</mark> to purpose.
            </p>
          </div>
          <ArrowIcon className="land-mech-arrow" />
          <div className="land-mech-step land-mech-step--audit">
            <VerifySeal className="land-seal" />
            <p>Matched to the retrieved standard. Nothing flagged.</p>
          </div>
        </div>
      </section>

      <footer className="land-foot">
        <Link
          to="/signup"
          className="land-foot-cta"
          onClick={(event) => handleViewTransitionNavigation(event, navigate, '/signup')}
        >
          Join early access
          <ArrowIcon />
        </Link>
        <div className="land-foot-legal mt-4 flex-col gap-2">
          <div className="flex gap-4 justify-center">
            <Link to="/privacy">Privacy Policy</Link>
            <Link to="/terms">Terms of Service</Link>
            <Link to="/beta">Beta</Link>
          </div>
          <span className="text-[10px] text-ink-muted/50 max-w-lg text-center mt-2 leading-relaxed">
            AP®, Pre-AP®, and College Board® are trademarks registered by the College Board, which is not affiliated with, and does not endorse, this product. ACT® is a registered trademark of ACT, Inc.
          </span>
        </div>
        
      </footer>
    </div>
  )
}
