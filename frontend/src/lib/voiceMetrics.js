/* Per-turn timing from voice events. The endpoint is WebRTC's output-buffer
 * started event, a transport measurement rather than proof of audible playback
 * at the teacher's speaker. Device buffering and autoplay can add delay.
 *
 * endToEnd: speech stopped -> first output starts
 * stt: speech stopped -> final transcript
 * llmTtft: final transcript -> first grounded reply token
 * ttsTtfb: first queued sentence -> output starts
 *
 * Content-free samples are reported for real sessions. Synthetic preview
 * responses are excluded by the provider. No transcript, audio, or teacher identifiers enter these samples.
 */

const LIMIT = 200

/* A turn under construction. Marks accumulate as the pipeline progresses; the
   turn is flushed when the first audio of the reply is scheduled, because that
   is the moment the teacher stops waiting. */
let current = null

const turns = []
let reporter = null
export function setReporter(report) { reporter = report }
function report(sample) {
  try { reporter?.(sample)?.catch?.(() => {}) } catch { /* telemetry never blocks voice */ }
}

function nowMs() {
  return performance.now()
}

/** Teacher stopped talking — the clock starts here, not when we got a
 *  transcript. Everything after this point is latency they sit through. */
export function turnStarted() {
  current = { t0: nowMs() }
}

/** A transcript came back. */
export function transcriptReady() {
  if (current) current.sttAt = nowMs()
}

/** The model produced its first token. */
export function firstToken() {
  if (current && current.firstTokenAt == null) current.firstTokenAt = nowMs()
}

/** A sentence was handed to the TTS queue. Only the first one of a turn
 *  matters for latency — later ones are already covered by audio playing. */
export function sentenceQueued() {
  if (current && current.queuedAt == null) current.queuedAt = nowMs()
}

/** First audio of the reply is on the timeline. The teacher's wait is over,
 *  so this closes the turn and records it. */
export function firstAudio() {
  if (!current || current.done) return
  current.done = true
  const t = current
  const rec = {
    endToEnd: Math.round(nowMs() - t.t0),
    stt: t.sttAt != null ? Math.round(t.sttAt - t.t0) : null,
    llmTtft: t.firstTokenAt != null && t.sttAt != null ? Math.round(t.firstTokenAt - t.sttAt) : null,
    ttsTtfb: t.queuedAt != null ? Math.round(nowMs() - t.queuedAt) : null,
  }
  report({ outcome: 'completed', duration_ms: rec.endToEnd,
    stt_ms: rec.stt, llm_ms: rec.llmTtft, speech_ms: rec.ttsTtfb })
  turns.push(rec)
  if (turns.length > LIMIT) turns.shift()
  current = null

  /* One line per turn, not a group — a voice conversation is a dozen turns and
     collapsible groups would bury the trend this is meant to expose. */
  // eslint-disable-next-line no-console
  console.info(
    `[voice] turn ${turns.length}  end-to-end ${rec.endToEnd}ms` +
      `  (stt ${rec.stt ?? '–'}  llm-ttft ${rec.llmTtft ?? '–'}  tts-ttfb ${rec.ttsTtfb ?? '–'})`
  )
}

/** The turn was abandoned — barge-in, an error, a closed panel. Dropped rather
 *  than recorded: a turn nobody waited for the end of is not a latency sample,
 *  and leaving it open would attribute the next turn's wait to this one. */
export function turnAbandoned(outcome = 'cancelled') {
  if (current) report({ outcome, duration_ms: Math.round(nowMs() - current.t0) })
  current = null
}

function pct(values, p) {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

/** Percentiles for the session so far, printed and returned. */
export function stats() {
  if (!turns.length) {
    // eslint-disable-next-line no-console
    console.info('[voice] no completed turns yet')
    return null
  }
  const of = (k) => turns.map((t) => t[k]).filter((v) => v != null)
  const summarise = (k) => {
    const v = of(k)
    return v.length ? { n: v.length, p50: pct(v, 50), p95: pct(v, 95), max: Math.max(...v) } : null
  }
  const out = {
    turns: turns.length,
    endToEnd: summarise('endToEnd'),
    stt: summarise('stt'),
    llmTtft: summarise('llmTtft'),
    ttsTtfb: summarise('ttsTtfb'),
  }
  // eslint-disable-next-line no-console
  console.table({
    'end-to-end': out.endToEnd,
    'stt': out.stt,
    'llm ttft': out.llmTtft,
    'tts ttfb': out.ttsTtfb,
  })
  return out
}

/* Reachable from the devtools console without importing anything, which is the
   entire point: `__voiceStats()` after a real conversation answers the question
   this module exists for. */
if (typeof window !== 'undefined') {
  window.__voiceMetrics = turns
  window.__voiceStats = stats
}
