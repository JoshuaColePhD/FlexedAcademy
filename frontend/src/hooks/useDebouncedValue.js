import { useEffect, useState } from 'react'

/* The Standards filter refetched on every keystroke — nine requests for "reading"
   — so this trails the value instead. Paired with useAsync's abort, typing fast
   now costs one request rather than one per character. */
export function useDebouncedValue(value, delay = 250) {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    if (value === debounced) return undefined
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, delay])

  return debounced
}
