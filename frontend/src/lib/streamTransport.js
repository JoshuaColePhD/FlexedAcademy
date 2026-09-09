const DROPPED_CONNECTION = /load failed|failed to fetch|networkerror|fetch failed|the internet connection appears to be offline/i

export function isDroppedConnectionError(err) {
  if (!err || err.name === 'AbortError') return false
  return DROPPED_CONNECTION.test(String(err.message || ''))
}

export function droppedConnectionCopy(writing = false) {
  return {
    message: writing
      ? 'The connection dropped while writing the days.'
      : 'The connection dropped before the reply finished.',
    hint: 'Nothing was saved. Try again.',
    code: 'stream_connection_error',
  }
}
