import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { api } from '../lib/api'

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
 *
 * The price is FETCHED, not written here. This page invites a signup, so it
 * owes the visitor the sentence about what happens after the free week — and
 * a number typed into this file is a number that goes stale the first time the
 * price changes, on the one page where being wrong about money is worst. Until
 * Stripe is configured the endpoint returns null and the line is simply
 * absent, which is the honest thing to say when there is no price yet.
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
export function LandingPage() {
  useDocumentTitle('Lesson planning, grounded')
  const [pricing, setPricing] = useState(null)

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

        {pricing ? <p className="landing-price">{pricing}</p> : null}
      </main>

      <footer className="landing-foot">
        <span>Grades 9–12 · Alabama Course of Study</span>
        <span>Every code traces to a real document</span>
        <span>Florence, Alabama</span>
      </footer>
    </div>
  )
}
