import { createContext, useContext } from 'react'

/* Context and hook live apart from the provider component so the module exports
   only functions — otherwise Fast Refresh can't hot-swap the file. */
export const VoiceContext = createContext(null)

export function useVoice() {
  const ctx = useContext(VoiceContext)
  if (!ctx) throw new Error('useVoice must be used inside <VoiceProvider>')
  return ctx
}
