/* Per-turn latency for voice mode, measured where the teacher actually
 * experiences it: in the browser.
 *
 * This exists because the honest answer to "is voice mode fast enough now" is a
 * measurement, and there wasn't one. LiveKit deliberately publishes no latency
 * table and tells you to instrument instead — their reasoning being that the
 * number depends on your models, your region and your architecture, so someone
 * else's figure tells you nothing about yours. The three names below are theirs,
 * kept verbatim so the numbers are comparable to anything published.
 *
 *   endToEnd  the whole thing: teacher stops talking -> first syllable back.
 *             This is THE number. Human conversation runs a ~200ms median gap;
 *             past ~300ms a silence starts reading as hesitation and past
 *             ~700ms as reluctance; production voice agents target ~800ms
 *             median. Anything over about 1500ms reads as broken.
 *   stt       stopped talking -> transcript in hand (upload + Whisper).
 *   llmTtft   transcript sent -> first token of the reply.
 *   ttsTtfb   first sentence handed to TTS -> its first audio scheduled.
 *
 * Deliberately console-and-memory rather than a telemetry pipeline. There is no
 * analytics infrastructure in this app to plug into, and inventing one to answer
 * a tuning question would be the wrong order of work. `window.__voiceMetrics`
 * holds the session's turns and `window.__voiceStats()` prints percentiles, so
 * the question is answerable from the devtools console after a real
 * conversation — which is all that's needed to decide whether the remaining
 * latency justifies moving to a realtime speech-to-speech model.
 */

const LIMIT = 200

/* A turn under construction. Marks accumulate as the pipeline progresses; the
   turn is flushed when the first audio of the reply is scheduled, because that
   is the moment the teacher stops waiting. */
let current = null

const turns = []

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
export function turnAbandoned() {
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
  const p50 = out.endToEnd?.p50
  if (p50 != null) {
    const read =
      p50 < 800
        ? 'at the production target (~800ms median)'
        : p50 < 1500
          ? 'usable, above target — worth another pass before considering realtime'
          : 'reads as broken to a listener; fix this before anything else'
    // eslint-disable-next-line no-console
    console.info(`[voice] median end-to-end ${p50}ms — ${read}`)
  }
  return out
}

/* Reachable from the devtools console without importing anything, which is the
   entire point: `__voiceStats()` after a real conversation answers the question
   this module exists for. */
if (typeof window !== 'undefined') {
  window.__voiceMetrics = turns
  window.__voiceStats = stats
}
