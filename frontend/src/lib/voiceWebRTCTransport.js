/* Resource ownership for one WebRTC connection. Dependency injection keeps
 * lifecycle tests hermetic and makes late microphone grants safe to close. */
export async function openWebRTCTransport({
  provision, signal, onEvent, onTrack, onLost, onInputStream = () => {}, isMuted = () => false,
  preferredDeviceId = '', onDevice = () => {},
  mediaDevices = navigator.mediaDevices,
  createPeer = () => new RTCPeerConnection(), request = fetch,
}) {
  let closed = false
  let stream = null
  let pc = null
  let dc = null
  const abortError = () => new DOMException('Voice connection cancelled.', 'AbortError')
  const guard = () => { if (closed || signal.aborted) throw abortError() }
  const close = () => {
    if (closed) return
    closed = true
    if (dc) { dc.onopen = null; dc.onclose = null; dc.onerror = null; dc.onmessage = null }
    if (pc) { pc.ontrack = null; pc.onconnectionstatechange = null }
    try { dc?.close() } catch { /* already closed */ }
    try { pc?.close() } catch { /* already closed */ }
    stream?.getTracks().forEach((track) => track.stop())
  }
  const lose = () => {
    if (closed) return
    close()
    onLost('The voice connection was lost. Try again.')
  }
  let rejectAbort
  const aborted = new Promise((_, reject) => { rejectAbort = reject })
  const onAbort = () => { close(); rejectAbort(abortError()) }
  signal.addEventListener('abort', onAbort, { once: true })
  const setup = async () => {
    guard()
    if (!mediaDevices?.getUserMedia) throw new Error('Voice needs a secure browser connection with microphone support.')
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    const microphone = Promise.resolve().then(() => mediaDevices.getUserMedia({
      audio: { ...audio, ...(preferredDeviceId ? { deviceId: { exact: preferredDeviceId } } : {}) },
    })).catch((error) => {
      guard()
      if (!preferredDeviceId || error?.name !== 'OverconstrainedError') throw error
      return mediaDevices.getUserMedia({ audio })
    }).then((result) => {
      if (closed || signal.aborted) {
        result.getTracks().forEach((track) => track.stop())
        throw abortError()
      }
      // Own it immediately, even while token provisioning remains pending.
      stream = result
      stream.getAudioTracks().forEach((track) => { track.enabled = !isMuted() })
      onInputStream(stream)
      return result
    })
    const [session] = await Promise.all([Promise.resolve().then(() => provision(signal)), microphone])
    guard()
    if (!session?.token) throw new Error('The voice service did not return a session token.')
    const deviceId = stream.getAudioTracks()[0]?.getSettings?.().deviceId
    if (deviceId) onDevice(deviceId)
    pc = createPeer()
    pc.ontrack = (event) => { if (!closed) onTrack(event.streams[0]) }
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) lose()
    }
    stream.getTracks().forEach((track) => pc.addTrack(track, stream))
    dc = pc.createDataChannel('oai-events')
    const channelOpen = new Promise((resolve, reject) => {
      dc.onopen = resolve
      dc.onclose = () => { reject(new Error('Voice data connection closed.')); lose() }
      dc.onerror = () => { reject(new Error('Voice data connection failed.')); lose() }
    })
    // A close during SDP negotiation must not cause an unhandled rejection.
    channelOpen.catch(() => {})
    dc.onmessage = (message) => {
      if (closed) return
      let event
      try { event = JSON.parse(message.data) } catch { return }
      onEvent(event)
    }
    const offer = await pc.createOffer()
    guard()
    await pc.setLocalDescription(offer)
    guard()
    const response = await request('https://api.openai.com/v1/realtime/calls', {
      method: 'POST', body: offer.sdp, signal,
      headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/sdp' },
    })
    guard()
    if (!response.ok) throw new Error(`Voice connection refused (${response.status}). Try again.`)
    const sdp = await response.text()
    guard()
    await pc.setRemoteDescription({ type: 'answer', sdp })
    guard()
    await channelOpen
    guard()
    return {
      isOpen: () => !closed && dc.readyState === 'open',
      send(event) {
        if (closed || dc.readyState !== 'open') return false
        try { dc.send(JSON.stringify(event)); return true } catch { lose(); return false }
      },
      setMuted(value) { stream?.getAudioTracks().forEach((track) => { track.enabled = !value }) },
      close,
    }
  }
  try {
    return await Promise.race([setup(), aborted])
  } catch (error) {
    close()
    throw error
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
