import { Loader2, Undo2 } from 'lucide-react'
import '../styles/lesson-change-receipt.css'

export function LessonChangeReceipt({ feedback, busy }) {
  if (!feedback?.receipt) return null
  return <div className="lesson-change-receipt">
    <div><span role="status">{feedback.receipt.label}</span><button type="button" onClick={feedback.undo} disabled={busy || feedback.blocked || feedback.undoing} aria-label="Undo voice lesson change">{feedback.undoing ? <Loader2 size={13} className="animate-spin" /> : <Undo2 size={13} />}Undo</button></div>
    {feedback.error ? <p role="alert">{feedback.error}</p> : null}
  </div>
}
