import { createContext, useContext } from 'react'

/* Context and hook live apart from the provider component so the module exports
   only functions — otherwise Fast Refresh can't hot-swap the file. */
export const ToastContext = createContext(null)

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>')
  return ctx
}
