import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Check } from 'lucide-react'
import { BillingContext } from '../lib/billingContext'
import { useAuth } from '../lib/authContext'
import { useToast } from '../lib/toastContext'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { api } from '../lib/api'

/* The paywall, and everything that decides when to show it.
 *
 * The entitlement itself is not fetched here — it rides on /api/auth/me, so
 * the answer the UI branches on is the same answer the server enforces. This
 * provider adds three things around it: a way to open the dialog, the two
 * Stripe redirects, and the "you're back from checkout" handling.
 *
 * That last one is worth a note. Returning from Stripe, the browser lands on
 * ?checkout=success — but the *webhook* is what actually grants access, and it
 * can land a second or two later. So this refetches, and if the subscription
 * hasn't arrived yet it retries a few times before giving up, rather than
 * showing a paid-up teacher a paywall.
 */

const PENDING_RETRIES = 6
const RETRY_MS = 1500

function formatPrice(price) {
  if (!price?.amount) return null
  const money = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: price.currency || 'USD',
    minimumFractionDigits: price.amount % 100 === 0 ? 0 : 2,
  }).format(price.amount / 100)
  if (!price.interval) return money
  const every = price.interval_count > 1 ? `${price.interval_count} ${price.interval}s` : price.interval
  return `${money} / ${every}`
}

export function BillingProvider({ children }) {
  const { user, refresh } = useAuth()
  const toast = useToast()
  const navigate = useNavigate()
  const location = useLocation()

  const [open, setOpen] = useState(false)
  const [price, setPrice] = useState(null)
  const [busy, setBusy] = useState(false)
  const dialogRef = useRef(null)
  const subscribeRef = useRef(null)

  const entitlement = user?.entitlement ?? null
  // Absent entitlement means an older server or a page that hasn't loaded the
  // user yet. Both should let the teacher work — a paywall that appears
  // because a fetch was slow is worse than a request the server will refuse.
  const mayGenerate = entitlement ? entitlement.may_generate : true
  const billingEnabled = !!entitlement?.billing_enabled

  const openPaywall = useCallback(() => setOpen(true), [])

  // The price is only needed once the dialog is up, and only when billing is
  // live at all — no request on every page load.
  useEffect(() => {
    if (!open || !billingEnabled || price) return
    let cancelled = false
    api
      .billing()
      .then((b) => !cancelled && setPrice(b.price || null))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [open, billingEnabled, price])

  useFocusTrap(dialogRef, {
    active: open,
    trap: true,
    initialFocus: subscribeRef,
    onEscape: () => setOpen(false),
  })

  const subscribe = useCallback(async () => {
    setBusy(true)
    try {
      const { url } = await api.checkout()
      window.location.assign(url)
    } catch (err) {
      setBusy(false)
      toast.error(err.message || 'Couldn’t open checkout.')
    }
  }, [toast])

  const manage = useCallback(async () => {
    setBusy(true)
    try {
      const { url } = await api.billingPortal()
      window.location.assign(url)
    } catch (err) {
      setBusy(false)
      toast.error(err.message || 'Couldn’t open the billing portal.')
    }
  }, [toast])

  /* Back from Stripe. */
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const outcome = params.get('checkout')
    if (!outcome) return

    // Clear the marker first, so a reload doesn't replay this.
    params.delete('checkout')
    const qs = params.toString()
    navigate({ pathname: location.pathname, search: qs ? `?${qs}` : '' }, { replace: true })

    if (outcome === 'cancelled') {
      toast.info('No changes were made — nothing was charged.')
      return
    }

    /* `navigate()` above strips the marker from the URL, which changes
       location.search and re-triggers THIS SAME EFFECT — the new run sees
       outcome=null and no-ops, but its cleanup used to fire against a `timer`
       variable that was still null at that exact instant (poll()'s first
       `await` hadn't resolved yet), so clearTimeout(null) cleared nothing and
       every retry scheduled afterward was orphaned from any effect's
       lifecycle. `cancelled` is checked on every tick instead of depending on
       a timer id existing at the moment cleanup happens to run. */
    let cancelled = false
    let attempts = 0
    const poll = async () => {
      const u = await refresh().catch(() => null)
      if (cancelled) return
      if (u?.entitlement?.subscribed) {
        setOpen(false)
        toast.success('You’re subscribed. Build away.')
        return
      }
      if (++attempts >= PENDING_RETRIES) {
        toast.info('Payment received — access will unlock in a moment. Reload if it doesn’t.')
        return
      }
      setTimeout(poll, RETRY_MS)
    }
    poll()
    return () => {
      cancelled = true
    }
    // location.search is the trigger; the callbacks are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search])

  const priceLabel = formatPrice(price)
  /* Same reasoning as ConfirmProvider/ToastProvider: this sits above <Gate/>
     (see App.jsx), so the paywall renders as AppShell's sibling and never
     sees .neo-world's redeclared tokens on its own — scope by the same
     /c/* boundary AppShell itself uses. The paywall can only ever open from
     inside the authenticated app anyway (openPaywall has no other caller),
     but the route check keeps this consistent with the other two providers
     rather than assuming that stays true. */
  const isNeo = location.pathname.startsWith('/c/')

  return (
    <BillingContext.Provider
      value={{ entitlement, mayGenerate, billingEnabled, openPaywall, subscribe, manage, busy }}
    >
      {children}
      {open ? (
        <div
          className="dialog-scrim"
          onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
        >
          <div
            className={`dialog${isNeo ? ' neo-world' : ''}`}
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="paywall-title"
            aria-describedby="paywall-body"
          >
            <h2 id="paywall-title">You’ve reached this week’s usage limit</h2>
            <p id="paywall-body">
              It resets on a rolling week, or subscribe now for a much higher
              limit{priceLabel ? ` — ${priceLabel}` : ''}. Everything you’ve already
              made stays yours either way.
            </p>
            <ul className="mb-4 mt-1 space-y-1.5 text-xs text-ink-soft">
              {[
                'A much higher weekly usage limit',
                'Grounded in your standards and your pacing guide',
                'Cancel any time, from your account',
              ].map((line) => (
                <li key={line} className="flex items-start gap-2">
                  <Check size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-ink-faint" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={() => setOpen(false)}>
                Not now
              </button>
              <button
                type="button"
                className="btn btn-primary"
                ref={subscribeRef}
                onClick={subscribe}
                disabled={busy}
              >
                {busy ? 'Opening…' : 'Subscribe'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </BillingContext.Provider>
  )
}
