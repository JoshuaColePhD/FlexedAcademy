/* One API client. Replaces five bare fetch() calls with `http://localhost:8000`
   hardcoded into them, which made the app impossible to deploy or point
   anywhere else.

   In dev, vite.config.js proxies /api to 127.0.0.1:8000, so the default base is
   empty and same-origin — CORS stops mattering. VITE_API_URL overrides it. */

export const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')

/** An error carrying the backend's stable {code, message, hint} envelope. */
export class ApiError extends Error {
  constructor(message, { code = 'unknown', hint = '', status = 0, extra = {} } = {}) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.hint = hint
    this.status = status
    this.extra = extra
  }
}

async function toError(res) {
  let body = null
  try {
    body = await res.json()
  } catch {
    // Non-JSON error (proxy down, HTML error page) — fall through to the status.
  }
  const e = body?.error
  if (e?.message) {
    return new ApiError(e.message, {
      code: e.code,
      hint: e.hint,
      status: res.status,
      extra: e,
    })
  }
  // Pydantic 422s arrive as {detail: [...]}
  if (Array.isArray(body?.detail) && body.detail.length) {
    const d = body.detail[0]
    return new ApiError(d.msg || 'That request was rejected.', {
      code: 'validation_error',
      hint: (d.loc || []).join(' → '),
      status: res.status,
    })
  }
  return new ApiError(`Request failed (${res.status})`, {
    code: 'http_error',
    status: res.status,
  })
}

async function request(path, { method = 'GET', body, signal } = {}) {
  let res
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      signal,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (err) {
    if (err.name === 'AbortError') throw err
    throw new ApiError('Can’t reach the server.', {
      code: 'network_error',
      hint: 'Is the backend running? Start it with ./run.sh',
    })
  }
  if (!res.ok) throw await toError(res)
  if (res.status === 204) return null
  return res.json()
}

async function upload(path, formData, { signal } = {}) {
  let res
  try {
    res = await fetch(`${API_BASE}${path}`, { method: 'POST', body: formData, signal })
  } catch (err) {
    if (err.name === 'AbortError') throw err
    throw new ApiError('Can’t reach the server.', { code: 'network_error' })
  }
  if (!res.ok) throw await toError(res)
  return res.json()
}

export const api = {
  health: () => request('/api/health'),

  getSettings: () => request('/api/settings'),
  putSettings: (payload) => request('/api/settings', { method: 'PUT', body: payload }),

  listChats: () => request('/api/chats'),
  createChat: (title) => request('/api/chats', { method: 'POST', body: { title } }),
  getChat: (id) => request(`/api/chats/${id}`),
  renameChat: (id, title) => request(`/api/chats/${id}`, { method: 'PATCH', body: { title } }),
  deleteChat: (id) => request(`/api/chats/${id}`, { method: 'DELETE' }),
  addMessage: (chatId, msg) =>
    request(`/api/chats/${chatId}/messages`, { method: 'POST', body: msg }),
  importChats: (payload) => request('/api/chats/import', { method: 'POST', body: payload }),

  listPlans: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    )
    return request(`/api/plans${qs.toString() ? `?${qs}` : ''}`)
  },
  getPlan: (id) => request(`/api/plans/${id}`),
  patchPlan: (id, payload) => request(`/api/plans/${id}`, { method: 'PATCH', body: payload }),
  rebuildPlan: (id) => request(`/api/plans/${id}/rebuild`, { method: 'POST' }),
  deletePlan: (id) => request(`/api/plans/${id}`, { method: 'DELETE' }),
  planDownloadUrl: (id) => `${API_BASE}/api/plans/${id}/download`,

  reviseDay: (payload) => request('/api/revise_day', { method: 'POST', body: payload }),

  listStandards: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    )
    return request(`/api/standards${qs.toString() ? `?${qs}` : ''}`)
  },
  getStandard: (code) => request(`/api/standards/${encodeURIComponent(code)}`),
  standardsStats: () => request('/api/standards/stats'),
  standardsGaps: () => request('/api/standards/gaps'),
  searchStandards: (query, topK = 10) =>
    request('/api/standards/search', { method: 'POST', body: { query, top_k: topK } }),

  transcribe: (blob, { signal } = {}) => {
    const fd = new FormData()
    fd.append('audio', blob, 'recording.webm')
    return upload('/api/transcribe', fd, { signal })
  },
  extractText: (file, { signal } = {}) => {
    const fd = new FormData()
    fd.append('file', file)
    return upload('/api/extract_text', fd, { signal })
  },

  /** Raw stream endpoint — consumed by useLessonStream. */
  streamUrl: () => `${API_BASE}/api/generate_stream`,
}
