/* One API client. Replaces five bare fetch() calls with `http://localhost:8000`
   hardcoded into them, which made the app impossible to deploy or point
   anywhere else.

   In dev, vite.config.js proxies /api to 127.0.0.1:8000, so the default base is
   empty and same-origin — CORS stops mattering. VITE_API_URL overrides it. */

export const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')

// See transcribe() below — MediaRecorder's default mimeType varies by browser
// (webm/opus on Chrome/Firefox, mp4/aac on Safari), and the upload filename's
// extension is what tells the backend which container it actually got.
const EXT_BY_MIME = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
}

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

/* Exported because useLessonStream needs the same logic and had its own copy.
   The SSE path can't go through request() — it reads a stream — but it does get
   the identical {error:{code,message,hint}} envelope, so one function should
   decide how a backend error becomes an ApiError. */
export function apiErrorFromBody(body, status = 0) {
  const e = body?.error
  if (e?.message) {
    return new ApiError(e.message, {
      code: e.code,
      hint: e.hint,
      status,
      extra: e,
    })
  }
  // Pydantic 422s arrive as {detail: [...]}
  if (Array.isArray(body?.detail) && body.detail.length) {
    const d = body.detail[0]
    return new ApiError(d.msg || 'That request was rejected.', {
      code: 'validation_error',
      hint: (d.loc || []).join(' → '),
      status,
    })
  }
  return new ApiError(`Request failed (${status})`, {
    code: 'http_error',
    status,
  })
}

async function toError(res) {
  let body = null
  try {
    body = await res.json()
  } catch {
    // Non-JSON error (proxy down, HTML error page) — fall through to the status.
  }
  // A session that expired (or was revoked) mid-use fails as an ordinary
  // ApiError otherwise — every page would need its own "log back in" handling.
  // AuthProvider listens for this once, globally, and drops back to the login
  // screen. Excludes /api/auth/* itself: a wrong password on the login form is
  // not a session expiring, and should stay on the form as a normal error.
  if (res.status === 401 && !res.url.includes('/api/auth/')) {
    window.dispatchEvent(new CustomEvent('aplang:unauthorized'))
  }
  return apiErrorFromBody(body, res.status)
}

async function request(path, { method = 'GET', body, signal } = {}) {
  let res
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      signal,
      // 'include' rather than the default 'same-origin': harmless in dev
      // (proxied, so already same-origin) but required once the frontend and
      // API are served from different origins — the login session is a
      // cookie, and without this it silently stops being sent.
      credentials: 'include',
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
    res = await fetch(`${API_BASE}${path}`, { method: 'POST', body: formData, signal, credentials: 'include' })
  } catch (err) {
    if (err.name === 'AbortError') throw err
    throw new ApiError('Can’t reach the server.', { code: 'network_error' })
  }
  if (!res.ok) throw await toError(res)
  return res.json()
}

