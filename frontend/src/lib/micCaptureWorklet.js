/* The microphone capture worklet — runs on the browser's real-time audio
 * thread, downsamples the mic to 16kHz, and posts frames back to
 * VoiceModePanel, which keeps them in a rolling buffer and cuts utterances out
 * of it.
 *
 * NOT bundled like the rest of src/. An AudioWorkletProcessor is instantiated
 * by the browser in a scope with no window, no document and no module loader,
 * so this file has to reach the browser as a standalone URL — see the
 * `?url` import in VoiceModePanel, which is how Vite emits it as an asset
 * instead of inlining it into the app bundle.
 *
 * WHY THIS EXISTS AT ALL, given MediaRecorder already worked: it didn't,
 * quite. A recorder that is only STARTED once the level has already crossed a
 * threshold has, by construction, no audio from before that instant — and an
 * energy threshold always trips one or two frames after voicing really began,
 * because word-initial stops and fricatives (/p/ /t/ /k/ /s/ /f/) carry far
 * less energy than the vowel behind them. So "sixty" arrived as "ixty" and
 * Whisper invented a plausible word to fill the gap, which is much worse than
 * dropping it: the utterance came back confidently wrong.
 *
 * Capturing continuously into a ring buffer is the fix, and it also removes the
 * whole container-format problem that came with MediaRecorder — Chrome gives
 * you webm/opus, Safari gives you mp4/aac, the upload has to be labelled
 * correctly or Whisper's decoder disagrees with the bytes, and slicing a
 * continuous MediaRecorder stream mid-way produces fragments that need their
 * init segment prepended to decode at all. Raw samples have none of that: the
 * panel encodes exactly the window it wants as a WAV and uploads that.
 *
 * 16kHz because that's Whisper's own working rate — resampling here rather than
 * server-side means a fifth of the bytes go up the wire, and there is nothing
 * above 8kHz in speech that the model uses. The decimation is a plain box
 * average with no anti-alias prefilter, which is the same thing @ricky0123/vad-web
 * does for the same reason: for speech at these rates the aliasing that folds
 * back is inaudible to a transcription model, and a proper polyphase filter
 * would cost more than it returns.
 */

const TARGET_RATE = 16000
/* 512 samples at 16kHz is 32ms — deliberately Silero's frame size. Nothing here
   uses Silero today, but the panel's detector runs one decision per posted
   frame, so keeping the cadence at 32ms means swapping the energy heuristic for
   the real model later is a change of decision function and not a change of
   plumbing. */
const FRAME = 512

class MicCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    // `sampleRate` is a global inside the worklet scope — the context's actual
    // rate, which is whatever the hardware gave us (44100 or 48000, usually).
    this._ratio = sampleRate / TARGET_RATE
    this._acc = 0
    this._sum = 0
    this._count = 0
    this._out = new Float32Array(FRAME)
    this._n = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    // No input connected yet (or a render quantum with nothing in it). Return
    // true regardless: false tells the browser this node is finished and it
    // gets collected, which would end capture permanently.
    if (!channel) return true

    for (let i = 0; i < channel.length; i++) {
      this._sum += channel[i]
      this._count += 1
      this._acc += 1
      // Emit one output sample every `ratio` input samples. Fractional ratios
      // (44100/16000 = 2.756) are handled by carrying the remainder, so the
      // output rate stays correct over time rather than drifting.
      if (this._acc >= this._ratio) {
        this._acc -= this._ratio
        this._out[this._n] = this._sum / this._count
        this._n += 1
        this._sum = 0
        this._count = 0
        if (this._n === FRAME) {
          // A copy, not the buffer itself — this._out is reused for the next
          // frame, and a transferred ArrayBuffer would be detached out from
          // under it.
          this.port.postMessage(this._out.slice(0))
          this._n = 0
        }
      }
    }
    return true
  }
}

registerProcessor('mic-capture', MicCapture)
