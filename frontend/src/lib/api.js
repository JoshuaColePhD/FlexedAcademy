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
  // A bare fetch has no default timeout, so a backend that stalls without
  // ever sending a response (a stuck DB connection, a dead proxy) leaves the
  // promise pending forever and callers like OnboardingWizard.finish() never
  // resolve their try/finally. Bound every request so a stall surfaces as an
  // ordinary network error instead.
  const timeoutController = new AbortController()
  const timeoutId = setTimeout(() => timeoutController.abort(), 20000)
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal
  let res
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      signal: combinedSignal,
      // 'include' rather than the default 'same-origin': harmless in dev
      // (proxied, so already same-origin) but required once the frontend and
      // API are served from different origins — the login session is a
      // cookie, and without this it silently stops being sent.
      credentials: 'include',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (err) {
    if (err.name === 'AbortError') {
      if (signal?.aborted) throw err
      throw new ApiError('The server took too long to respond.', { code: 'timeout' })
    }
    throw new ApiError('Can’t reach the server.', {
      code: 'network_error',
      hint: 'Is the backend running? Start it with ./run.sh',
    })
  } finally {
    clearTimeout(timeoutId)
  }
  if (!res.ok) throw await toError(res)
  if (res.status === 204) return null
  return res.json()
}

async function upload(path, formData, { signal } = {}) {
  const timeoutController = new AbortController()
  const timeoutId = setTimeout(() => timeoutController.abort(), 60000)
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal
  let res
  try {
    res = await fetch(`${API_BASE}${path}`, { method: 'POST', body: formData, signal: combinedSignal, credentials: 'include' })
  } catch (err) {
    if (err.name === 'AbortError') {
      if (signal?.aborted) throw err
      throw new ApiError('The upload took too long.', { code: 'timeout' })
    }
    throw new ApiError('Can’t reach the server.', { code: 'network_error' })
  } finally {
    clearTimeout(timeoutId)
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
  /** Closes OnboardingWizard.jsx for good (finished OR skipped — see
   *  backend's mark_onboarding_seen for why those are the same state). */
  markOnboardingSeen: () => request('/api/auth/onboarding-seen', { method: 'POST' }),
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
  createChat: (title, classId, weekNumber, mode) =>
    request('/api/chats', {
      method: 'POST',
      body: {
        title,
        ...(classId ? { class_id: classId } : {}),
        ...(weekNumber ? { week_number: weekNumber } : {}),
        ...(mode ? { mode } : {}),
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
  // Same list, grouped by calendar week — the Library's own view. A
  // separate endpoint rather than a flag on listPlans: the grouping needs to
  // pull every revision for the class server-side to fold them together,
  // which isn't the same query shape as listPlans' paginated flat list.
  listPlanWeeks: (classId) => request(`/api/plans/weeks?class_id=${encodeURIComponent(classId)}`),
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
  /* Share via Google — a separate Google integration from sign-in (see
   * backend/routes/drive.py). driveConnectUrl is a plain navigable URL, not
   * a fetch: Google's consent screen has to be a real top-level page the
   * browser visits, the same reason planDownloadUrl below is a URL and not
   * a request() call. */
  driveStatus: ({ signal } = {}) => request('/api/drive/status', { signal }),
  driveConnectUrl: (returnTo) =>
    `${API_BASE}/api/drive/connect?return_to=${encodeURIComponent(returnTo)}`,
  driveDisconnect: () => request('/api/drive/disconnect', { method: 'POST' }),
  sharePlan: (planId, { email, role = 'reader' } = {}) =>
    request(`/api/plans/${planId}/share`, {
      method: 'POST',
      body: { email, role },
    }),
  listPlanShares: (planId, { signal } = {}) =>
    request(`/api/plans/${planId}/shares`, { signal }),
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
  updateQuiz: (planId, quizId, quizJson) =>
    request(`/api/plans/${planId}/quizzes/${quizId}`, { method: 'PUT', body: { quiz_json: quizJson } }),
  /* The chat-driven counterpart to createQuiz — a follow-up like "make it
   * harder" updates the SAME quiz row in place instead of creating another
   * one (backend/routes/plans.py's revise_quiz_route), which is what
   * createQuiz would otherwise always do on every iteration. `feedback` is
   * the teacher's own message verbatim; the model already decided this was
   * a revision (generate_quiz's revises_current), not a new quiz. */
  reviseQuiz: (planId, quizId, feedback) =>
    request(`/api/plans/${planId}/quizzes/${quizId}/revise`, {
      method: 'POST',
      body: { feedback },
    }),
  quizDownloadUrl: (planId, quizId) => `${API_BASE}/api/plans/${planId}/quizzes/${quizId}/download`,
  exportQuizToCanvas: (planId, quizId) =>
    request(`/api/canvas/export_quiz?plan_id=${planId}&quiz_id=${quizId}`, { method: 'POST' }),
  /* The two raw SSE endpoints. generate_stream drives useLessonStream and yields
     a structured plan with grounding; chat_stream drives useChatStream and yields
     plain conversational text. They are not interchangeable. */
  streamUrl: () => `${API_BASE}/api/generate_stream`,
  chatStreamUrl: () => `${API_BASE}/api/chat_stream`,
  /* Voice mode's card stack — best-effort, re-read after every new message
     while the panel is open. Never worth a toast on failure; the caller
     just keeps whatever it already had. */
  getDecisions: (messages) => request('/api/decisions', { method: 'POST', body: { messages } }),

  /* The composer's empty-state Tab suggestion, upgraded from the generic
     rule-based template with what the pacing guide actually says the week
     covers. Never worth a toast on failure; the caller just keeps the
     generic suggestion it already had. */
  getSuggestion: (payload) => request('/api/suggestion', { method: 'POST', body: payload }),

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
  adminUsageTrend: ({ signal } = {}) => request('/api/admin/usage-trend', { signal }),
  adminStandardsCheck: ({ signal } = {}) => request('/api/admin/qa/standards-check', { signal }),
  adminSetComped: (accountId, comped) =>
    request(`/api/admin/accounts/${accountId}/comp`, { method: 'POST', body: { comped } }),
  // cap: null clears the override back to the account's ordinary tier cap.
  adminSetCustomCap: (accountId, cap) =>
    request(`/api/admin/accounts/${accountId}/cap`, { method: 'POST', body: { cap } }),
  /** Response carries `password` in plaintext — the ONE time it ever will.
   *  Nothing re-derives or re-displays it after this call returns. */
  // password omitted (undefined) -> the server generates a unique one;
  // provided -> every account created with it shares that exact password.
  adminCreateBetaAccount: (email, name, days = 7, password) =>
    request('/api/admin/beta-accounts', { method: 'POST', body: { email, name, days, password } }),
  adminExtendBeta: (accountId, days = 7) =>
    request(`/api/admin/accounts/${accountId}/extend-beta`, { method: 'POST', body: { days } }),
  adminEndBeta: (accountId) =>
    request(`/api/admin/accounts/${accountId}/end-beta`, { method: 'POST' }),
  adminCreateSchool: (id, name) =>
    request('/api/admin/schools', { method: 'POST', body: { id, name } }),
  adminDeleteSchool: (id) =>
    request(`/api/admin/schools/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  adminListCalendarSubmissions: (status, { signal } = {}) =>
    request(`/api/admin/calendar-submissions${status ? `?status=${encodeURIComponent(status)}` : ''}`, { signal }),
  adminApproveCalendarSubmission: (id) =>
    request(`/api/admin/calendar-submissions/${encodeURIComponent(id)}/approve`, { method: 'POST' }),
  adminRejectCalendarSubmission: (id) =>
    request(`/api/admin/calendar-submissions/${encodeURIComponent(id)}/reject`, { method: 'POST' }),
  listPendingTemplates: ({ signal } = {}) =>
    request('/api/admin/school-templates/pending', { signal }),
  listAutoActivatedTemplates: ({ signal } = {}) =>
    request('/api/admin/school-templates/auto-activated', { signal }),
  adminActivateTemplate: (schoolId) =>
    request(`/api/admin/schools/${schoolId}/activate-template`, { method: 'POST' }),
  templateDownloadUrl: (templateId) => `/api/admin/school-templates/${templateId}/download`,
  getTemplateAnalysis: (templateId, { signal } = {}) =>
    request(`/api/admin/school-templates/${encodeURIComponent(templateId)}/analysis`, { signal }),
  reanalyzeTemplate: (templateId) =>
    request(`/api/admin/school-templates/${encodeURIComponent(templateId)}/reanalyze`, { method: 'POST' }),
  adminGetSettings: ({ signal } = {}) => request('/api/admin/settings', { signal }),
  adminUpdateSettings: (freeWeeklyTokenCap, subscriberWeeklyTokenCap) =>
    request('/api/admin/settings', {
      method: 'PUT',
      body: {
        free_weekly_token_cap: freeWeeklyTokenCap,
        subscriber_weekly_token_cap: subscriberWeeklyTokenCap,
      },
    }),
  adminAuditLog: ({ limit, signal } = {}) =>
    request(`/api/admin/audit-log${limit ? `?limit=${limit}` : ''}`, { signal }),
  adminBilling: ({ signal } = {}) => request('/api/admin/billing', { signal }),
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
  // Same lookup as getStandard, for every code a plan cites in one request —
  // see backend/routes/standards.py's get_standards_batch for why. Returns
  // {code: chunk | null}.
  getStandardsBatch: (codes, { subject, signal } = {}) => {
    const qs = new URLSearchParams({ codes: codes.join(',') })
    if (subject) qs.set('subject', subject)
    return request(`/api/standards/batch?${qs}`, { signal })
  },
  standardsStats: ({ signal, ...params } = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    )
    return request(`/api/standards/stats${qs.toString() ? `?${qs}` : ''}`, { signal })
  },
  standardsGaps: ({ signal } = {}) => request('/api/standards/gaps', { signal }),
  searchStandards: (query, topK = 10, { signal } = {}) =>
    request('/api/standards/search', { method: 'POST', body: { query, top_k: topK }, signal }),

  /* ── sharing a plan by link ───────────────────────────────────────────────
   *
   * SharedPlanPage.jsx called `api.client.get(...)` and `api.client.post(...)`.
   * There is no `client` on this object — it is a plain literal — so the public
   * share page threw `Cannot read properties of undefined (reading 'get')` on
   * mount. Every /shared/:id link anyone was sent landed on a crash. Same shape
   * of bug as the missing createVoiceSession below: a page written against an
   * API surface that was never built.
   *
   * setPlanPublic is the consent step that had no client either — see
   * backend migration 39. Until a plan is published, getSharedPlan 404s. */
  setPlanPublic: (planId, isPublic = true) =>
    request(`/api/plans/${encodeURIComponent(planId)}/public_link`, {
      method: 'POST',
      body: { public: isPublic },
    }),

  /** The one endpoint in the app that needs no session — a colleague opening a
   *  shared link has no account yet. */
  getSharedPlan: (planId, { signal } = {}) =>
    request(`/api/plans/public/${encodeURIComponent(planId)}`, { signal }),

  forkSharedPlan: (planId, classId = null) =>
    request(`/api/plans/${encodeURIComponent(planId)}/fork`, {
      method: 'POST',
      body: { class_id: classId },
    }),

  /** Mints the short-lived key the browser uses to open its own WebRTC session
   *  with OpenAI's Realtime API (VoiceProvider.unlock).
   *
   *  This method did not exist. VoiceProvider has called `api.createVoiceSession`
   *  since the WebRTC migration (commit eb498c8) and `api` is a plain object
   *  literal, so the call was `undefined(...)` — a TypeError thrown before any
   *  request left the browser. That is the whole reason voice mode could never
   *  connect, and because Composer runs `if (voice.enabled) voice.unlock()` on
   *  every submit while `enabled` is restored from localStorage, it also meant a
   *  red error toast on every typed message for anyone who had opened voice mode
   *  once.
   *
   *  Returns { token, model, expires_at }. `model` comes from the server on
   *  purpose — the SDP exchange has to name the same model the token was minted
   *  for, so it is defined once, in backend/routes/generate.py. */
  createVoiceSession: ({ chat_id = null, class_id = null, week_number = null, mode = 'brainstorm' } = {}, { signal } = {}) =>
    request('/api/voice/session', {
      method: 'POST',
      body: { chat_id, class_id, week_number, mode },
      signal,
    }),

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
  extractText: (file, { signal } = {}) => {
    const fd = new FormData()
    fd.append('file', file)
    return upload('/api/extract_text', fd, { signal })
  },

  getCurriculumMap: (subject, { signal } = {}) =>
    request(`/api/curriculum_map?subject=${encodeURIComponent(subject)}`, { signal }),
  listGlobalDocuments: ({ signal } = {}) => request('/api/documents/global', { signal }),
  /** `classId` is what makes an upload visible to listClassDocuments — without
   *  it the row is written with class_id NULL and the My Classes list, which
   *  filters on class_id, can never match it. `kind` scopes the replace, so a
   *  syllabus no longer retires the pacing guide. `file` OR `sourceUrl` —
   *  exactly one, same contract as uploadSchoolCalendar below (a Google Doc
   *  link resolves server-side; see routes/curriculum.py's _resolve_source). */
  uploadCurriculumMap: (subject, file, { classId, kind, isGlobal, sourceUrl, signal } = {}) => {
    const fd = new FormData()
    fd.append('subject', subject || 'GLOBAL')
    if (file) fd.append('file', file)
    if (sourceUrl) fd.append('source_url', sourceUrl)
    if (classId) fd.append('class_id', classId)
    if (kind) fd.append('kind', kind)
    if (isGlobal) fd.append('is_global', 'true')
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
  /** Upload a PDF/Word doc, OR pass `sourceUrl` instead of `file` — exactly
   *  one of the two. `schoolName` creates the school if it doesn't exist
   *  yet (see routes/school_calendars.py's _resolve_school). Returns
   *  {school, submission}, usable immediately by the submitter while
   *  `submission.status` is still 'pending'. */
  uploadSchoolCalendar: (schoolName, { file, sourceUrl, signal } = {}) => {
    const fd = new FormData()
    fd.append('school_name', schoolName)
    if (file) fd.append('file', file)
    if (sourceUrl) fd.append('source_url', sourceUrl)
    return upload('/api/school-calendars', fd, { signal })
  },
  getPendingSchoolCalendar: (schoolId, { signal } = {}) =>
    request(`/api/school-calendars/pending?school_id=${encodeURIComponent(schoolId)}`, { signal }),
  confirmSchoolCalendar: (submissionId) =>
    request(`/api/school-calendars/${encodeURIComponent(submissionId)}/confirm`, { method: 'POST' }),
  rejectSchoolCalendar: (submissionId) =>
    request(`/api/school-calendars/${encodeURIComponent(submissionId)}/reject`, { method: 'POST' }),
  uploadSchoolTemplate: (schoolId, { file, sourceUrl, signal } = {}) => {
    const fd = new FormData()
    if (file) fd.append('file', file)
    if (sourceUrl) fd.append('source_url', sourceUrl)
    return upload(`/api/school-calendars/${encodeURIComponent(schoolId)}/template`, fd, { signal })
  },
  listClasses: ({ include_archived, signal } = {}) => request(`/api/classes${include_archived ? '?include_archived=true' : ''}`, { signal }),
  createClass: ({ name, subject, grade, state }) =>
    request('/api/classes', { method: 'POST', body: { name, subject, grade, state } }),
  updateClass: (id, patch) => request(`/api/classes/${id}`, { method: 'PATCH', body: patch }),
  deleteClass: (id) => request(`/api/classes/${id}`, { method: 'DELETE' }),
  listClassDocuments: (id, { signal } = {}) =>
    request(`/api/classes/${id}/documents`, { signal }),

  getGlobalStandards: (state, subject, grade, { signal } = {}) =>
    request(`/api/standards/global?state=${encodeURIComponent(state)}&subject=${encodeURIComponent(subject)}&grade=${encodeURIComponent(grade)}`, { signal }),
  uploadGlobalStandards: (state, subject, grade, file, { signal } = {}) => {
    const fd = new FormData()
    fd.append('state', state)
    fd.append('subject', subject)
    fd.append('grade', grade)
    fd.append('file', file)
    return upload('/api/standards/global/upload', fd, { signal })
  },

  /** The school year for one class: every week, its real dates, whether it has
   *  a plan and whether school is even open. Sourced from the same calendar
   *  file the generation prompt quotes, so the two cannot disagree. */
  getWeeks: (classId, { signal } = {}) =>
    request(classId ? `/api/weeks?class_id=${encodeURIComponent(classId)}` : '/api/weeks', { signal }),

  getCurriculumProgress: (subject, { signal } = {}) =>
    request(`/api/curriculum_progress?subject=${encodeURIComponent(subject)}`, { signal }),

  updateDay: (planId, dayIndex, body) => request(`/api/plans/${planId}/days/${dayIndex}`, { method: 'PUT', body: JSON.stringify(body) }),

  /** A standalone quick warm-up for a day with no built plan yet — see
   *  TodayPage and backend/routes/bell_ringer.py. */
  getBellRinger: ({ subject, grade, topic }, { signal } = {}) =>
    request('/api/bell_ringer', { method: 'POST', body: { subject, grade, topic }, signal }),
}
