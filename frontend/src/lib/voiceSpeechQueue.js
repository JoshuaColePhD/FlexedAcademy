/* Serialize Realtime response.create events. The transport can stay open
 * while the queue waits; only response.done releases the next item.
 *
 * Deliberately serial, not a missed pipelining opportunity: the Realtime API
 * models one active response per conversation at a time, so a second
 * response.create sent before the first's response.done is a protocol error,
 * not a free speedup. The actual fix for "sentences have dead air between
 * them" lives one layer up, in useChatStream's emitSentences — it now cuts
 * only the turn's opener as its own early response.create and coalesces
 * everything after it into one final flush, so a reply costs exactly two
 * serialized round trips through this queue instead of one per sentence. */
export function createSpeechQueue({ send, isOpen }) {
  const items = []
  let current = null
  let inFlight = false

  const pump = () => {
    if (inFlight || !isOpen()) return
    const item = items.shift()
    if (!item) return
    current = item
    inFlight = true
    if (!send({
      type: 'response.create',
      response: {
        output_modalities: ['audio'],
        instructions:
          'Read the following text aloud, verbatim, in a natural speaking voice. ' +
          'Do not summarise it, react to it, add to it, or omit any of it.\n\n' + item.text,
      },
    })) {
      inFlight = false
      current = null
      items.unshift(item)
    }
  }

  return {
    enqueue(text, options = {}) {
      const line = typeof text === 'string' ? text.trim() : ''
      if (!line) return
      items.push({ text: line, ...options })
      pump()
    },
    responseCreated(id) {
      if (current && id) current.responseId = id
    },
    responseDone(id) {
      if (!current) return false
      if (current.responseId && id && current.responseId !== id) return false
      current = null
      inFlight = false
      pump()
      return true
    },
    cancel() {
      if (current || items.length) send({ type: 'response.cancel' })
      current = null
      inFlight = false
      items.length = 0
    },
    clear() {
      current = null
      inFlight = false
      items.length = 0
    },
    current() {
      return current
    },
    pending() {
      return items.length
    },
    pump,
  }
}
