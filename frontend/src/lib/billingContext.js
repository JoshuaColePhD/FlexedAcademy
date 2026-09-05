import { createContext, useContext } from 'react'

/** { entitlement, mayGenerate, openPaywall, startCheckout, subscribe, manage, busy }
 *  — see components/BillingProvider.jsx. */
export const BillingContext = createContext(null)

export function useBilling() {
  const ctx = useContext(BillingContext)
  if (!ctx) throw new Error('useBilling() called outside <BillingProvider>')
  return ctx
}
