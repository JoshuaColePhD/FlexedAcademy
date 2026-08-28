import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { LegalLayout } from './LegalLayout'

/* What the hero's "Beta" pill (LandingPage.jsx's own .land-eyebrow) actually
 * means, spelled out rather than left as an unexplained badge. Reflects
 * what's genuinely true today — not marketing copy softened to sound more
 * finished than it is. Update this alongside anything that changes how
 * stable the product actually is.
 */
export function BetaPage() {
  useDocumentTitle('Beta')
  return (
    <LegalLayout title="This is Beta" updated="August 28, 2026">
      <p>
        FlexEd Academy just opened up, and it's genuinely still stabilizing. "Beta" isn't a
        formality here — it's an honest description of where the product is.
      </p>

      <section>
        <h2 className="text-base font-semibold text-ink">What that means in practice</h2>
        <p className="mt-2">
          The core loop — a week of lesson plans, cited to your state's actual course of
          study — is solid, and it's what I use every week in my own classroom. But not every
          subject has been checked as thoroughly as the ones I teach myself, onboarding is new,
          and you may run into a rough edge here and there while I keep working on it.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">Why open it up now instead of waiting</h2>
        <p className="mt-2">
          Because the fastest way to find what's actually broken — versus what I only assume
          might be — is real teachers using it on real weeks. Every report makes the next
          version better for everyone after you.
        </p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-ink">Questions, bugs, or something looks wrong</h2>
        <p className="mt-2">
          Email me directly at{' '}
          <a href="mailto:joshuacolephd@gmail.com" className="text-accent-text hover:underline">
            joshuacolephd@gmail.com
          </a>
          . If a lesson plan cites something that isn't actually in your course of study, that's
          exactly the kind of thing I want to hear about — it's the one thing this product is
          supposed to get right every time.
        </p>
      </section>
    </LegalLayout>
  )
}
