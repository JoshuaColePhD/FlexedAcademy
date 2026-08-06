import { useEffect } from 'react'

/* The tab title was the constant string "Lesson Plans".
 *
 * A teacher planning three preps has this open several times over, and every
 * tab looked identical. The week is the thing that distinguishes them, so the
 * week goes first — a tab strip truncates from the right. */
export function useDocumentTitle(title) {
  useEffect(() => {
    document.title = title ? `${title} — Flexed Academy` : 'Flexed Academy'
    return () => {
      document.title = 'Flexed Academy'
    }
  }, [title])
}
