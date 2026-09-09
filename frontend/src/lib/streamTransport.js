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

export function chatFailureCopy(err) {
  if (isDroppedConnectionError(err)) return droppedConnectionCopy(false)
  const code = err?.code
  if (code === 'malformed_tool_call' || code === 'empty_reply') {
    return {
      message: "I didn't catch that cleanly.",
      hint: 'Send it again and I’ll pick it up.',
      code,
    }
  }
  if (code === 'invalid_plan_target' || code === 'invalid_quiz_target') {
    return {
      message: err.message || 'Open the plan or quiz you meant and try again.',
      hint: err.hint || 'The open artifact changed before that action finished.',
      code,
    }
  }
  return {
    message: err?.message || "I couldn't get a reply just then.",
    hint: err?.hint || 'Tap Try again.',
    code,
  }
}
