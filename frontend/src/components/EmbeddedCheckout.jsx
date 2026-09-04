import { useState } from 'react'
import { CheckoutElementsProvider, ExpressCheckoutElement, PaymentElement, useCheckoutElements } from '@stripe/react-stripe-js/checkout'
import { loadStripe } from '@stripe/stripe-js'
import { LockKeyhole, ShieldCheck, Sparkles, X } from 'lucide-react'

const publishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || ''
const stripePromise = publishableKey ? loadStripe(publishableKey) : null
const LOCAL_PREVIEW_SECRET = 'cs_test_mock_secret'

function CheckoutHeader({ onClose, priceLabel }) {
  return (
    <>
      <div className="checkout-header">
        <div className="checkout-brand">
          <span className="checkout-brand-mark"><Sparkles size={15} aria-hidden="true" /></span>
          <div>
            <p className="checkout-kicker">FlexEd Academy</p>
            <p className="checkout-flow-label">Monthly membership</p>
          </div>
        </div>
        <button type="button" className="checkout-close" onClick={onClose} aria-label="Close checkout">
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      <div className="checkout-summary">
        <div className="checkout-product-art" aria-hidden="true">
          <img src="/icon-512.png" alt="" />
        </div>
        <div className="checkout-summary-copy">
          <p className="checkout-summary-kicker">FlexEd Academy</p>
          <h2 id="checkout-title">Pay FlexEd Academy</h2>
          <p>More room for the lesson plans, activities, and ideas you build each week.</p>
        </div>
        <div className="checkout-price-card">
          <strong>{priceLabel || 'Your recurring subscription'}</strong>
          <span>Renews monthly</span>
        </div>
      </div>
    </>
  )
}

function LocalCheckoutPreview({ onClose, priceLabel }) {
  return (
    <>
      <CheckoutHeader onClose={onClose} priceLabel={priceLabel} />

      <div className="checkout-trust-line">
        <span className="checkout-trust-pill"><LockKeyhole size={13} aria-hidden="true" /> Secure Stripe checkout</span>
        <span>Cancel anytime</span>
      </div>

      <div className="checkout-preview-notice" role="status">
        <span className="checkout-preview-dot" aria-hidden="true" /> Preview mode — Stripe fields appear when connected.
      </div>

      <div className="checkout-form checkout-preview" aria-label="Payment form preview">
        <div className="checkout-payment-heading">
          <span>Choose a payment method</span>
          <span>Securely processed</span>
        </div>
        <div className="checkout-preview-express">
          <button type="button" className="checkout-preview-wallet">Apple Pay</button>
          <button type="button" className="checkout-preview-wallet">Google Pay</button>
          <button type="button" className="checkout-preview-wallet">Link</button>
        </div>
        <div className="checkout-divider"><span>or pay another way</span></div>
        <label className="checkout-preview-field">
          Email
          <input type="email" value="teacher@example.com" readOnly aria-label="Email preview" />
        </label>
        <label className="checkout-preview-field">
          Card information
          <div className="checkout-preview-card">
            <span>Card number</span>
            <span>MM / YY</span>
            <span>CVC</span>
          </div>
        </label>
        <button type="button" className="btn btn-primary checkout-submit" disabled>
          Subscribe · {priceLabel || 'monthly'}
        </button>
      </div>

      <p className="checkout-footnote">
        <ShieldCheck size={14} aria-hidden="true" />
        <span>Preview only — no payment details are collected.</span>
      </p>
    </>
  )
}

