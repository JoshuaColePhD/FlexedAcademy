/* Float32 samples → a WAV Blob, for uploading a captured utterance to Whisper.
 *
 * This exists because voice mode captures raw samples now rather than letting
 * MediaRecorder produce a container (see micCaptureWorklet's own comment for
 * why). WAV is the right envelope for that: a 44-byte header and then the
 * samples, nothing to negotiate. It's also the one format where the byte the
 * decoder reads and the byte we wrote are the same byte — the previous pipeline
 * had a real bug where Safari's audio/mp4 recordings were uploaded named .webm,
 * and Whisper's decoder failed silently on every one of them.
 *
 * Uncompressed costs bytes: 16kHz mono 16-bit is 32KB per second, so a
 * five-second utterance is about 160KB. That is nothing against the 25MB cap
 * the endpoint already enforces, and it buys back the encode step entirely.
 */

/**
 * @param {Float32Array} samples mono, nominally in [-1, 1]
 * @param {number} sampleRate
 * @returns {Blob} audio/wav
 */
export function encodeWav(samples, sampleRate) {
  const bytes = samples.length * 2
  const buffer = new ArrayBuffer(44 + bytes)
  const view = new DataView(buffer)

  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }

  /* Offsets are load-bearing and easy to get wrong by two — the canonical
     44-byte header is: RIFF(0) size(4) WAVE(8) 'fmt '(12) fmtSize(16)
     audioFormat(20) channels(22) rate(24) byteRate(28) blockAlign(32)
     bitsPerSample(34) 'data'(36) dataSize(40), samples from 44. */
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + bytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size — occupies bytes 16..19
  view.setUint16(20, 1, true) // audioFormat: 1 = PCM, uncompressed
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate: rate * channels * bytes
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  view.setUint32(40, bytes, true)

  /* Asymmetric scaling and an explicit little-endian flag, rather than one
     multiply by 32767. Int16's range is asymmetric (-32768..32767): scaling
     everything by 32768 clips the positive peaks, and scaling by 32767 throws
     away a bit of negative range. setInt16's third argument is littleEndian,
     which is what every PCM consumer expects and what a bare Int16Array would
     get wrong on a big-endian host. */
  let offset = 44
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }

  return new Blob([buffer], { type: 'audio/wav' })
}
