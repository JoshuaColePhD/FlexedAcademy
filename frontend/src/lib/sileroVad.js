/* Silero VAD — a real speech/not-speech classifier, replacing the guess that an
 * RMS level makes.
 *
 * WHY, in one number: in a controlled comparison at a 50ms window, RMS energy
 * detection scores a Matthews correlation of 0.11 against Silero's 0.72. The
 * paper's own summary is that RMS "underperforms random guessing for most of its
 * range," because a level says nothing about what KIND of signal produced it —
 * and adding a second threshold measurably fails to rescue it (0.11 → 0.10)
 * while it does help a real detector. A classroom fan, a scraped chair and a
 * colleague two desks away all clear an energy gate; none of them are the
 * teacher talking to this app.
 *
 * WHAT THIS IS NOT: a replacement for the energy check. Silero says "this is
 * speech," which is exactly the wrong question for barge-in — the assistant's
 * own voice leaking back through the speaker IS speech, and Silero will say so
 * confidently. So the panel gates barge-in on Silero AND a noise-floor-relative
 * level, which is the pairing Pipecat arrived at too (confidence >= threshold
 * AND volume >= min_volume). Each covers the other's blind spot.
 *
 * The model is 309K parameters: an STFT-shaped conv front end, a single
 * unidirectional LSTM(128) whose hidden state is CARRIED BETWEEN FRAMES, and a
 * conv decoder to one sigmoid. That carried state is the thing an energy gate
 * can never have — it's how the model knows a 32ms window of near-silence in the
 * middle of a word is still speech.
 *
 * Frames must be exactly 512 samples at 16kHz. micCaptureWorklet emits precisely
 * that, deliberately, which is why this drops in as a change of decision
 * function rather than a change of plumbing.
 *
 * Loaded on demand and allowed to fail. The runtime is heavy (see
 * scripts/stage-vad-assets.mjs) and it is fetched only when a voice conversation
 * actually starts; if anything about that fails — offline, assets not staged,
 * no WASM SIMD — the caller keeps the adaptive-energy detector it already has.
 * A worse detector working is better than a better detector erroring.
 */

const MODEL_URL = '/vad/silero_vad_v5.onnx'
const WASM_BINARY = '/vad/ort-wasm-simd-threaded.wasm'

/* The canonical thresholds. 0.5 to open, 0.35 to close — a 0.15 hysteresis gap,
   which the Silero authors used and which LiveKit's and @ricky0123/vad-web's
   defaults both independently reproduce. The gap is the point: probabilities
   between the two do nothing at all, neither extending nor ending speech, which
   is what stops the flapping an energy gate does at its threshold. */
export const SPEECH_ON = 0.5
export const SPEECH_OFF = 0.35

/* Frames whose inference hasn't finished yet. Inference is well under a
   millisecond against a 32ms frame cadence, so this should never exceed one or
   two; the cap exists because the LSTM state is only meaningful over a
   CONTIGUOUS run of frames, and silently dropping frames from the middle would
   degrade the model invisibly. Past the cap we reset instead, which is honest. */
const MAX_BACKLOG = 8

let ortPromise = null

/* Imported dynamically so onnxruntime-web stays out of the main bundle — the
   text chat, the plan builder and every other page pay nothing for it. */
