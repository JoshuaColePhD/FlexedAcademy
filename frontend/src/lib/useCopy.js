import { useState } from 'react'

/** Copy-to-clipboard with a short-lived confirmation.
 *
 * Shared by the message action row and by each code block's own copy button,
 * so both confirm the same way and for the same 1.6s.
 */
export function useCopy() {
  const [copied, setCopied] = useState(false)
  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard blocked (insecure context) — the button just won't confirm.
    }
  }
  return { copied, copy }
}

export default useCopy
