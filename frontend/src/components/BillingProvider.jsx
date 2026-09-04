import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Check, LockKeyhole, Sparkles } from 'lucide-react'
import { BillingContext } from '../lib/billingContext'
import { useAuth } from '../lib/authContext'
import { useToast } from '../lib/toastContext'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { api } from '../lib/api'
import { EmbeddedCheckout } from './EmbeddedCheckout'

/* The paywall, and everything that decides when to show it.
 *
 * The entitlement itself is not fetched here — it rides on /api/auth/me, so
 * the answer the UI branches on is the same answer the server enforces. This
 * provider adds three things around it: a way to open the dialog, the
 * embedded/hosted checkout flows, and the "you're back from checkout"
 * handling.
 *
 * That last one is worth a note. Returning from Stripe, the browser lands on
 * a checkout marker — but the *webhook* is what actually grants access, and it
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
  const [checkoutClientSecret, setCheckoutClientSecret] = useState('')
  const [checkoutSessionId, setCheckoutSessionId] = useState('')
  const dialogRef = useRef(null)
  const subscribeRef = useRef(null)

  const entitlement = user?.entitlement ?? null
  // Absent entitlement means an older server or a page that hasn't loaded the
  // user yet. Both should let the teacher work — a paywall that appears
  // because a fetch was slow is worse than a request the server will refuse.
  const mayGenerate = entitlement ? entitlement.may_generate : true
  const billingEnabled = !!entitlement?.billing_enabled

  const openPaywall = useCallback(() => setOpen(true), [])

  const closeCheckout = useCallback(() => {
    setCheckoutClientSecret('')
    setCheckoutSessionId('')
    setBusy(false)
    setOpen(false)
  }, [])

  // Load the price as soon as billing is available so Settings can show the
  // exact recurring amount before a teacher opens Checkout, not after they
  // have already committed to the upgrade path.
  useEffect(() => {
    if (!billingEnabled || price) return
    let cancelled = false
    api
      .billing()
      .then((b) => {
        if (cancelled) return
        setPrice(b.price || null)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [open, billingEnabled, price])

  useFocusTrap(dialogRef, {
    active: open,
    trap: true,
    initialFocus: subscribeRef,
    onEscape: () => (checkoutClientSecret ? closeCheckout() : setOpen(false)),
  })

  const pollForSubscription = useCallback(() => {
    let attempts = 0
    const poll = async () => {
      const u = await refresh().catch(() => null)
      if (unmountedRef.current) return
      if (u?.entitlement?.subscribed) {
        closeCheckout()
        toast.success('You’re subscribed. Build away.')
        return
      }
      if (++attempts >= PENDING_RETRIES) {
        setBusy(false)
        toast.info('Payment received — access will unlock in a moment. Reload if it doesn’t.')
        return
      }
      setTimeout(poll, RETRY_MS)
    }
    poll()
  }, [closeCheckout, refresh, toast])

  const subscribe = useCallback(async () => {
    setBusy(true)
    try {
      const session = await api.checkoutSession()
      if (!session.client_secret) throw new Error('Checkout could not be initialized.')
      setCheckoutSessionId(session.session_id || '')
      setCheckoutClientSecret(session.client_secret)
      setBusy(false)
    } catch (err) {
      setBusy(false)
      toast.error(err.message || 'Couldn’t open checkout.')
    }
  }, [toast])

  const retryCheckout = useCallback(() => {
    setCheckoutClientSecret('')
    setCheckoutSessionId('')
    subscribe()
  }, [subscribe])

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

  const cancelSubscription = useCallback(async () => {
    setBusy(true)
    try {
      const result = await api.cancelSubscription()
      await refresh()
      const end = result.period_end
        ? new Date(result.period_end).toLocaleDateString()
        : null
      toast.success(
        'Subscription canceled',
        end ? `You’ll keep access through ${end}.` : 'It will not renew again.',
      )
      return result
    } catch (err) {
      toast.error(err.message || 'Couldn’t cancel the subscription.')
      return null
    } finally {
      setBusy(false)
    }
  }, [refresh, toast])

  // True unmount only — NOT "this effect's own deps changed," which is what
  // the poll effect below used to (mis)use a closure-local `cancelled` flag
  // for. See that effect's own comment for why the distinction matters.
  // Resetting to false in the setup phase (not just true in cleanup)
  // matters even though this effect's own deps never change: StrictMode's
  // dev-only mount→cleanup→mount simulation runs this cleanup once for
  // real, and without the reset that leaves unmountedRef permanently true
  // from nearly the first render on — which silently killed every poll
  // below in exactly the same "no toast, no recovery" way the bug this
  // ref was meant to fix did.
  const unmountedRef = useRef(false)
  useEffect(() => {
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
    }
  }, [])

  /* Back from Stripe. */
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const outcome = params.get('checkout')
    if (!outcome) return

    // Clear the marker first, so a reload doesn't replay this.
    params.delete('checkout')
    params.delete('session_id')
    const qs = params.toString()
    navigate({ pathname: location.pathname, search: qs ? `?${qs}` : '' }, { replace: true })

    if (outcome === 'cancelled') {
      toast.info('No changes were made — nothing was charged.')
      return
    }

    /* The marker is used by both the retained hosted flow and the embedded
       custom Checkout Session. The webhook, not this browser return, grants
       the entitlement, so both paths use the same retry loop. */
    pollForSubscription()
    // location.search is the trigger; pollForSubscription is memoized.
  }, [location.pathname, location.search, navigate, pollForSubscription, toast])

  const priceLabel = formatPrice(price)
  const trialExpired = !!entitlement?.trial_expired
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
      value={{ entitlement, mayGenerate, billingEnabled, priceLabel, openPaywall, subscribe, manage, cancelSubscription, busy }}
    >
      {children}
      {open ? (
        <div
          className="dialog-scrim"
          onMouseDown={(e) => e.target === e.currentTarget && (checkoutClientSecret ? closeCheckout() : setOpen(false))}
        >
          <div
            className={`dialog${isNeo ? ' neo-world' : ''}${checkoutClientSecret ? ' dialog-checkout' : ''}`}
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby={checkoutClientSecret ? 'checkout-title' : 'paywall-title'}
            aria-describedby={checkoutClientSecret ? undefined : 'paywall-body'}
          >
            {checkoutClientSecret ? (
              <EmbeddedCheckout
                key={checkoutSessionId || checkoutClientSecret}
                clientSecret={checkoutClientSecret}
                priceLabel={priceLabel}
                onClose={closeCheckout}
                onRetry={retryCheckout}
                onPaymentSubmitted={() => {
                  closeCheckout()
                  pollForSubscription()
                }}
              />
            ) : (
              <>
                <div className="flex items-start gap-3">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-accent/10 text-accent-text">
                    <Sparkles size={18} aria-hidden="true" />
                  </span>
                  <div>
                    <p className="text-2xs font-semibold uppercase tracking-[0.16em] text-ink-muted">FlexEd upgrade</p>
                    <h2 id="paywall-title" className="mt-1">{trialExpired ? 'Keep building with FlexEd' : 'Unlock higher weekly limits'}</h2>
                  </div>
                </div>
                <p id="paywall-body" className="mt-3 text-sm leading-relaxed text-ink-soft">
                  {trialExpired
                    ? 'Your free access has ended. Subscribe to keep building grounded lesson plans without starting over.'
                    : 'Get more room to plan each week while keeping your standards and school context in every plan.'}
                </p>
                <div className="mt-4 rounded-2xl border border-edge/70 bg-paper-sunken p-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs font-semibold text-ink">FlexEd subscription</span>
                    <span className="text-sm font-bold text-ink">{priceLabel || 'Loading price…'}</span>
                  </div>
                  <p className="mt-1 text-2xs text-ink-muted">Higher weekly usage limits · Cancel anytime</p>
                </div>
                <ul className="mt-4 space-y-2 text-xs text-ink-soft">
                  {[
                    'A much higher weekly usage limit',
                    'Grounded in your standards and pacing guide',
                    'Everything you’ve already made stays yours',
                  ].map((line) => (
                    <li key={line} className="flex items-start gap-2">
                      <Check size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-ok" />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-4 flex items-center gap-1.5 text-2xs text-ink-muted">
                  <LockKeyhole size={13} className="text-ok" aria-hidden="true" />
                  Secure payment handled by Stripe
                </p>
                <div className="dialog-actions mt-5">
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
              </>
            )}
          </div>
        </div>
      ) : null}
    </BillingContext.Provider>
  )
}
