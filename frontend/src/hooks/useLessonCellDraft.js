import { useEffect, useRef, useState } from 'react'
import { orderedDays } from '../lib/planShape'

// A conversation receipt can open a field without going through its click
// handler. Seed that editor too, while preserving typing on ordinary renders.
export function useLessonCellDraft(plan, missingDays, openTweak) {
  const [draft, setDraft] = useState('')
  const selected = useRef(null)
  useEffect(() => {
    const key = openTweak ? `${openTweak.dayIndex}:${openTweak.field}` : null
    if (key === selected.current) return
    selected.current = key
    const value = key && plan
      ? orderedDays(plan, missingDays)[openTweak.dayIndex]?.[openTweak.field]
      : ''
    setDraft(Array.isArray(value) ? value.join('\n') : String(value || ''))
  }, [plan, missingDays, openTweak])
  return [draft, setDraft]
}
