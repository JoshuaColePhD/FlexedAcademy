import { createContext, useContext } from 'react'

/* Same split as toastContext: context and hook apart from the provider component
   so the module exports only functions and Fast Refresh can hot-swap it. */
export const ConfirmContext = createContext(null)

export function useConfirm() {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error('useConfirm must be used inside <ConfirmProvider>')
  return ctx
}