function loadOrt() {
  if (!ortPromise) {
    /* 'onnxruntime-web/wasm', not 'onnxruntime-web'. The default entry pulls in
       the JSEP/WebGPU build, whose wasm binary is 26.8MB against the plain
       wasm build's 12.9MB — and Vite bundles whichever one it sees, so importing
       the default silently doubled the payload for a GPU path a 309K-parameter
       model has no use for.

       Paired with the `onnxruntime-web-use-extern-wasm` resolve condition in
       vite.config.js, which selects ORT's external-wasm variant so the binary is
       FETCHED from wasmPaths at runtime rather than emitted into the bundle.
       Without that condition the same 12.9MB ends up in dist/assets as well as
       in public/vad/ — shipped twice, loaded once. */
    ortPromise = import('onnxruntime-web/wasm').then((ort) => {
      /* Single-threaded on purpose. ORT wants COOP/COEP headers to use
         SharedArrayBuffer, this app doesn't send them (and setting them would
         break the Google Sign-In iframe), and without them ORT logs a warning
         and forces one thread anyway. Asking for one up front skips the warning
         and the probe. It costs nothing here: a 309K-parameter model is under a
         millisecond per frame on a single thread. */
      ort.env.wasm.numThreads = 1
      /* Only the BINARY is externalised, not ORT's emscripten glue module.
         wasmPaths accepts either a path prefix or a per-file object; a bare
         prefix makes ORT resolve the glue .mjs from the same directory too, and
         it dynamically import()s that — which Vite refuses outright for anything
         under public/ ("should not be imported from source code. It can only be
         referenced via HTML tags"), 500ing in dev while working in production.
         An asymmetry between dev and prod is the worst kind of bug to leave in.

         Naming only `wasm` gets both halves right: the 12.9MB binary is fetched
         from the staged asset path (cached by the browser, gzipped by the
         server), and the 24KB glue is left to the bundler, which resolves it out
         of node_modules like any other module. */
      ort.env.wasm.wasmPaths = { wasm: WASM_BINARY }
      // ORT is chatty at default log level and none of it is actionable here.
      ort.env.logLevel = 'error'
      return ort
    })
  }
  return ortPromise
}

/**
 * Loads the model and returns a detector, or throws if anything is unavailable.
 *
 * The returned object is deliberately synchronous to CALL and asynchronous
 * inside: push() hands a frame in and returns immediately, and probability()
 * reads the most recent verdict. The panel's detector runs on the audio frame
 * cadence and cannot await anything, so a one-frame (32ms) lag on the
 * probability is the right trade — and is imperceptible next to the 300-600ms
 * endpointing windows it feeds.
 */
export async function createSileroDetector() {
  const ort = await loadOrt()
  const session = await ort.InferenceSession.create(MODEL_URL, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  })

  // Model I/O, verified against the shipped v5 graph:
  //   in  input float32 [batch, samples]   state float32 [2, batch, 128]   sr int64
  //   out output float32 [batch, 1]        stateN float32 [2, batch, 128]
  const sr = new ort.Tensor('int64', BigInt64Array.from([16000n]), [])
  const zeroState = () => new ort.Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128])

  let state = zeroState()
  let prob = 0
  let busy = false
  let closed = false
  const backlog = []

  const pump = async () => {
    if (busy || closed) return
    busy = true
    try {
      while (backlog.length && !closed) {
        const frame = backlog.shift()
        const input = new ort.Tensor('float32', frame, [1, frame.length])
        // eslint-disable-next-line no-await-in-loop
        const out = await session.run({ input, state, sr })
        prob = out.output.data[0]
        state = out.stateN
      }
    } catch {
      /* A failed inference leaves the carried state untrustworthy — start the
         sequence over rather than continuing from a state that may not
         correspond to the audio. The last good probability stands until the
         next frame lands, which decays naturally as the run continues. */
      state = zeroState()
      backlog.length = 0
    } finally {
      busy = false
    }
  }

  return {
    /** Hand in one 512-sample 16kHz frame. Cheap and non-blocking. */
    push(frame) {
      if (closed) return
      if (backlog.length >= MAX_BACKLOG) {
        // Fell behind badly enough that contiguity is already broken. Say so by
        // resetting, instead of feeding the LSTM a gap it can't know about.
        backlog.length = 0
        state = zeroState()
        return
      }
      backlog.push(frame)
      pump()
    },
    /** The most recent speech probability, 0..1. */
    probability() {
      return prob
    },
    /** Clear the carried state between utterances, so one turn's tail can't
     *  colour the next turn's opening. Pipecat resets on a similar cadence for
     *  the same reason (drift over a long-lived session). */
    reset() {
      state = zeroState()
      backlog.length = 0
      prob = 0
    },
    close() {
      closed = true
      backlog.length = 0
      // release() is async; nothing here waits on it, and a leaked session on
      // teardown is bounded by the page's own lifetime.
      session.release?.().catch(() => {})
    },
  }
}
