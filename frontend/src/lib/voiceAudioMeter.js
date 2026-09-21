// Observe the existing streams without playing the microphone or owning tracks.
// Animation samples this directly; audio frames never enter React state.
export function createVoiceAudioMeter({ createContext = () => new (globalThis.AudioContext || globalThis.webkitAudioContext)() } = {}) {
  let context = null
  const channels = new Map()
  let closed = false
  try {
    context = createContext()
    Promise.resolve(context.resume()).catch(() => {})
  } catch { /* Metering is optional; unsupported audio contexts must not break voice. */ }
  const disconnect = (node) => { try { node?.disconnect() } catch { /* Already detached. */ } }
  const detach = (channel) => {
    const nodes = channels.get(channel)
    disconnect(nodes?.source)
    disconnect(nodes?.analyser)
    channels.delete(channel)
  }
  return {
    attach(channel, stream) {
      if (closed || !context) return
      detach(channel)
      let source, analyser
      try {
        source = context.createMediaStreamSource(stream)
        analyser = context.createAnalyser()
        analyser.fftSize = 512
        source.connect(analyser)
        channels.set(channel, { source, analyser, samples: new Float32Array(analyser.fftSize) })
      } catch {
        disconnect(source)
        disconnect(analyser)
      }
    },
    sample(channel) {
      const nodes = channels.get(channel)
      if (closed || !nodes || context?.state !== 'running') return 0
      nodes.analyser.getFloatTimeDomainData(nodes.samples)
      const rms = Math.sqrt(nodes.samples.reduce((sum, value) => sum + value * value, 0) / nodes.samples.length)
      // A small noise floor keeps silence still; speech has a bounded visual range.
      return Math.min(1, Math.max(0, (rms - 0.008) * 9))
    },
    resume() { if (!closed && context) Promise.resolve(context.resume()).catch(() => {}) },
    close() {
      if (closed) return
      closed = true
      for (const channel of channels.keys()) detach(channel)
      if (context) Promise.resolve(context.close()).catch(() => {})
      context = null
    },
  }
}