export const api = {
  health: ({ signal } = {}) => request('/api/health', { signal }),

  me: ({ signal } = {}) => request('/api/auth/me', { signal }),
  signup: (name, email, password) =>
    request('/api/auth/signup', { method: 'POST', body: { name, email, password } }),
  login: (email, password) => request('/api/auth/login', { method: 'POST', body: { email, password } }),
  loginWithGoogle: (credential) => request('/api/auth/google', { method: 'POST', body: { credential } }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  signOutEverywhere: () => request('/api/auth/sign_out_everywhere', { method: 'POST' }),
  deleteAccount: (password) =>
    request('/api/auth/delete_account', { method: 'POST', body: { password: password || null } }),
  // Same shape as planDownloadUrl below — a plain URL for an <a href download>,
  // not a fetch: the browser sends the session cookie on that navigation same
  // as any other same-origin GET, no Blob/createObjectURL dance needed.
  accountExportUrl: () => `${API_BASE}/api/account/export`,
  forgotPassword: (email) => request('/api/auth/forgot-password', { method: 'POST', body: { email } }),
  resetPassword: (token, password) =>
    request('/api/auth/reset-password', { method: 'POST', body: { token, password } }),
  changePassword: (currentPassword, newPassword) =>
    request('/api/auth/change-password', {
      method: 'POST',
      body: { current_password: currentPassword, new_password: newPassword },
    }),

  getSettings: ({ subject, signal } = {}) => request(subject ? `/api/settings?subject=${encodeURIComponent(subject)}` : '/api/settings', { signal }),
  putSettings: (payload) => request('/api/settings', { method: 'PUT', body: payload }),
  getFrameworks: ({ signal } = {}) => request('/api/frameworks', { signal }),

  /** `classId` scopes the sidebar to one prep. Omitted, the server returns
   *  every chat, which is what this meant before. */
  listChats: ({ classId, signal } = {}) =>
    request(classId ? `/api/chats?class_id=${encodeURIComponent(classId)}` : '/api/chats', { signal }),
  /** `weekNumber` pins which week the conversation is about, once, at
   *  creation — see backend db.py migration 24 for why it isn’t derived. */
  createChat: (title, classId, weekNumber) =>
    request('/api/chats', {
      method: 'POST',
      body: {
        title,
        ...(classId ? { class_id: classId } : {}),
        ...(weekNumber ? { week_number: weekNumber } : {}),
      },
    }),
  getChat: (id) => request(`/api/chats/${id}`),
  renameChat: (id, title) => request(`/api/chats/${id}`, { method: 'PATCH', body: { title } }),
  /** Re-point an existing conversation at a different week — the composer's
   *  week dropdown. Separate from renameChat because that route requires a
   *  title this has no business inventing. */
  setChatWeek: (id, weekNumber) =>
    request(`/api/chats/${id}/week`, { method: 'PATCH', body: { week_number: weekNumber } }),
  suggestChatTitle: (message) => request('/api/chats/title', { method: 'POST', body: { message } }),
  deleteChat: (id) => request(`/api/chats/${id}`, { method: 'DELETE' }),
  addMessage: (chatId, msg) =>
    request(`/api/chats/${chatId}/messages`, { method: 'POST', body: msg }),
  importChats: (payload) => request('/api/chats/import', { method: 'POST', body: payload }),

  // `signal` is destructured out so it is never serialised into the query string.
  listPlans: ({ signal, ...params } = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    )
    return request(`/api/plans${qs.toString() ? `?${qs}` : ''}`, { signal })
  },
  getPlan: (id) => request(`/api/plans/${id}`),
  rebuildPlan: (id) => request(`/api/plans/${id}/rebuild`, { method: 'POST' }),
  deletePlan: (id) => request(`/api/plans/${id}`, { method: 'DELETE' }),
  /* These two existed on the server and were called from LessonPlanTable with a
     bare fetch() — no credentials: 'include', so they would 401 the moment the
     app is served cross-origin, no {code,message,hint} envelope, and no route
     into the global 401 handler. Going through `request` fixes all three, and
     revisePlan returns the updated row so the caller can put it straight into
     state instead of telling the teacher to refresh the page. */
  /* With `feedback` this is the chat's iteration loop — "make Thursday a
     Socratic seminar". Without it, the autonomous self-critique it has always
     been. Returns the updated row so the caller can put it straight into state. */
  revisePlan: (id, feedback) =>
    request(`/api/plans/${id}/revise`, {
      method: 'POST',
      body: { feedback: feedback || null },
    }),
  planFeedback: (id, isGood, notes) =>
    request(`/api/plans/${id}/feedback`, {
      method: 'POST',
      body: { is_good: isGood, ...(notes ? { notes } : {}) },
    }),
  planDownloadUrl: (id) => `${API_BASE}/api/plans/${id}/download`,
  /* A plan can have several quizzes (backend db.py migration 26) — each ask
   *  for one ("make a matching quiz") is its own row, never overwriting an
   *  earlier one. `questionTypes` is a real array (['multiple_choice']),
   *  not a single string, since a request can name more than one type. */
  listQuizzes: (planId, { signal } = {}) => request(`/api/plans/${planId}/quizzes`, { signal }),
  createQuiz: (planId, { questionTypes, numQuestions } = {}) =>
    request(`/api/plans/${planId}/quiz`, {
      method: 'POST',
      body: { question_types: questionTypes, num_questions: numQuestions },
    }),
  deleteQuiz: (planId, quizId) =>
    request(`/api/plans/${planId}/quizzes/${quizId}`, { method: 'DELETE' }),
  quizDownloadUrl: (planId, quizId) => `${API_BASE}/api/plans/${planId}/quizzes/${quizId}/download`,
  /* The two raw SSE endpoints. generate_stream drives useLessonStream and yields
     a structured plan with grounding; chat_stream drives useChatStream and yields
     plain conversational text. They are not interchangeable. */
  streamUrl: () => `${API_BASE}/api/generate_stream`,
  chatStreamUrl: () => `${API_BASE}/api/chat_stream`,
  /* Voice mode's card stack — best-effort, re-read after every new message
     while the panel is open. Never worth a toast on failure; the caller
     just keeps whatever it already had. */
  getDecisions: (messages) => request('/api/decisions', { method: 'POST', body: { messages } }),

  reviseDay: (payload) => request('/api/revise_day', { method: 'POST', body: payload }),

  /* ── billing ──────────────────────────────────────────────────────────────
     `billing` carries the entitlement AND the price, read from Stripe at
     request time — the price is never a number typed into this codebase.
     `checkout`/`portal` each return { url } to a Stripe-hosted page; the app
     never handles a card. */
  billing: ({ signal } = {}) => request('/api/billing', { signal }),
  /** Public — the landing page has to be able to say what a subscription
   *  costs before anyone has an account. */
  publicPrice: ({ signal } = {}) => request('/api/billing/price', { signal }),

  /* ── admin ────────────────────────────────────────────────────────────────
     Gated server-side by is_admin (see deps.get_current_admin) — a non-admin
     account gets the normal 403 envelope, not a hidden feature that merely
     isn't linked to. */
  adminListAccounts: ({ signal } = {}) => request('/api/admin/accounts', { signal }),
  adminSetComped: (accountId, comped) =>
    request(`/api/admin/accounts/${accountId}/comp`, { method: 'POST', body: { comped } }),
  adminCreateSchool: (id, name) =>
    request('/api/admin/schools', { method: 'POST', body: { id, name } }),
  adminDeleteSchool: (id) =>
    request(`/api/admin/schools/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  checkout: () => request('/api/billing/checkout', { method: 'POST' }),
  billingPortal: () => request('/api/billing/portal', { method: 'POST' }),

  listStandards: ({ signal, ...params } = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    )
    return request(`/api/standards${qs.toString() ? `?${qs}` : ''}`, { signal })
  },
  // `subject` scopes the lookup to one course — omitting it on a plan-facing
  // call is how a Pre-AP Algebra 2 citation once rendered sourced to "AP
  // Japanese Language and Culture" (same code, wrong course; see
  // backend/retrieval.py's chunk_for_code). Only the Standards browser,
  // which has no one course in mind, should ever omit it.
  getStandard: (code, { subject, signal } = {}) =>
    request(
      `/api/standards/${encodeURIComponent(code)}${subject ? `?subject=${encodeURIComponent(subject)}` : ''}`,
      { signal }
    ),
  standardsStats: ({ signal, ...params } = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    )
    return request(`/api/standards/stats${qs.toString() ? `?${qs}` : ''}`, { signal })
  },
  standardsGaps: ({ signal } = {}) => request('/api/standards/gaps', { signal }),
  searchStandards: (query, topK = 10, { signal } = {}) =>
    request('/api/standards/search', { method: 'POST', body: { query, top_k: topK }, signal }),

  transcribe: (blob, { signal } = {}) => {
    // The filename's extension is the ONLY thing the backend uses to decide
    // the container format it hands to Whisper (see /api/transcribe: it reads
    // Path(filename).suffix, nothing about the blob's real bytes). This used
    // to hardcode 'recording.webm' regardless of what MediaRecorder actually
    // produced — fine on Chrome/Firefox, which default to webm/opus, but
    // Safari (desktop and iOS) doesn't support webm at all and records
    // audio/mp4 instead. Every Safari recording was uploaded mislabeled as
    // .webm, so Whisper's decoder disagreed with the real container on every
    // browser this app's own screenshots come from. blob.type is the MIME
    // MediaRecorder actually used — read the real extension from it.
    const ext = EXT_BY_MIME[blob.type?.split(';')[0]] || 'webm'
    const fd = new FormData()
    fd.append('audio', blob, `recording.${ext}`)
    return upload('/api/transcribe', fd, { signal })
  },
  /* The other direction from transcribe() above — text in, an audio Blob
     out. Not routed through request(): that helper always calls res.json(),
     and this response is audio/mpeg bytes, not JSON. */
  synthesizeSpeech: async (text, { signal } = {}) => {
    let res
    try {
      res = await fetch(`${API_BASE}/api/tts`, {
        method: 'POST',
        signal,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
    } catch (err) {
      if (err.name === 'AbortError') throw err
      throw new ApiError('Can’t reach the server.', { code: 'network_error' })
    }
    if (!res.ok) throw await toError(res)
    return res.blob()
  },
  extractText: (file, { signal } = {}) => {
    const fd = new FormData()
    fd.append('file', file)
    return upload('/api/extract_text', fd, { signal })
  },

  getCurriculumMap: (subject, { signal } = {}) =>
    request(`/api/curriculum_map?subject=${encodeURIComponent(subject)}`, { signal }),
  /** `classId` is what makes an upload visible to listClassDocuments — without
   *  it the row is written with class_id NULL and the My Classes list, which
   *  filters on class_id, can never match it. `kind` scopes the replace, so a
   *  syllabus no longer retires the pacing guide. */
  uploadCurriculumMap: (subject, file, { classId, kind, signal } = {}) => {
    const fd = new FormData()
    fd.append('subject', subject)
    fd.append('file', file)
    if (classId) fd.append('class_id', classId)
    if (kind) fd.append('kind', kind)
    return upload('/api/curriculum_map', fd, { signal })
  },
  deleteCurriculumMap: (id) => request(`/api/curriculum_map/${id}`, { method: 'DELETE' }),
  /* ── classes and the week board ──────────────────────────────────────────
     A teacher has several preps. `subject` used to be the scoping token in
     every URL here, which is why two classes on the same framework collided. */
  /** The teacher's name, once for the whole app rather than per class. */
  updateMe: ({ name, customInstructions, school } = {}) =>
    request('/api/me', {
      method: 'PATCH',
      body: { name, custom_instructions: customInstructions, school },
    }),
  /** Whitelisted schools for the settings page dropdown — one entry today. */
  listSchools: ({ signal } = {}) => request('/api/schools', { signal }),
  listClasses: ({ signal } = {}) => request('/api/classes', { signal }),
  createClass: ({ name, subject, grade }) =>
    request('/api/classes', { method: 'POST', body: { name, subject, grade } }),
  updateClass: (id, patch) => request(`/api/classes/${id}`, { method: 'PATCH', body: patch }),
  deleteClass: (id) => request(`/api/classes/${id}`, { method: 'DELETE' }),
  listClassDocuments: (id, { signal } = {}) =>
    request(`/api/classes/${id}/documents`, { signal }),

  /** The school year for one class: every week, its real dates, whether it has
   *  a plan and whether school is even open. Sourced from the same calendar
   *  file the generation prompt quotes, so the two cannot disagree. */
  getWeeks: (classId, { signal } = {}) =>
    request(classId ? `/api/weeks?class_id=${encodeURIComponent(classId)}` : '/api/weeks', { signal }),

  getCurriculumProgress: (subject, { signal } = {}) =>
    request(`/api/curriculum_progress?subject=${encodeURIComponent(subject)}`, { signal }),
}
