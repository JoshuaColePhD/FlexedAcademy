/* SSE lifecycle code -> the line the teacher actually reads.
 *
 * The stream already reports connecting -> queued -> preparing_context ->
 * research_ready -> context_ready -> thinking, and none of it reached the
 * transcript: the codes were forwarded only to updateActiveWorkActivity, which
 * does nothing on an ordinary conversational turn because no work card exists.
 * So a twelve-second reply showed one unchanging "Hmm, okay…" and no evidence
 * anything was happening.
 *
 * The rule here is to override the personality label from chatThinking.js ONLY
 * when the phase tells the teacher something. "connecting", "accepted" and
 * "thinking" do not — they are machine phases, and replacing a colleague's
 * voice with them would be a downgrade. "preparing_context" and
 * "research_ready" do.
 */
const PHASE_COPY = {
  queued: 'Waiting for a free slot',
  preparing_context: 'Reading your class context',
  research_ready: 'Sources are in',
  retrieval: 'Looking through your materials',
  still_working: 'Still working',
  retrying: 'Trying that again',
}

/** The status line for this frame, or the personality label when the phase
 *  has nothing worth saying. */
export function chatStatusLabel(code, fallback) {
  return PHASE_COPY[String(code || '')] || fallback
}

export default chatStatusLabel
