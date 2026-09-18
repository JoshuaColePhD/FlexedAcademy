import { CreditCard, LogOut, ShieldCheck, Sparkles } from 'lucide-react'

/**
 * The authenticated app's terminal subscription state. This intentionally
 * replaces the workspace rather than sitting over it: a teacher whose access
 * has ended should see one calm next step, not a live-looking app where every
 * attempt to work fails afterward.
 */
export function SubscriptionAccessScreen({ priceLabel, busy, onSubscribe, onSignOut }) {
  return (
    <main className="subscription-access-screen" aria-labelledby="subscription-access-title">
      <section className="subscription-access-card">
        <div className="subscription-access-mark" aria-hidden="true"><Sparkles size={23} /></div>
        <p className="subscription-access-eyebrow">FlexEd Academy</p>
        <h1 id="subscription-access-title">Your access has ended</h1>
        <p className="subscription-access-copy">
          Your lessons, plans, and course context are still here. Subscribe to continue building without losing your work.
        </p>

        <div className="subscription-access-plan">
          <div>
            <span>FlexEd membership</span>
            <small>Monthly · cancel anytime</small>
          </div>
          <strong>{priceLabel || '$7.99 / month'}</strong>
        </div>

        <ul className="subscription-access-benefits">
          <li><ShieldCheck size={16} aria-hidden="true" /> Keep your existing lessons and plans</li>
          <li><ShieldCheck size={16} aria-hidden="true" /> Build grounded plans with your standards</li>
          <li><ShieldCheck size={16} aria-hidden="true" /> Manage or cancel anytime from Billing</li>
        </ul>

        <button type="button" className="btn btn-primary subscription-access-cta" onClick={onSubscribe} disabled={busy}>
          <CreditCard size={16} aria-hidden="true" />
          {busy ? 'Opening secure checkout…' : 'Continue to secure checkout'}
        </button>
        <button type="button" className="subscription-access-signout" onClick={onSignOut} disabled={busy}>
          <LogOut size={15} aria-hidden="true" /> Sign out
        </button>
      </section>
    </main>
  )
}