function CheckoutForm({ onClose, onPaymentSubmitted, onRetry, priceLabel }) {
  const result = useCheckoutElements()
  const [errorMessage, setErrorMessage] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const confirmCheckout = async () => {
    if (result.type !== 'success' || !result.checkout.canConfirm || isSubmitting) return
    setIsSubmitting(true)
    setErrorMessage('')
    try {
      const returnUrl = `${window.location.origin}${window.location.pathname}?checkout=return&session_id={CHECKOUT_SESSION_ID}`
      const confirmResult = await result.checkout.confirm({ returnUrl })
      if (confirmResult.type === 'error') {
        setErrorMessage(confirmResult.error.message || 'The payment could not be completed.')
        setIsSubmitting(false)
        return
      }
      onPaymentSubmitted()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'The payment could not be completed.')
      setIsSubmitting(false)
    }
  }

  if (result.type === 'loading') {
    return <div className="checkout-loading" role="status">Loading secure checkout…</div>
  }

  if (result.type === 'error') {
    return (
      <div className="checkout-error-state" role="alert">
        <p>{result.error.message || 'Secure checkout could not load.'}</p>
        <div className="checkout-error-actions">
          <button type="button" className="btn" onClick={onClose}>Close</button>
          <button type="button" className="btn btn-primary" onClick={onRetry}>Try again</button>
        </div>
      </div>
    )
  }

  const { checkout } = result
  return (
    <>
      <CheckoutHeader onClose={onClose} priceLabel={priceLabel} />

      <div className="checkout-trust-line">
        <span className="checkout-trust-pill"><LockKeyhole size={13} aria-hidden="true" /> Secure Stripe checkout</span>
        <span>Cancel anytime</span>
      </div>

      <form className="checkout-form" onSubmit={(event) => { event.preventDefault(); confirmCheckout() }}>
        <div className="checkout-payment-heading">
          <span>Choose a payment method</span>
          <span>Securely processed</span>
        </div>
        <div className="checkout-express">
          <ExpressCheckoutElement
            onConfirm={confirmCheckout}
            onLoadError={(event) => setErrorMessage(event.error.message || 'Express checkout is unavailable.')}
          />
        </div>
        <div className="checkout-divider"><span>or pay another way</span></div>
        <div className="checkout-payment-block">
          <PaymentElement
            options={{ layout: 'accordion' }}
            onChange={(event) => setErrorMessage(event.error?.message || '')}
          />
        </div>
        {errorMessage ? <p className="checkout-error" role="alert">{errorMessage}</p> : null}
        <button type="submit" className="btn btn-primary checkout-submit" disabled={!checkout.canConfirm || isSubmitting}>
          {isSubmitting ? 'Processing…' : `Subscribe · ${priceLabel || 'monthly'}`}
        </button>
      </form>

      <p className="checkout-footnote">
        <ShieldCheck size={14} aria-hidden="true" />
        <span>You can manage or cancel your subscription anytime from Billing.</span>
      </p>
    </>
  )
}

export function EmbeddedCheckout({ clientSecret, onClose, onPaymentSubmitted, onRetry, priceLabel }) {
  if (import.meta.env.DEV && clientSecret === LOCAL_PREVIEW_SECRET) {
    return <LocalCheckoutPreview onClose={onClose} priceLabel={priceLabel} />
  }

  if (!stripePromise) {
    return (
      <div className="checkout-error-state" role="alert">
        <p>Checkout is temporarily unavailable. Please try again shortly.</p>
        <button type="button" className="btn btn-primary" onClick={onClose}>Close</button>
      </div>
    )
  }

  return (
    <CheckoutElementsProvider
      stripe={stripePromise}
      options={{
        clientSecret,
        elementsOptions: {
          appearance: {
            theme: 'stripe',
            variables: {
              colorPrimary: '#2f5fbf',
              colorText: '#14161a',
              colorBackground: '#f6f4ec',
              borderRadius: '8px',
              fontFamily: 'Inter, system-ui, sans-serif',
            },
          },
        },
      }}
    >
      <CheckoutForm
        onClose={onClose}
        onPaymentSubmitted={onPaymentSubmitted}
        onRetry={onRetry}
        priceLabel={priceLabel}
      />
    </CheckoutElementsProvider>
  )
}
