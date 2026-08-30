import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, CheckCircle2, ChevronDown, ChevronLeft, Clock, Download, Loader2, TriangleAlert, X } from 'lucide-react'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'
import { useAuth } from '../lib/authContext'
import { useBilling } from '../lib/billingContext'
import { useVoice } from '../lib/voiceContext'
import { useLessonStream } from '../hooks/useLessonStream'
import { useChatStream } from '../hooks/useChatStream'
import { useLayoutMode } from '../hooks/useMediaQuery'
import { useActiveClass, useCalendar, useChats, useClasses } from '../hooks/useAppData'
import { DAYS, FIELD_LABELS, SHORT_DAY, dayTitle, unitSuffix } from '../lib/planShape'
import { firstUnplanned } from '../lib/queue'
import { qk } from '../lib/queryKeys'
import { scanGrounding } from '../lib/grounding'
import { questionTypesProse } from '../lib/quizShape'
import { splitDecisions } from '../lib/decisionChecklist'
import { dayLabel, isSameDay } from '../lib/dates'
import { getContextualSuggestions } from '../lib/contextualSuggestions'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { useComposerDraft, clearComposerDraft } from '../hooks/useComposerDraft'
import { useOnlineStatus } from '../hooks/useOnlineStatus'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useExitTransition } from '../hooks/useExitTransition'
import { Composer } from '../components/Composer'
import { AddDocumentDialog } from '../components/AddDocumentDialog'
import { WeekPicker } from '../components/WeekPicker'
import { VoiceModePanel } from '../components/VoiceModePanel'
import { ClassSwitcher } from '../components/ClassSwitcher'
import { Tooltip } from '../components/Tooltip'
import { Message } from '../components/Message'
import { LessonQuestions } from '../components/LessonQuestions'
import { ArtifactPanel } from '../components/ArtifactPanel'
import { ArtifactDetailPanel } from '../components/ArtifactDetailPanel'
import { PlanPeek } from '../components/PlanPeek'
import { ArtifactRail, ArtifactDrawer } from '../components/ArtifactRail'
import { WeekStrip } from '../components/WeekStrip'
import { Greeting } from '../components/Greeting'
import { MobileChatHome } from '../components/MobileChatHome'
import { ChatHeaderSheet } from '../components/ChatHeaderSheet'

/* One chat, one plan.
 *
 * Say what you need, it builds it, then every message after that revises it.
 * That last part is the piece that never existed: the whole-plan revise
 * endpoint ran an autonomous self-critique and took no instruction, so "make
 * Thursday a Socratic seminar" had nowhere to go. It takes feedback now.
 *
 * The calendar is not a screen. It is still the thing keeping generation
 * honest — backend/schoolcal.py reads the same file the prompt quotes, so the
 * model cannot put five days of lessons inside Fall Break — it just doesn't
 * need a surface of its own to do that.
 *
 * Intent routing is deliberately dumb and predictable: no plan yet, your
 * message builds one; plan exists, your message revises it. A model guessing
 * which you meant would be wrong occasionally, and "occasionally regenerates
 * your week from scratch" is the worst failure this app has available. To start
 * something else, start a new chat.
 *
 * ── the artifact is a file, not a viewer ──────────────────────────────────
 * The resizable panel is gone. It and the chat fought over the same pixels and
 * both lost: a 460px message column, and a document squeezed until it clipped
 * its own title. A lesson plan is downloaded, printed and handed in — it is not
 * primarily read on screen — so it collapses to a 240px rail and the chat gets
 * a real reading column. The proof that the week is right travels in the
 * message (WeekStrip + grounding line), which is what makes closing the
 * document safe. Click the file when you actually want the pages.
 */

let idSeq = 0
const nextId = () => `m${++idSeq}`

const cellKey = (dayIndex, field) => `${dayIndex}:${field}`

/* A running transcript reopened days later used to read as one unbroken
 * column — nothing marked where "last Tuesday" ended and "just now" began.
 * A plain centered label, same eyebrow language (faint, tracked caps) the
 * rest of the app already uses for a section break, not a full chat-bubble
 * treatment of its own — it's a seam in the transcript, not a message. */
function DaySeparator({ label }) {
  return (
    <div className="flex items-center gap-3 px-1" role="separator" aria-label={label}>
      <span className="h-px flex-1 bg-edge" aria-hidden="true" />
      <span className="eyebrow shrink-0 text-ink-faint">{label}</span>
      <span className="h-px flex-1 bg-edge" aria-hidden="true" />
    </div>
  )
}

/* Was AppShell.jsx's own top-level child — first thing in #main, stacked
 * ABOVE the chat header (the class-switcher/school-name row) rather than
 * hanging under it. Moved here, right after that header's own closing tag,
 * so it reads as something revealed FROM the header instead of a strip
 * competing with it for the top of the screen. AppShell has no way to know
 * where "under the header" even is — that row is drawn by this page, not
 * the shell — so the banner has to live wherever the header does.
 *
 * height/opacity, not just opacity: animating in at full height instantly
 * would still read as a hard cut the instant it appears; growing open is
 * what makes it look like it's sliding out from behind the header bar
 * rather than just fading in beneath it. */
// template_status ('pending'/'active') and builder_readiness ('pending'
// /'in_progress'/'ready_unverified'/'ready'/'blocked', from docx_build.
// bulk_builder_readiness) are deliberately different facts as of migration
// 52: template_status alone used to be enough to know "will downloads use
// this school's real template," but now a school can reach template_status=
// 'active' (analysis auto-activation only ever judges analysis QUALITY)
// before a real document builder — hand-written, or automatically
// generated — actually exists for it, and (since the auto-verify bar
// loosened) a generated builder can now be usable BEFORE template_status
// reaches 'active' too. Keying this banner off builder_readiness instead
// of template_status is what keeps it accurate through all of that, not
// just the first half of it.
//
// 'in_progress' exists so a teacher who just uploaded a template sees THAT,
// not the same flat "pending" a school that's never been touched shows —
// there's a real codegen job running right now (a few minutes, not
// instant), and nothing here ever blocks chatting or building the lesson
// plan itself in the meantime; only the downloadable .docx format depends
// on this.
const TEMPLATE_BANNER_COPY = {
  pending: {
    tone: 'amber',
    icon: TriangleAlert,
    text: (name) => (
      <>
        🛠️ We are currently configuring the AI for <strong>{name}</strong>'s specific lesson plan format. In the
        meantime, document downloads will use a generic fallback format.
      </>
    ),
  },
  in_progress: {
    tone: 'blue',
    icon: Loader2,
    iconClassName: 'animate-spin',
    text: (name) => (
      <>
        🪄 We're drafting an AI version of <strong>{name}</strong>'s lesson plan format right now — usually just a
        few minutes. Keep chatting and building your plan; downloads will switch over automatically the moment it's
        ready.
      </>
    ),
  },
  ready_unverified: {
    tone: 'amber',
    icon: TriangleAlert,
    text: (name) => (
      <>
        ✨ Document downloads are using an AI-drafted version of <strong>{name}</strong>'s lesson plan format while
        our team finishes reviewing it for accuracy — let us know if something looks off.
      </>
    ),
  },
  ready: {
    tone: 'green',
    icon: CheckCircle2,
    text: (name) => (
      <>
        ✅ <strong>{name}</strong>'s lesson plan format is ready — document downloads now match your school's real
        format.
      </>
    ),
  },
  /* Was: "document downloads for this class won't work until it's ready.
     This shouldn't take long; try again shortly." Both halves were wrong.
     Downloads DO work now — they fall back to the default layout the same
     way a 'pending' school's do (backend/docx_build.py) rather than failing
     outright — and "shortly" was a promise nothing kept: this state is
     reached precisely when builder generation stopped (turned off, daily cap,
     or attempts exhausted), so waiting doesn't fix it. Telling a teacher to
     retry something that can never succeed is worse than telling her nothing. */
  blocked: {
    tone: 'amber',
    icon: TriangleAlert,
    text: (name) => (
      <>
        ⚠️ We hit a snag building <strong>{name}</strong>'s lesson plan format. Downloads still work, but they'll use
        a generic fallback format for now — we're looking into it.
      </>
    ),
  },
}

const TEMPLATE_BANNER_TONE_CLASSES = {
  amber: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
  blue: 'bg-sky-500/10 text-sky-600 border-sky-500/20',
  green: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
  red: 'bg-red-500/10 text-red-600 border-red-500/20',
}

/* A grid row reaches a content-driven height without Framer Motion measuring
   `height: auto` on every frame. That keeps the transcript and the portaled
   composer from taking a visible first-frame jump when a status banner opens
   or closes. `useExitTransition` keeps the row around for the matching close
   duration instead of unmounting it before the collapse can play. */
function BannerReveal({ open, children }) {
  const { mounted, closing } = useExitTransition(open, 220)
  const [revealed, setRevealed] = useState(false)

  useEffect(() => {
    if (!mounted || closing || !open) {
      setRevealed(false)
      return undefined
    }
    const frame = requestAnimationFrame(() => setRevealed(true))
    return () => cancelAnimationFrame(frame)
  }, [mounted, closing, open])

  if (!mounted) return null
  return (
    <div className={`chat-banner-reveal${revealed && !closing ? ' is-open' : ''}${closing ? ' is-closing' : ''}`}>
      <div>{children}</div>
    </div>
  )
}

function TemplateBanner() {
  const { classId } = useParams()
  const { data: schools = [] } = useQuery({
    queryKey: qk.schools,
    queryFn: () => api.listSchools(),
    // 'in_progress' is a live, in-flight state — the default staleTime
    // elsewhere (Infinity, since a school row otherwise never changes
    // mid-session) would leave this banner showing "drafting now" for the
    // rest of the visit even after the job actually finishes. Short
    // polling only while THIS banner is mounted (a class with a school),
    // not a global change to every other consumer of qk.schools.
    refetchInterval: (query) => {
      const list = query.state.data || []
      return list.some((s) => s.builder_readiness === 'in_progress') ? 15_000 : false
    },
  })
  const { data: classes = [] } = useClasses()

  const cls = classes.find((c) => c.id === classId)
  const school = schools.find((s) => s.id === cls?.school)
  const copy = school && TEMPLATE_BANNER_COPY[school.builder_readiness]
  const Icon = copy?.icon
  // A status change is new information, so its dismissal must not suppress a
  // later state (for example, "reviewing" should not hide "needs attention").
  const dismissalKey = school && copy ? `fa.templateBannerDismissed:${school.id}:${school.builder_readiness}` : ''
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (!dismissalKey) {
      setDismissed(false)
      return
    }
    try {
      setDismissed(localStorage.getItem(dismissalKey) === '1')
    } catch {
      setDismissed(false)
    }
  }, [dismissalKey])

  const dismiss = () => {
    try {
      localStorage.setItem(dismissalKey, '1')
    } catch {
      /* The banner can still be dismissed for this visit. */
    }
    setDismissed(true)
  }

  return (
    <BannerReveal open={Boolean(copy) && !dismissed}>
      {copy && Icon ? (
        <div className={`relative flex items-start gap-2 px-4 py-2 text-xs font-medium border-b shadow-sm ${TEMPLATE_BANNER_TONE_CLASSES[copy.tone]}`}>
          <Icon size={14} className={`mt-0.5 shrink-0 ${copy.iconClassName || ''}`} aria-hidden="true" />
          <p className="min-w-0 flex-1 pr-8 text-center">{copy.text(school.name)}</p>
          <button type="button" className="banner-dismiss btn-icon absolute right-3 top-2" onClick={dismiss} aria-label="Dismiss template status message" title="Dismiss">
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </BannerReveal>
  )
}

// Below this many days left, the countdown stops being background info in
// AccountMenu's usage meter (easy to never open) and earns a banner where a
// teacher is already looking. 2, not the full week, so it reads as "soon,"
// not as noise for most of a trial's life.
const TRIAL_BANNER_THRESHOLD_DAYS = 2

// One dismissal per remaining-days VALUE, not one ever — closing "2 days
// left" shouldn't also swallow "1 day left" tomorrow, or the countdown
// silently stops warning anyone right when it matters most. localStorage
// (not state) so it survives the reload a real day boundary implies.
const TRIAL_BANNER_DISMISSED_KEY = 'fa.trialBannerDismissedAt'

// The grid-based BannerReveal keeps this mounted long enough to recede instead
// of vanishing outright the instant a webhook resolves the status.
function TrialBanner() {
  const { entitlement, openPaywall } = useBilling()
  const [dismissed, setDismissed] = useState(() => {
    try {
      return typeof localStorage !== 'undefined' ? localStorage.getItem(TRIAL_BANNER_DISMISSED_KEY) : null
    } catch {
      return null
    }
  })

  const expired = !!entitlement?.trial_expired
  const daysLeft = entitlement?.trial_days_remaining
  const showCountdown = !expired && daysLeft != null && daysLeft <= TRIAL_BANNER_THRESHOLD_DAYS && dismissed !== String(daysLeft)

  const dismissCountdown = () => {
    try {
      localStorage.setItem(TRIAL_BANNER_DISMISSED_KEY, String(daysLeft))
    } catch {
      /* dismissal just won't survive a reload — not worth failing over */
    }
    setDismissed(String(daysLeft))
  }

  return (
    <BannerReveal open={expired || showCountdown}>
      {expired ? (
        // Bigger and un-dismissible on purpose: unlike the countdown below,
        // this isn't a heads-up about something still usable — every
        // token-spending route already hard-blocks behind this exact same
        // entitlement.trial_expired flag (backend/entitlement.py), so
        // hiding the reason without resolving it would just leave a
        // confused blocked teacher with no explanation on screen.
        <div>
          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 border-b border-red-500/25 bg-red-500/10 px-6 py-4 text-red-600 shadow-sm">
            <div className="flex items-center gap-2.5">
              <TriangleAlert size={20} className="shrink-0" aria-hidden="true" />
              <p className="text-sm font-semibold">
                Your free trial has ended — subscribe to keep building.
              </p>
            </div>
            <button type="button" className="btn btn-primary shrink-0" onClick={openPaywall}>
              Subscribe
            </button>
          </div>
        </div>
      ) : showCountdown ? (
        <div>
          <div className="flex items-center justify-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-xs font-medium text-amber-600 shadow-sm">
            <Clock size={14} className="shrink-0" aria-hidden="true" />
            <p>
              {daysLeft === 0
                ? 'Your free trial ends today.'
                : `${daysLeft} day${daysLeft === 1 ? '' : 's'} left in your free trial.`}{' '}
              <button type="button" className="font-semibold underline underline-offset-2" onClick={openPaywall}>
                Subscribe
              </button>{' '}
              to keep building without interruption.
            </p>
            <button
              type="button"
              className="btn-icon shrink-0 -my-1"
              aria-label="Dismiss"
              onClick={dismissCountdown}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : null}
    </BannerReveal>
  )
}

// What each `viewKind` is called in copy the teacher reads — the overlay's
// close button and (for a screen reader) ArtifactDetailPanel's own region.
const VIEW_KIND_LABELS = {
  plan: 'lesson plan',
  quiz: 'quiz',
  standards: 'standards',
  calendar: 'school calendar',
  document: 'document',
}

/* Per attached file. A pacing guide is a few thousand characters; a scanned
   40-page PDF is hundreds of thousands, and the whole thing would ride into
   every prompt in the conversation. */
const ATTACHMENT_CHAR_CAP = 12000

// Spoken (and captioned) the instant voice mode opens on an empty chat —
// short on purpose, since it's heard once per conversation, not read.
const VOICE_GREETING = 'Hey, what do you need a lesson plan for?'
// Spoken when the model commits to building, which it signals with a tool
// call carrying no text of its own — see their use in submit().
const VOICE_BUILDING = 'Building the week now — give me about thirty seconds.'
const VOICE_REVISING = 'Updating it now — one moment.'

const waitBeforeRetry = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* What voice mode SAYS when the model asks for clarification.
 *
 * Only the questions themselves — never their options. The options are
 * rendered as tappable cards inside the voice panel (VoiceModePanel's
 * QuestionCards), so reading them aloud would be both slower to sit
 * through and harder to answer than simply looking at them. Speaking only
 * the generic intro and dropping the questions entirely, which is what this
 * did before the cards existed, left the panel silently waiting on an
 * answer to something it never asked — indistinguishable from being stuck.
 *
 * `intro` is empty when it has already been spoken sentence-by-sentence as
 * it streamed; passing it again would say it twice.
 */
function speakableQuestions(intro, questions) {
  return [intro, ...questions.map((q) => q.text)].filter(Boolean).join(' ')
}

export function ChatPage() {
  const { classId, chatId } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const toast = useToast()
  const persistMessage = useCallback(
    async (chatId, payload) => {
      if (!chatId) return null
      const client_id = payload.client_id || nextId()
      let lastError
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await api.addMessage(chatId, { ...payload, client_id })
        } catch (err) {
          lastError = err
          if (attempt < 2) await waitBeforeRetry(250 * (attempt + 1))
        }
      }
      toast.apiError("Couldn't save that message", lastError)
      return null
    },
    [toast]
  )
  const qc = useQueryClient()
  const isOnline = useOnlineStatus()
  const { refresh: refreshAuth } = useAuth()
  const { mayGenerate, entitlement, openPaywall } = useBilling()
  const voice = useVoice()
  const mode = useLayoutMode()
  const isPhone = mode === 'phone'
  /* A phone must land in a ready-to-type conversation. The old default sent
     every no-chat route to MobileChatHome, which rendered the rail but not
     the Composer — exactly the moment a teacher needs to start a plan. The
     chat home remains available through the header back button, but it is an
     explicit navigation choice rather than the default state. */
  const [mobileShowHome, setMobileShowHome] = useState(false)
  useEffect(() => {
    if (chatId) setMobileShowHome(false)
  }, [chatId])
  // ChatHeaderSheet — phone's stand-in for the header row's own
  // ClassSwitcher/WeekPicker/status, given room to breathe there instead.
  const [headerSheetOpen, setHeaderSheetOpen] = useState(false)
  const { classes, activeClass } = useActiveClass()
  // useAuth().user is deliberately the small {id,email,name} shape (see
  // authContext.js) — beta_features lives on the fuller /api/auth/me payload,
  // so Voice Mode's gate reads that instead of widening the auth context.
  const { data: meAccount } = useQuery({ queryKey: qk.me, queryFn: () => api.me() })
  const betaFeaturesEnabled = Boolean(meAccount?.beta_features)
  const { data: chats = [] } = useChats()
  const { data: calendar } = useCalendar(classId)
  // Same check ClassPage runs to gate its own "Add a pacing guide" suggestion —
  // without it, getContextualSuggestions defaults to assuming one exists and
  // the composer's "using my pacing guide" wording goes out regardless of
  // whether a class has ever had one uploaded.
  const classDocuments = useQuery({
    queryKey: qk.classDocuments(classId),
    queryFn: () => api.listClassDocuments(classId),
    enabled: Boolean(classId),
    staleTime: 5 * 60_000,
  })
  const hasPacingGuide = classDocuments.data
    ? classDocuments.data.some((document) => document.kind === 'pacing_guide')
    : true
  // Composer's add-pacing-guide/add-school-calendar suggestions carry
  // action: 'open-settings' — accepting one used to just fill a chat prompt
  // asking the model to "add the pacing guide," which is a network round
  // trip to get told to go upload a file. This opens that upload directly.
  const [documentDialogOpen, setDocumentDialogOpen] = useState(false)
  const handleOpenSettings = useCallback(
    (suggestion) => {
      if (suggestion.id === 'add-school-calendar') {
        navigate(`/c/${classId}/settings`)
        return
      }
      setDocumentDialogOpen(true)
    },
    [classId, navigate]
  )
  // The bridge between a file dropped into chat (transient, truncated,
  // read by nobody past this one conversation) and the durable document
  // this class can actually keep — same api.uploadCurriculumMap call
  // ClassDocuments.jsx's own upload uses, just fed the attachment's File
  // instead of one picked from a native file input. Only offered while
  // there's a real class in scope and it doesn't already have a pacing
  // guide — same condition add-pacing-guide itself gates on.
  const saveAttachmentAsDocument = useCallback(
    async (attachment) => {
      try {
        await api.uploadCurriculumMap(activeClass.subject, attachment.file, { classId, kind: 'pacing_guide' })
        toast.success(`Saved ${attachment.filename} as this class's pacing guide`)
        qc.invalidateQueries({ queryKey: qk.classDocuments(classId) })
      } catch (err) {
        toast.apiError('Could not save that as a document', err)
      }
    },
    [activeClass, classId, qc, toast]
  )

  const [messages, setMessages] = useState([])
  const [artifact, setArtifact] = useState(null)
  /* True only when a message (or the plans table) NAMES a real plan_id for
     this chat and fetching IT specifically failed — never for "no plan
     exists yet." That distinction is the whole point: without it, a
     transient getPlan() failure on reopen fell through to the exact same
     branch as "nothing built yet," and the rail's plain empty state stood
     in for a real plan that just failed to load — reading as "the plan you
     built doesn't exist" while the chat above it says otherwise. See the
     reload effect below. */
  const [artifactLoadError, setArtifactLoadError] = useState(false)
  // Bumped by the rail's own Reload button — see retryArtifactLoad below and
  // its use in the load effect's dependency array. Was a plain
  // window.location.reload(): recovering a single failed getPlan() call by
  // reloading the entire app (transcript, composer draft, scroll position,
  // every other query's cache) is a much bigger hammer than the one failed
  // request calls for.
  const [artifactRetryTick, setArtifactRetryTick] = useState(0)
  const [query, setQuery] = useState('')
  // chatId once one exists, else a per-class placeholder — so a draft
  // started before the first message creates the chat isn't lost either.
  // See useComposerDraft's own comment for why this re-syncs on every KEY
  // change (switching chats), not just once on mount.
  const draftKey = chatId || (classId ? `new:${classId}` : null)
  useComposerDraft(draftKey, query, setQuery)
  /* ArtifactRail's empty-state starter cards (Week Overview / Materials /
     Assessments) hand their prompt here rather than submitting straight
     away — same "fill, don't fire" convention as everywhere else a click
     populates the composer, so a teacher can edit before sending. */
  const suggestRailPrompt = (prompt) => {
    setQuery(prompt)
    requestAnimationFrame(() => document.getElementById('composer-input')?.focus())
  }
  const [attachments, setAttachments] = useState([])
  /* A follow-up typed and sent while the current turn is still busy — held
     here rather than lost. Composer's Enter/Send no longer waits on `busy`
     (see its own canSend comment); this is what it hands off to instead of
     calling submit() directly while a reply is still in flight. Cleared and
     actually sent the moment `busy` goes false — see the effect below. */
  const [queuedMessage, setQueuedMessage] = useState(null)
  /* A transient "it's done" notice in the same slot as the queued-message
     pill above — set only on a SUCCESSFUL plan/quiz build (see onDone below
     and the quiz try-block), never on error, so it can't misreport a failed
     build as ready. Self-clears after a few seconds; showReadyNotice below
     is the only way anything sets it, so one build finishing can't leave a
     stale notice from an earlier one still on screen. */
  const [readyNotice, setReadyNotice] = useState(null)
  // Text survives into the exit animation below — `readyNotice` itself goes
  // null the instant a new one replaces it or the timer clears it, which is
  // exactly when the fading-out node still needs something to show.
  const [lastReadyNotice, setLastReadyNotice] = useState(null)
  // Bumped on every call so each new notice — even back-to-back days with
  // different text — gets a fresh `key` below and replays the pop-in
  // animation instead of the DOM node just having its text swapped in place.
  const [readyNoticeSeq, setReadyNoticeSeq] = useState(0)
  const readyNoticeTimerRef = useRef(null)
  const showReadyNotice = useCallback((text) => {
    if (readyNoticeTimerRef.current) clearTimeout(readyNoticeTimerRef.current)
    setReadyNotice(text)
    setLastReadyNotice(text)
    setReadyNoticeSeq((n) => n + 1)
    readyNoticeTimerRef.current = setTimeout(() => {
      readyNoticeTimerRef.current = null
      setReadyNotice(null)
    }, 4000)
  }, [])
  useEffect(() => () => clearTimeout(readyNoticeTimerRef.current), [])
  // 150ms to match .fa-chip-exit, the same shrink-and-fade this app already
  // uses elsewhere for a small chip disappearing in place.
  const readyNoticeExit = useExitTransition(Boolean(readyNotice), 150)
  /* Which week a NEW plan will be built for. Null means "auto" — the
     next-unplanned week (autoWeek, below) — until a ?week= param overrides
     it, which is how the Library hands a specific week over.

     Whichever it resolves to is pinned onto the new chat and named in the
     Greeting (see conversationWeek): the
     teacher used to find out which week they got only after a 30-second
     generation, from the finished document's own header. That naming lived
     on the Greeting's starter suggestions until those were removed, which
     silently took the answer with it — hence naming it in plain copy, and
     in the composer's own chip, rather than as a suggestion. */
  const [selectedWeek, setSelectedWeek] = useState(null)

  /* The document is now open by default so users can immediately see the lesson plan/artifacts. */
  const [expanded, setExpanded] = useState(true)
  /* What `expanded` actually shows — the plan itself (ArtifactPanel, the
     original and only option until now) or one of the rail's other rows,
     rendered through the shared embossed shell in ArtifactDetailPanel.
     `viewingQuiz`/`viewingDoc` carry the one piece of data each of those
     needs that isn't already in scope some other way. */
  const [viewKind, setViewKind] = useState('plan')
  const [viewingQuiz, setViewingQuiz] = useState(null)
  const [viewingDoc, setViewingDoc] = useState(null)
  /* The drawer's own open/closed state — separate from `expanded`, which is
     the FULL docked/overlay document. Starts closed (just the handle) for
     every chat; the effect below pulls it open the moment there's a reason
     to, and only that transition forces it — closing it again afterward is
     never overridden by a render where nothing changed. */
  const [railOpen, setRailOpen] = useState(false)
  /* Whether the auto-open effect has already fired for THIS chat. `busy`
     goes true/false on every single turn (a revision, a follow-up message,
     a quiz build) — not just the first one — so without this guard the
     effect's deps changed on every turn and force-reopened the drawer even
     after the teacher had deliberately closed it. Reset alongside
     `railOpen` itself wherever that resets to false. */
  const railAutoOpenedRef = useRef(false)
  /* Mobile plan peek: a first build opens the lightweight sheet above the
     composer once the saved plan is actually ready. Revisions do not force it
     back open after a teacher has intentionally collapsed it. Existing plans
     loaded when a chat is reopened also stay collapsed until the teacher asks
     to see them. */
  const [planPeekOpen, setPlanPeekOpen] = useState(false)
  const planBuildStartedRef = useRef(false)
  const [revising, setRevising] = useState(false)
  // A quiz build is its own busy state, not folded into `revising` — the
  // two can genuinely overlap (asking for a quiz while a revision request
  // from a moment ago is still finishing), and ArtifactRail needs to show
  // "Building quiz…" independent of whatever the plan itself is doing.
  const [quizBuilding, setQuizBuilding] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  /* True from the instant submit() is called until either stream/chatStream
     picks up the busy flag on its own (both flip isStreaming synchronously
     the moment they're invoked) or submit bails out. This exists because
     submit's FIRST await, for a brand-new chat, is api.createChat — and on a
     cold Render instance or a flaky phone connection that round trip can run
     long, with `busy` still false the entire time. The teacher's message
     appeared, and then nothing: no spinner, no "Building…", nothing to show
     the app had even heard them. */
  const [preparing, setPreparing] = useState(false)
  // Whether the live voice-conversation overlay is open. What "Chat" opens
  // now, everywhere it appears (Composer's icon, Greeting's pill) — see
  // VoiceModePanel for why this replaced a quiet on/off toggle.
  const [voiceOpen, setVoiceOpen] = useState(false)
  /* The voice caption used to be state HERE, set at the moment text was handed
     to the TTS queue, and the panel then typed it out character by character
     hoping to land near the audio. It never did — see VoiceProvider's `caption`
     comment for the arithmetic. It's now owned by VoiceProvider, which is the
     only place that knows when a sentence actually becomes audible, and read
     straight off `voice.caption` where the panel is mounted below. Every
     setVoiceCaption call that used to sit alongside a speak()/enqueue() call is
     gone with it: the thing that speaks the text is now the thing that captions
     it, so the two cannot disagree. */
  // The card stack: what's actually been decided in the conversation so
  // far, per api.getDecisions — re-read after every new message while
  // voice mode is open (see the effect further down). Empty is a normal
  // state, not a loading one: nothing has necessarily been settled yet.
  const [decisions, setDecisions] = useState([])
  /* Which cell is being tweaked, and which cells just changed. `flashCells` is
     the only animation in the app that carries information: it answers "what
     changed?" without anyone having to build a diff view. */
  const [openTweak, setOpenTweak] = useState(null)
  const [flashCells, setFlashCells] = useState(() => new Set())
  // Whichever viewer is open (ArtifactPanel or ArtifactDetailPanel) reports
  // its own "maximize" click here — see either one's onFullscreenChange
  // effect for why the class actually has to land on .artifact-overlay
  // (below) rather than the doc-shell div inside it that clicked the button.
  const [artifactFullscreen, setArtifactFullscreen] = useState(false)
  /* The doc overlay is ALWAYS portaled to document.body now, never
     conditionally switched between "rendered in place" and "portaled" —
     that switch used to change the overlay's position in the fiber tree
     (plain element one render, wrapped in a Portal the next), which React
     treats as a full unmount/remount of everything inside, including
     ArtifactPanel's own isFullscreen state. The maximize button set that
     state true, the resulting remount reset it straight back to false in
     the same tick — "clicking maximize does nothing" was that reset, not a
     missing click handler. Same fix as composerAnchorRef/portalHost just
     above: one host node, created once, whose box is kept in sync with
     overlayAnchorRef's rect (see the effect below) instead of switching
     containers. */
  const overlayAnchorRef = useRef(null)
  const [overlayPortalHost] = useState(() => {
    const el = document.createElement('div')
    el.style.position = 'fixed'
    el.style.zIndex = '100'
    // Closed by default: this host is never removed from the DOM (only its
    // *contents* are conditionally portaled in, further down), so left at
    // the browser's default 'auto' it sat over the full viewport — full
    // window-sized per the sync effect below whenever overlayAnchorRef
    // hadn't measured yet — silently eating every click underneath it
    // (sidebar chat links, the rail's own "open document" row) even while
    // no document was open. Flipped to 'auto' only while the overlay is
    // actually mounted (see the effect keyed on overlayExit.mounted).
    el.style.pointerEvents = 'none'
    return el
  })
  useEffect(() => {
    document.body.appendChild(overlayPortalHost)
    return () => document.body.removeChild(overlayPortalHost)
  }, [overlayPortalHost])
  // Fullscreen: the host becomes the true viewport. Docked: the host
  // becomes exactly the box #main used to provide for free (before this
  // was always portaled, .artifact-overlay's own position:fixed picked up
  // #main as its containing block, since #main's backdrop-filter/transform
  // make it one) — .artifact-overlay's own left:64px etc. (base.css) still
  // does the rest, unchanged, now measured explicitly instead of inherited
  // by accident.
  useEffect(() => {
    const anchor = overlayAnchorRef.current
    const sync = () => {
      if (artifactFullscreen || !anchor) {
        overlayPortalHost.style.top = '0px'
        overlayPortalHost.style.left = '0px'
        overlayPortalHost.style.width = '100vw'
        overlayPortalHost.style.height = '100vh'
        return
      }
      const r = anchor.getBoundingClientRect()
      overlayPortalHost.style.top = `${r.top}px`
      overlayPortalHost.style.left = `${r.left}px`
      overlayPortalHost.style.width = `${r.width}px`
      overlayPortalHost.style.height = `${r.height}px`
    }
    sync()
    const ro = new ResizeObserver(sync)
    if (anchor) ro.observe(anchor)
    window.addEventListener('resize', sync)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', sync)
    }
  }, [artifactFullscreen, overlayPortalHost])
  /* The composer dock is portaled to document.body — see composerAnchorRef's
     own comment near chatPane's return for why — which needs two pieces of
     plumbing: an invisible ANCHOR left in the dock's normal flow position
     (composerAnchorRef, sized to composerDockH so the transcript above it
     doesn't grow into the space the floating dock is covering) and a host
     node the portaled content actually renders into (portalHost), kept
     positioned over the anchor.

     One detached DOM node, created once and never replaced — createPortal
     needs a real node to target, and body.appendChild/removeChild below
     handle its lifetime; nothing here re-creates it on re-render. */
  const [portalHost] = useState(() => {
    const el = document.createElement('div')
    el.style.position = 'fixed'
    el.style.zIndex = '200'
    // The host's own box is only ever as large as the anchor's rect (kept in
    // sync below) — this is a fallback for the first paint, before that sync
    // has run once, so an unstyled 0x0-but-static div can't eat a click.
    el.style.pointerEvents = 'none'
    // left/width, not top: opening the document unmounts ArtifactDrawer
    // (see its own comment near chatPane's return), which widens the chat
    // pane — and this anchor along with it — in the SAME instant the
    // overlay starts its own slide. Without a transition here that read as
    // the composer visibly changing shape a beat before the glass panel
    // caught up to explain why, instead of the "floating, unmoved" feel a
    // portaled dock is supposed to give (Josh's own ask, 2026-08-27). Same
    // 520ms/--ease-glide as .artifact-overlay's own entrance (base.css) —
    // matching curves is what makes these read as one motion instead of
    // two unrelated things that happen to start at the same time. top is
    // left alone on purpose — that one only changes from the composer's
    // OWN content growing (an attachment chip, the textarea autosizing),
    // where instant is what typing should feel like.
    el.style.transition = `left 520ms var(--ease-glide), width 520ms var(--ease-glide)`
    return el
  })
  useEffect(() => {
    document.body.appendChild(portalHost)
    return () => document.body.removeChild(portalHost)
  }, [portalHost])

  const composerAnchorRef = useRef(null)
  const composerDockRef = useRef(null)
  const [composerDockH, setComposerDockH] = useState(0)
  // Keeps the host's left/top/width matched to the anchor's live rect — the
  // anchor never moves for its OWN reasons (it's a plain shrink-0 flex
  // child), but the chat column it lives in resizes when the plans rail
  // toggles, the window resizes, or the composer's own content changes
  // height (attachments, the autosizing textarea, a banner) — anything that
  // changes the anchor's box needs the host to follow.
  useEffect(() => {
    const anchor = composerAnchorRef.current
    if (!anchor) return
    const sync = () => {
      const r = anchor.getBoundingClientRect()
      portalHost.style.left = `${r.left}px`
      portalHost.style.top = `${r.top}px`
      portalHost.style.width = `${r.width}px`
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(anchor)
    window.addEventListener('resize', sync)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', sync)
    }
  }, [portalHost])
  // The portaled dock's OWN rendered height, fed back to the anchor (below)
  // so the anchor reserves exactly the space the floating dock actually
  // needs — otherwise the transcript would sit a fixed guess-height short of
  // (or under) wherever the dock currently is.
  useEffect(() => {
    const el = composerDockRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setComposerDockH(entry.contentRect.height))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const scrollRef = useRef(null)
  const endRef = useRef(null)
  // Every rendered message's own DOM node, by id — see the ref callback on
  // each row below and pinToTopIdRef's own comment just under this.
  const messageRefs = useRef(new Map())
  /* Set the moment a new turn's own user message is pushed (see submit()) —
     the scroll effect below reads it once, scrolls THAT message's top to
     the top of the transcript, then clears it. Was: every new chunk of a
     streaming reply re-snapped the view to the very BOTTOM of everything
     (endRef), which for any reply longer than one screen meant finishing
     already scrolled past its own opening line — reading it back required
     scrolling back up by hand every single time. Pinning the NEW message's
     top instead means the exchange starts exactly where a teacher would
     look for it, and the reply just grows into the room below rather than
     dragging the viewport down after it. */
  const pinToTopIdRef = useRef(null)
  // 'bottom' (chase the very end, e.g. an existing conversation just
  // loaded) or 'pinned' (a turn's start is pinned; don't chase anything
  // until the next one begins). Reset to 'bottom' wherever `messages` is
  // replaced wholesale rather than appended to — see the chat-load effect.
  const scrollModeRef = useRef('bottom')

  const activeChat = chats.find((c) => c.id === chatId)
  useDocumentTitle(activeChat?.title || (chatId ? 'New plan' : null))

  const autoWeek = useMemo(() => firstUnplanned(calendar?.weeks), [calendar])
  const effectiveWeek = selectedWeek ?? autoWeek?.week ?? null
  /* Which week THIS CONVERSATION is about — the one stable answer, read back
     off the chat rather than recomputed.

     effectiveWeek above is derived from the calendar, so it drifts: build
     week 3 and firstUnplanned starts answering "week 4" for the very chat
     still discussing week 3. Once a chat exists, its own pinned week_number
     (db.py migration 23) is the truth; effectiveWeek only decides what a
     BRAND-NEW chat will pin.

     Null for chats created before the column existed — deliberately not
     falling back to effectiveWeek there, since that's exactly the drifted
     value this exists to stop trusting. Those chats behave as they do
     today: no week in the prompt, no chip. */
  const conversationWeek = chatId ? (activeChat?.week_number ?? null) : effectiveWeek
  /* The whole week row behind it, not just the number — the Greeting and the
     composer's chip both want the dates too. */
  const displayWeek = useMemo(
    () => (calendar?.weeks || []).find((w) => w.week === conversationWeek) || null,
    [calendar, conversationWeek]
  )
  /* Every week worth offering: never a week the school is shut, never one
     already behind us — EXCEPT the one this chat is already pinned to, which
     stays listed however old it is. Dropping it would leave the select with
     no matching option and render blank, which is the one thing this control
     exists to prevent. */
  const weekOptions = useMemo(() => {
    const weeks = calendar?.weeks || []
    return weeks.filter((w) => !w.no_school && (!w.is_past || w.week === conversationWeek))
  }, [calendar, conversationWeek])

  /* Change which week this conversation is planning. Three cases, because
     "the week" means something different depending on how far along the chat
     is:

     1. Nothing created yet — the value is just what createChat will pin, so
        setSelectedWeek is the whole job.
     2. A chat exists but hasn't produced a plan — re-pin it for real
        (PATCH /chats/{id}/week). Written into the chats cache first so the
        select moves under the teacher's finger rather than after a
        round trip; invalidated on failure so a rejected write doesn't leave
        a wrong week sitting on screen.
     3. A plan already exists — its document, its download and the rail all
        belong to that week, and quietly re-pointing the chat would put the
        pin and the artifact into disagreement. A different week's plan is a
        different conversation, so this opens one (the same ?week= route
        ClassPage's week list uses). */
  const changeWeek = useCallback(
    async (week) => {
      if (!week || week === conversationWeek) return
      if (!chatId) {
        setSelectedWeek(week)
        return
      }
      if (artifact?.planId) {
        navigate(`/c/${classId}?week=${week}`)
        return
      }

      const chatsKey = qk.chats(classId)
      // Stop any in-flight GET for this class's chat list before writing the
      // optimistic value — otherwise a straggling fetch that started before
      // the PATCH can resolve afterward and silently overwrite it.
      await qc.cancelQueries({ queryKey: chatsKey })

      qc.setQueryData(chatsKey, (old) =>
        (old || []).map((c) => (c.id === chatId ? { ...c, week_number: week } : c))
      )

      try {
        const updated = await api.setChatWeek(chatId, week)
        // Re-assert the server-confirmed week so a later, unrelated refetch of
        // this same key (sidebar, HistoryPage, another mutation's invalidate)
        // can't reintroduce a stale week_number if it started before this
        // PATCH resolved.
        qc.setQueryData(chatsKey, (old) =>
          (old || []).map((c) =>
            c.id === chatId ? { ...c, week_number: updated?.week_number ?? week } : c
          )
        )
      } catch (err) {
        qc.invalidateQueries({ queryKey: ['chats'] })
        toast.apiError('Could not change the week', err)
      }
    },
    [chatId, classId, conversationWeek, artifact?.planId, navigate, qc, toast]
  )

  /* Which chat the in-memory transcript currently belongs to.
   *
   * When it already matches the chat we are opening, LOCAL STATE IS THE TRUTH
   * and re-reading the server is not merely redundant, it is destructive:
   * submit() navigates to the new chat the moment it exists, which changes
   * chatId and fires the loader below while the POST saving the first message
   * is still in flight. The loader won, read back an empty conversation, and
   * setMessages([]) over the message the teacher had just typed — so the
   * question vanished, the transcript sat blank for about a second, and the
   * answer arrived attached to nothing. Reproduced at 400ms of write latency;
   * on a cold Render instance the window is far wider.
   *
   * A ref keyed to the CHAT, not a "we made this one" flag: leaving a chat you
   * created and coming back must re-read the server like any other
   * conversation, or you would be shown the transcript of wherever you had
   * been in the meantime. Comparing ids makes the skip idempotent too, which
   * matters because StrictMode double-invokes effects in dev. */
  const localFor = useRef(null)

  /* The id of the placeholder message a plain chat reply streams into, while
     it's in flight — see chatStream's onDone below and the two
     chatStream.start() call sites in submit(). Was: the growing reply
     rendered as a wholly separate element (key 'chat-stream-live') outside
     `messages`, so the instant it finished, that element unmounted and the
     REAL message mounted fresh in its place, replaying Message.jsx's
     mount-in spring on text the teacher had already finished reading — the
     single biggest "jarring" moment in the whole transcript. Streaming
     straight into a real, stable `messages` entry means the reply is the
     same DOM node throughout: it settles (Message.jsx's own fa-settle) when
     `streaming` flips false instead of disappearing and reappearing. */
  const liveMessageIdRef = useRef(null)

  /* Turns whatever's mid-flight into its resting state instead of leaving it
     stuck at streaming:true forever — the interruption paths (Stop button,
     a spoken utterance barging in) abort the network call directly, which
     never reaches onDone. Empty (nothing streamed yet) is dropped rather
     than left as an empty bubble. */
  const finalizeLiveMessage = useCallback(() => {
    const id = liveMessageIdRef.current
    liveMessageIdRef.current = null
    if (!id) return
    setMessages((prev) =>
      prev
        .map((m) => (m.id === id ? { ...m, streaming: false } : m))
        .filter((m) => m.id !== id || m.content.trim())
    )
  }, [])

  /* reviseDay is declared further down this component (it's the per-cell
     revise handler, defined near the document it edits), but submit() —
     declared above it — needs to call it for the update_lesson_day tool
     call. Same reasoning as submitRef below: a plain closure over reviseDay
     from inside submit would either be a temporal-dead-zone crash (it isn't
     defined yet at the point submit's own useCallback runs) or, listed in
     submit's dependency array, the exact same crash a render earlier. Kept
     current via the plain assignment right after reviseDay's own
     declaration. */
  const reviseDayRef = useRef(null)

  /* The last message id VoiceProvider has already spoken (or been told to
     skip, on history load — see below). Primed to the newly-loaded
     transcript's own last id the moment a conversation opens, so opening an
     old chat with ten messages doesn't queue up ten replies of audio; only a
     message that arrives AFTER that point — a live reply — gets spoken. */
  const lastSpokenRef = useRef(null)

  /* ── load an existing conversation and whatever plan it produced ──────── */
  useEffect(() => {
    let cancelled = false
    /* Neither stream aborts on its own when the chat under it changes — only
       on unmount or an explicit Stop click. Navigate away from a chat mid-
       generation (sidebar click, "New plan") and the old fetch keeps running;
       when it eventually resolves, onDone still fires and writes into
       whatever `messages`/`artifact` state is on screen BY THEN, and persists
       via `localFor.current`, which has already moved to the new chat. A week
       built for chat A lands in chat B's transcript and database row. Both
       are safe no-ops when nothing was in flight.

       This USED to call stop() unconditionally, before either check below —
       which silently killed the first message of every brand-new chat.
       submit() creates the chat, sets localFor.current to its id, calls
       navigate() to put that id in the URL, and only THEN calls
       chatStream.start() for the very message that created it. That
       navigate() changes `chatId`, which re-runs this effect — and by the
       time it does, stream.start()'s fetch is already in flight. The old
       code stopped both streams first and checked `localFor.current ===
       chatId` (true, so "nothing to catch up on") second, meaning it aborted
       the request it was about to recognize as its own. Confirmed live: the
       chat_stream POST never even reached the backend, twice, on two
       different first messages — this, not anything upstream, is why a new
       conversation "does not work a lot of the times." Checking both guards
       BEFORE stopping anything fixes it: a chatId this component already
       considers current — whether from a prior load or from the create it
       just did — has nothing to stop and nothing to catch up on. */
    if (!chatId) {
      stream.stop()
      chatStream.stop()
      setMessages([])
      scrollModeRef.current = 'bottom'
      setArtifact(null)
      setArtifactLoadError(false)
      setExpanded(false)
      setViewKind('plan')
      setViewingQuiz(null)
      setViewingDoc(null)
      setRailOpen(false)
      railAutoOpenedRef.current = false
      setPlanPeekOpen(false)
      planBuildStartedRef.current = false
      setSelectedWeek(null)
      localFor.current = null
      lastSpokenRef.current = null
      liveMessageIdRef.current = null
      setDecisions([])
      return undefined
    }
    // The transcript on screen is already this chat's — nothing to catch up on.
    if (localFor.current === chatId) return undefined

    // Genuinely switching to a different, already-existing conversation —
    // NOW it's safe to stop whatever the old one had running.
    stream.stop()
    chatStream.stop()
    liveMessageIdRef.current = null

    /* Drop the previous conversation's artifact NOW, not when the fetch
       resolves. Otherwise the rail and the open document keep showing the last
       chat's week under the new chat's heading for as long as the round trip
       takes — measured at ~100-200ms locally, and it reads as the app showing
       you the wrong plan. */
    setArtifact(null)
    setArtifactLoadError(false)
    setOpenTweak(null)
    setExpanded(false)
    setViewKind('plan')
    setViewingQuiz(null)
    setViewingDoc(null)
    setRailOpen(false)
    railAutoOpenedRef.current = false
    setPlanPeekOpen(false)
    planBuildStartedRef.current = false

    // A reopened phone chat often hits the API just as a cellular connection
    // is waking up. One immediate retry simply repeated the same failed
    // connection and then hid an existing plan. Use a short bounded backoff:
    // enough to recover a transient request without turning a real outage into
    // a forever-loading document.
    const getPlanWithRetry = async (id) => {
      let lastError
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await api.getPlan(id)
        } catch (error) {
          lastError = error
          if (attempt < 2) await waitBeforeRetry(300 * (attempt + 1))
        }
      }
      throw lastError
    }

    api
      .getChat(chatId)
      .then(async (row) => {
        if (cancelled) return
        const loaded = (row.messages || []).map((m) => ({
          id: nextId(),
          role: m.role,
          content: m.content,
          planId: m.plan_id || null,
          created_at: m.created_at || null,
        }))
        setMessages(loaded)
        scrollModeRef.current = 'bottom'
        localFor.current = chatId
        lastSpokenRef.current = loaded.length ? loaded[loaded.length - 1].id : null
        const last = [...loaded].reverse().find((m) => m.planId)

        if (!last) {
          /* No message names a plan — but the chat may still HAVE one.
             Until the assistant message started being persisted, generation
             wrote the plan (with its chat_id) and nothing else, so every week
             built before that fix was stranded: the conversation reopened with
             no artifact, no rail and no way to the .docx, even though the row
             was sitting in the database the whole time. The plan knows which
             chat it came from, so ask it directly. */
          let items
          try {
            ;({ items = [] } = await api.listPlans({ chat_id: chatId, limit: 1 }))
          } catch {
            if (!cancelled) setArtifact(null)
            return
          }
          if (cancelled) return
          if (!items[0]) {
            // Genuinely nothing built for this chat — the "before a plan
            // exists" case the "plan so far" list (decisions.length) is for.
            setArtifact(null)
            return
          }
          try {
            // The list view drops plan_json (db.list_plans pops it), so the
            // week itself still has to be fetched by id.
            const plan = await getPlanWithRetry(items[0].id)
            if (cancelled) return
            setArtifact({
              planId: plan.id,
              plan: plan.plan_json,
              warnings: plan.warnings,
              retrievedIds: plan.retrieved_ids,
              unit: plan.unit,
            })
          } catch {
            // A real plan_id came back from listPlans — this is "exists but
            // failed to load," not "doesn't exist yet."
            if (!cancelled) setArtifactLoadError(true)
          }
          return
        }

        try {
          const plan = await getPlanWithRetry(last.planId)
          if (cancelled) return
          setArtifact({
            planId: plan.id,
            plan: plan.plan_json,
            warnings: plan.warnings,
            retrievedIds: plan.retrieved_ids,
            unit: plan.unit,
          })
          /* Attach the week to the message that produced it, so a reopened
             conversation still carries its own verification rather than making
             the teacher open the document to see what was built. Only the last
             one: the earlier plan_json values are gone — the row is updated in
             place — and inventing a week strip for them would be worse than
             showing none. */
          setMessages((prev) =>
            prev.map((m) =>
              m.id === last.id
                ? { ...m, plan: plan.plan_json, retrievedCodes: plan.retrieved_ids }
                : m
            )
          )
        } catch {
          // last.planId came from a persisted message — this plan is known
          // to exist, so a failed fetch is "exists but failed to load," not
          // "doesn't exist yet."
          if (!cancelled) setArtifactLoadError(true)
        }
      })
      .catch(() => !cancelled && toast.error("Couldn't open that conversation"))
    return () => {
      cancelled = true
    }
    // stream/chatStream deliberately excluded: their .stop() is a stable
    // useCallback closed over a ref, so even this closure's "stale" copy
    // still aborts whatever is actually in flight — see useLessonStream.js.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, toast, artifactRetryTick])

  // The rail's Reload button, for the "a real plan exists and its fetch
  // failed" case. localFor.current already equals chatId by the time
  // artifactLoadError can be true (it's set right after getChat succeeds,
  // before the plan-specific fetch that can fail) — so the load effect's own
  // "already loaded this chat" guard would otherwise skip a bare re-run.
  // Clearing it here is what makes bumping artifactRetryTick actually redo
  // the fetch instead of being a no-op.
  const retryArtifactLoad = useCallback(() => {
    localFor.current = null
    setArtifactLoadError(false)
    setArtifactRetryTick((t) => t + 1)
  }, [])

  /* ClassPage's week list links an unplanned week here as `?week=N`, the one
     way left to target a specific week rather than the auto-detected next
     unplanned one. One-shot: consumed into state and stripped from the URL
     immediately, so it can't go stale sitting in a bookmark or the back
     button.

     Declared AFTER the conversation loader above, not before: that effect
     resets selectedWeek to null on every mount with no chatId, and effects
     fire in declaration order — before this one moved down here, that reset
     ran on the same mount and clobbered the value this effect had just set. */
  useEffect(() => {
    const weekParam = searchParams.get('week')
    if (chatId || !weekParam) return
    setSelectedWeek(Number(weekParam))
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('week')
        return next
      },
      { replace: true }
    )
  }, [chatId, searchParams, setSearchParams])

  /* Back from Google's consent screen (routes/drive.py's /callback) — the
     browser lands right back on this same chat with ?drive=connected,
     cancelled, or error appended to whatever `return_to` was when Share was
     clicked. Same shape as BillingProvider's own "back from Stripe"
     handling: strip the marker first so a reload doesn't replay the toast,
     then react to it. There's nothing to poll for here the way a
     subscription's webhook needs — the connection either exists by the time
     this fires or it doesn't. */
  useEffect(() => {
    const outcome = searchParams.get('drive')
    if (!outcome) return
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('drive')
        return next
      },
      { replace: true }
    )
    if (outcome === 'connected') {
      toast.success('Google Drive connected', 'Open Share again to finish sending it.')
    } else if (outcome === 'cancelled') {
      toast.info('Google Drive wasn’t connected — nothing was shared.')
    } else if (outcome === 'error') {
      toast.error('Couldn’t connect Google Drive', 'Try again in a moment.')
    }
  }, [searchParams, setSearchParams, toast])

  /** Mark cells as just-changed. Cleared after the flash has finished playing. */
  const flash = useCallback((keys) => {
    if (!keys.length) return
    setFlashCells(new Set(keys))
    setTimeout(() => setFlashCells(new Set()), 2400)
  }, [])

  const stream = useLessonStream({
    onDone: (done) => {
      showReadyNotice('Lesson plan ready')
      setArtifact({
        planId: done.plan_id,
        plan: done.plan,
        warnings: done.warnings,
        retrievedIds: done.retrieved_ids ?? done.grounding?.codes,
        unit: done.unit,
      })
      // Was a flat "Built Week 12. Tell me what to change and I'll revise
      // it." — identical every single time regardless of what was actually
      // in it, at the one moment (a whole week just finished) that most
      // deserved to sound like a person handing off finished work instead
      // of a system toast. unitSuffix already knows not to repeat the week
      // number back when there's no real unit name to add (see its own
      // comment) — same guard SplitLayout and ArtifactRail lean on.
      const content = `${done.plan?.week_of || 'The week'} is built${unitSuffix(
        done.unit,
        ', centered on '
      )}. Take a look, and tell me what needs to change.`
      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: 'assistant',
          content,
          planId: done.plan_id,
          weekLabel: done.plan?.week_of,
          plan: done.plan,
          retrievedCodes: done.retrieved_ids ?? done.grounding?.codes,
          // Backend-computed (RetrievalResult.thin, retrieval.py) — fewer
          // than a handful of chunks matched this grade/subject. It has been
          // reaching the client in the SSE `grounding` event this whole
          // time and going nowhere: no message field read it, so a thin
          // week looked identical to a well-covered one. Grade 3 Science,
          // for instance, has only 15 chunks in the whole corpus — real,
          // groundable, but thin enough a teacher should know to double-
          // check it rather than assume the same depth AP Lang gets.
          thin: done.grounding?.thin,
        },
      ])
      /* SAVE IT. This was missing, and it did not merely lose a line of chat.
         The loader finds a conversation's plan by scanning its messages for a
         plan_id — so with no assistant message written, reopening a chat that
         had produced a week showed the question, no answer, and NO ARTIFACT:
         the .docx became unreachable from the conversation that made it.
         Confirmed against live data, where a freshly generated chat held one
         message and no plan_id at all.

         localFor.current, not chatId: for a chat created moments ago the route
         param has not necessarily caught up, and this is the id we just wrote
         the transcript under. */
      const saveTo = localFor.current
      if (saveTo) {
        void persistMessage(saveTo, { role: 'assistant', content, plan_id: done.plan_id })
      }
      qc.invalidateQueries({ queryKey: ['chats'] })
      // A week was just used. Re-read the entitlement so the next submit knows.
      refreshAuth()
    },
    onError: (err) => {
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'assistant', isError: true, content: err.message, hint: err.hint },
      ])
      // The server is the authority; if it refused on entitlement, show the
      // offer rather than only a toast the teacher can't act on.
      if (err.code === 'subscription_required') {
        refreshAuth()
        openPaywall()
        return
      }
      toast.apiError("Couldn't build that", err)
    },
  })

  /* Same "This week" list ArtifactRail already shows while building — one
     more place it lands: each day pops up here, above the composer, the
     moment its own title is known, then gets replaced by the next one
     (showReadyNotice's own clearTimeout+reset already does the "new one
     replaces the old" and "fades after a few seconds" behavior). Friday
     never gets its own pop this way — nothing arrives after it in the
     stream to signal it's closed — but "Lesson plan ready" lands right
     behind it regardless, so the gap is a day early, not a silent one. */
  const announcedDaysRef = useRef(new Set())
  useEffect(() => {
    if (stream.isStreaming) announcedDaysRef.current = new Set()
  }, [stream.isStreaming])
  useEffect(() => {
    if (!stream.isStreaming) return
    const days = stream.preview?.days || []
    // Only a day BEFORE the last one in the array is actually done writing —
    // the model streams days in order, so the last element is still being
    // filled in and its title may not have landed (or settled) yet.
    for (let i = 0; i < days.length - 1; i++) {
      const day = days[i]
      const name = day?.name
      if (!name || announcedDaysRef.current.has(name)) continue
      const title = dayTitle(day)
      if (!title) continue
      announcedDaysRef.current.add(name)
      showReadyNotice(`${SHORT_DAY[name] || name}: ${title}`)
    }
  }, [stream.preview, stream.isStreaming, showReadyNotice])

  const chatStream = useChatStream({
    onRetry: () => {
      if (voiceOpen) voice.cancelSpeech()
    },
    /* Voice mode's low-latency path: speak each sentence the moment the
       model finishes writing it, rather than waiting for the whole reply,
       then a whole TTS render, then playback. VoiceProvider queues these so
       they play back-to-back as one continuous utterance. No-op for the
       text chat, which never opens the panel. */
    onSentence: (sentence) => {
      if (!voiceOpen) return
      /* track: true marks this as part of the model's own streamed reply, so
         VoiceProvider records it as spoken once its audio actually starts —
         which is what VoiceProvider captions and the barge-in state use.
         App-authored interjections ("Building your week") are spoken too but
         deliberately aren't tracked; they're not part of the reply.

         The caption is no longer set here. VoiceProvider owns it now, because
         it's the only thing that knows when a sentence becomes audible rather
         than merely queued — see its own `caption` comment. */
      voice.speak(sentence)
    },
    onDone: (result) => {
      // The placeholder pushed right before chatStream.start() (both call
      // sites, in submit()) — every branch below settles it in place rather
      // than pushing a separate message, so the reply the teacher was
      // already watching stream in is the SAME element that lands, not one
      // that vanishes and gets replaced. See liveMessageIdRef's own comment.
      const liveId = liveMessageIdRef.current
      liveMessageIdRef.current = null
      const settle = (patch) =>
        setMessages((prev) =>
          liveId && prev.some((m) => m.id === liveId)
            ? prev.map((m) => (m.id === liveId ? { ...m, ...patch, streaming: false } : m))
            : [...prev, { id: nextId(), ...patch }]
        )

      // The guided alternative to typing — see LessonQuestions and
      // backend/llm.py's ask_clarifying_questions tool. Rendered as its own
      // message (Message.jsx reads `questions` off it) rather than routed
      // through submit()'s caller: this can fire from the very first message
      // in a chat, before there's any other branch left to react to it.
      // Persisted as plain text (the interactive cards are session-local,
      // same tradeoff as the week-strip-only persistence elsewhere) so
      // reopening the chat still shows what was asked, even though it's no
      // longer clickable.
      if (result?.questions?.length) {
        // Just the first line, even though the prompt (generate.py) now
        // asks the model for one short line here and nothing more — a
        // model that still narrates every question in prose duplicates
        // the interactive card immediately below it, one-shot back to a
        // tall wall of text instead of the one-question-at-a-time flow
        // that card exists for. Belt-and-suspenders, not a substitute for
        // the prompt fix: this can only shorten what shows, not improve it.
        const intro =
          result.text?.trim().split('\n')[0]?.trim() || 'A couple of quick questions to get this right:'
        settle({
          role: 'assistant',
          content: intro,
          questions: result.questions,
          // What voice mode says out loud — the questions themselves, but
          // NOT their options: those render as tappable cards in the panel
          // (see VoiceModePanel's QuestionCards), and reading a list of
          // choices aloud that the teacher can already see and tap is both
          // slower and harder to answer. `spokeStream` means the intro
          // already went out sentence-by-sentence while the model was
          // writing it, so repeating it here would say it twice.
          spokenContent: speakableQuestions(result.spokeStream ? '' : intro, result.questions),
        })
        const saveTo = localFor.current
        if (saveTo) {
          const asText = result.questions.map((q) => `• ${q.text}`).join('\n')
          void persistMessage(saveTo, { role: 'assistant', content: `${intro}\n\n${asText}` })
        }
        qc.invalidateQueries({ queryKey: ['chats'] })
        return
      }
      // If the chat model just had a conversation (no tool call), we save the text.
      // If it called the tool, we save the text (e.g. "I'll make that plan now!") and then
      // trigger the actual plan build from the submit function.
      if (result?.text?.trim()) {
        settle({
          role: 'assistant',
          content: result.text,
          // Already read aloud a sentence at a time as it streamed — the
          // auto-speak effect below skips it rather than saying the whole
          // reply a second time.
          spokenLive: Boolean(result.spokeStream),
        })
        const saveTo = localFor.current
        if (saveTo) {
          void persistMessage(saveTo, { role: 'assistant', content: result.text })
        }
        qc.invalidateQueries({ queryKey: ['chats'] })
        return
      }
      // Neither questions, text, nor a tool call — the backend is meant to
      // turn this exact case into a real error now (see backend/llm.py's
      // empty_reply/malformed_tool_call), which lands in onError below
      // instead of here. This stays as a backstop: a message that got no
      // reply used to just sit there with nothing under it and nothing to
      // explain why, which is what made the chat read as randomly broken.
      // `quizRequested` is excluded for the same reason `toolCalled` is —
      // it's ANOTHER real reply (see its own branch in submit()), just one
      // this callback doesn't render itself. Without this, a quiz request
      // that came back with no chat text of its own (the common case) hit
      // this backstop and showed "Didn't get a reply back" a beat before
      // submit()'s own "Built ... Quiz" message landed right under it.
      if (!result?.toolCalled && !result?.quizRequested) {
        settle({
          role: 'assistant',
          isError: true,
          content: "Didn't get a reply back.",
          hint: 'Try sending that again.',
        })
      } else if (liveId) {
        // A tool call with nothing said first — drop the now-empty
        // placeholder; submit()'s own dedicated follow-up ("Building your
        // quiz now…", "Updating the week now…") is the message that shows.
        setMessages((prev) => prev.filter((m) => m.id !== liveId))
      }
    },
    onError: (err) => {
      // Same placeholder as onDone above — a request that fails still owns
      // one, and it should turn into the error rather than leave an empty,
      // permanently-streaming bubble sitting above a second, separate one.
      const liveId = liveMessageIdRef.current
      liveMessageIdRef.current = null
      setMessages((prev) =>
        liveId && prev.some((m) => m.id === liveId)
          ? prev.map((m) =>
              m.id === liveId
                ? { ...m, isError: true, content: err.message, hint: err.hint, streaming: false }
                : m
            )
          : [...prev, { id: nextId(), role: 'assistant', isError: true, content: err.message, hint: err.hint }]
      )
      toast.apiError("Chat failed", err)
    },
  })

  const busy = stream.isStreaming || revising || chatStream.isStreaming || preparing

  useEffect(() => {
    if (!isPhone) {
      planBuildStartedRef.current = false
      return
    }
    // Only the initial build opens the peek. A revision keeps the teacher's
    // chosen collapsed/open state, and a plan fetched while reopening a chat
    // never looks like a new completion.
    if (busy && !artifact?.planId) {
      planBuildStartedRef.current = true
      return
    }
    if (!busy && artifact?.planId && planBuildStartedRef.current) {
      planBuildStartedRef.current = false
      setPlanPeekOpen(true)
    }
  }, [artifact?.planId, busy, isPhone])

  /* Opening the panel is itself a real click — the one gesture VoiceProvider
     needs to unlock playback on THIS page load (see its own comment on
     unlock()). Turning spoken replies on here too, unconditionally: opening
     a voice conversation and not hearing it back would be the single most
     confusing state this feature could land in.

     A fresh conversation gets greeted rather than opening to silence and an
     empty transcript — dropping a teacher into "say something" with no idea
     the mic is even listening yet. Only when there's nothing said already:
     reopening voice mode on a chat mid-conversation should pick back up
     where it left off, not re-introduce itself over the top of it. */


  /* A realtime session needs a chat_id before it can even open — its
     system prompt (resolve_conversation_context) resolves class/subject/
     week from it — unlike submit()'s lazy creation, which always has some
     typed text to name the chat's placeholder title with. Mirrors that
     same creation block; kept separate rather than shared so neither
     path's error handling has to account for the other's caller. */
  const openVoice = useCallback(() => {
    // Voice Mode is beta-gated (SettingsPage.jsx's "Enable Beta Features")
    // — the visible entry points (Greeting, Composer) already hide
    // themselves when it's off, but this also covers the ⌘⇧V shortcut
    // below, which has no button to hide.
    if (!betaFeaturesEnabled) {
      toast.info('Voice Mode is a beta feature', 'Turn on Beta Features in Settings to try it.', {
        label: 'Open Settings',
        onClick: () => navigate(`/c/${classId}/settings#section-advanced`),
      })
      return
    }
    // This is the deliberate user gesture that creates the one Realtime
    // session. Speech queued immediately afterward waits for the data channel.
    voice.startSession({ chatId: chatId ?? null, classId: classId ?? null, weekNumber: conversationWeek ?? null, mode: 'brainstorm' })
    setVoiceOpen(true)
    if (messages.length === 0) voice.speak(VOICE_GREETING)
  }, [voice, messages, chatId, classId, conversationWeek, betaFeaturesEnabled, toast, navigate])

  /* Factored out of the docked panel's own onClose so the ⌘⇧V hotkey below
     can end the conversation exactly the same way a click on Close does —
     silencing the shared <audio> element too (see its own comment), not
     just the panel's own local state. */
  const closeVoice = useCallback(() => {
    voice.stopSession()

    setVoiceOpen(false)
    setDecisions([])
  }, [voice])

  /* VoiceProvider is mounted once at the app root (App.jsx), above the
     router — it never unmounts on navigation, so nothing was ever stopping
     an open mic and a live WebRTC session from just staying connected in
     the background after a teacher switched chats or classes without
     clicking Voice Mode's own Close button first. React Router also
     doesn't remount ChatPage on a chatId-only change (:chatId is a param
     on the same route element), so this can't rely on unmount either — it
     has to watch the params directly.

     A ref, not `closeVoice` itself in the dependency array: `voice` (from
     useVoice()) is a useMemo'd object that gets a new reference on nearly
     every VoiceProvider state change — caption deltas, speaking toggling,
     connecting -> live — so closeVoice, which depends on [voice], is
     exactly as unstable. With closeVoice as a dependency here, opening
     Voice Mode triggered this same effect's OWN cleanup on the very next
     state change (e.g. status flipping to 'connecting'), which closed the
     session it had just opened — voiceOpen never had a chance to stay
     true. Keying only on [classId, chatId] and reading the latest
     closeVoice through a ref fixes that: this effect's cleanup now fires
     exactly when the route params actually change (or on unmount), not on
     every unrelated voice state update. */
  const closeVoiceRef = useRef(closeVoice)
  closeVoiceRef.current = closeVoice
  useEffect(() => {
    return () => closeVoiceRef.current()
  }, [classId, chatId])

  /* ⌘/Ctrl+Shift+V toggles voice mode from anywhere on the page — the same
     "reach for it without touching the mouse" convenience CommandK (App.jsx)
     already gives "start a new plan." Shift, not bare ⌘V: that's Paste, and
     stealing it would silently break pasting text into the composer. */
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'v') {
        e.preventDefault()
        if (voiceOpen) closeVoice()
        else openVoice()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [voiceOpen, openVoice, closeVoice])

  /* ── the one submit path ──────────────────────────────────────────────── */
  const submit = useCallback(
    async (text, options = {}) => {
      const typed = (text ?? query).trim()
      // `attachmentsOverride` is what a queued follow-up sends through —
      // see queueOrSubmit's own comment. Without it, a message queued
      // while busy would flush against whatever attachments happen to be
      // in the composer at THAT later moment (a plain empty-array default
      // if the composer's own chips already cleared, or a teacher's next
      // batch if they attached something new in the meantime), not the
      // ones actually present when they hit Enter.
      const atts = options.attachmentsOverride ?? attachments
      /* Attached files were extracted, confirmed with a toast reporting the
         character count, and then never sent: `attachments` was written by the
         Composer and read by nobody. The chip also stayed pinned after sending,
         so it looked like the document was still in context for every later
         message. It never was.

         Capped, because a 40-page PDF is both a context-window and a bill
         problem, and the truncation is stated in the text rather than silent. */
      const docs = atts
        .map((a) => {
          const body = String(a.text || '')
          const clipped = body.length > ATTACHMENT_CHAR_CAP
          return `--- ${a.filename}${clipped ? ' (truncated)' : ''} ---\n${
            clipped ? `${body.slice(0, ATTACHMENT_CHAR_CAP)}\n…[truncated]` : body
          }`
        })
        .join('\n\n')

      const content = docs ? `${docs}\n\n---\n\n${typed}` : typed
      // Guards on the COMBINED text, so an attachment with no typed message
      // sends — the send button was already enabled for that and did nothing.
      const voiceTurn = Boolean(options.voiceTurn)
      if (!content.trim() || (busy && !voiceTurn)) return
      setPreparing(true)
      setQuery('')
      // A sent message shouldn't leave a stale draft behind to reappear on
      // the next visit — see clearComposerDraft's own comment for why this
      // can't just wait on the debounced write-back noticing `query` went
      // empty.
      clearComposerDraft(draftKey)
      // The chip has to clear here, before any request goes out — the sent
      // files are captured in `content` below and folded into this turn's
      // payload; leaving the chip pinned implied they were still in context
      // for every later message, which was never true even before this fix.
      setAttachments([])
      const newUserMessage = { id: nextId(), role: 'user', content: typed || `Sent ${atts.length} file(s)` }
      const nextMessages = [...messages, newUserMessage]
      // See pinToTopIdRef's own comment — the scroll effect reads this once
      // and clears it, so the reply that's about to arrive doesn't drag the
      // view any further than this turn's own opening line.
      pinToTopIdRef.current = newUserMessage.id

      setMessages(nextMessages)

      let activeChatId = chatId
      if (!activeChatId) {
        try {
          // effectiveWeek is pinned onto the chat here, at creation, and is
          // what every later turn reads back (conversationWeek) instead of
          // recomputing — see db.py migration 23.
          //
          // Retried the same way persistMessage retries a save — this is
          // the one request in this whole path that used to fail outright
          // on a single dropped packet (a flaky school wifi's specialty)
          // with no second attempt, unlike everything downstream of it.
          let created
          let lastCreateErr
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              created = await api.createChat(
                (typed || atts[0]?.filename || 'New plan').slice(0, 80),
                classId,
                effectiveWeek,
                location.state?.mode
              )
              break
            } catch (err) {
              lastCreateErr = err
              if (attempt < 2) await waitBeforeRetry(250 * (attempt + 1))
            }
          }
          if (!created) throw lastCreateErr
          activeChatId = created.id
          localFor.current = created.id
          qc.invalidateQueries({ queryKey: ['chats'] })
          navigate(`/c/${classId}/chat/${created.id}`, { replace: true })

          /* Then give it a real name.
             The placeholder is the first 80 characters of whatever was typed,
             which is why the sidebar filled with rows reading "let's plan week
             2 of ap lang" twice over and "Plan a week around a text — I'll name
             it:" — the boilerplate, never the part that identifies the week.
             /api/chats/title exists precisely for this and had no callers; its
             own docstring describes being "called after the chat is already
             created with a truncated placeholder title".

             Deliberately not awaited: it is a second model call, it is purely
             cosmetic, and nothing about sending the first message should wait
             on it. Failure leaves the placeholder, which is what we have today. */
          const basis = typed || atts[0]?.filename
          if (basis) {
            api
              .suggestChatTitle(basis)
              .then(({ title }) => title && api.renameChat(created.id, title))
              .then(() => qc.invalidateQueries({ queryKey: ['chats'] }))
              .catch(() => {})
          }
        } catch (err) {
          // Silently continuing here used to mean a failed chat creation left
          // the message sitting on screen with no reply and no explanation —
          // indistinguishable from the app having simply not heard the teacher.
          //
          // navigator.onLine at the moment of the failure, not a live
          // isOnline value from a hook — this catch runs after 3 retries
          // already spent ~1s, and by then the device may have reconnected
          // on its own; what matters for THIS message is whether it was
          // actually offline when the attempt was made.
          setPreparing(false)
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: 'assistant',
              isError: true,
              content: "Couldn't reach the server to start that.",
              hint:
                typeof navigator !== 'undefined' && !navigator.onLine
                  ? "You're offline — this will retry once you're back on wifi or cell data."
                  : err?.hint || 'Check your connection and try again.',
            },
          ])
          toast.apiError("Couldn't send that", err)
          return
        }
      }

      const shown = typed || `Sent ${atts.length} file(s)`
      if (activeChatId) {
        // See db.add_message's own docstring for what this is for — a
        // spoken turn is plausibly less edited/considered than something
        // typed and reread, so it's worth being able to tell the two apart
        // later without having to guess after the fact.
        const saved = await persistMessage(activeChatId, {
          role: 'user',
          content: shown,
          ...(options.voiceTurn ? { source: 'voice' } : {}),
        })
        if (!saved) {
          setPreparing(false)
          return
        }
      }

      /* No plan in this chat yet -> build one. Used to skip chat_stream
         entirely and go straight to generation (see git history: "intent
         routing is deliberately dumb" — reintroducing a model choice here
         once regressed a fully-specified prompt into "want me to proceed?"
         instead of the week the composer promised). Reintroduced now, on
         request, but narrower than that earlier version: the model has
         exactly two ways to respond to a first message, generate_lesson_plan
         or ask_clarifying_questions (see backend/llm.py), and the system
         prompt is explicit that a request which already names a text/topic
         and a rough shape has enough to build from immediately — the same
         speed as before for anything specific enough to deserve it. Only a
         genuinely vague message ("I want to make a lesson") should ever see
         the clarifying-questions branch below instead of a plan appearing. */
      if (!artifact?.planId) {
        /* The paywall, asked before the wait rather than after it. The
           server enforces the same rule (entitlement.require_entitlement,
           called from every model-calling route now, including chat_stream)
           — this exists so a blocked teacher sees the offer immediately here
           instead of watching a progress indicator that was always going to
           end in a 402. */
        if (!mayGenerate) {
          setPreparing(false)
          openPaywall()
          // Same split as the paywall dialog itself (BillingProvider.jsx) and
          // the server's own two AppErrors (entitlement.require_entitlement)
          // — a trial that's over never resets, so telling that teacher to
          // "wait for it to reset" here would be exactly the false promise
          // this file's own comment above says the paywall exists to avoid.
          const trialExpired = !!entitlement?.trial_expired
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: 'assistant',
              isError: true,
              content: trialExpired ? 'Your free trial has ended.' : 'You’ve reached this week’s usage limit.',
              hint: trialExpired
                ? 'Subscribe to keep building — everything you’ve already made stays yours either way.'
                : 'Subscribe for a much higher limit, or wait for it to reset — everything you’ve already built stays yours.',
            },
          ])
          return
        }

        const firstPayload = [
          ...messages.map((m) => ({ role: m.role, content: m.content || m.planLabel || m.weekLabel || '' })),
          { role: 'user', content },
        ]
        setPreparing(false)
        liveMessageIdRef.current = nextId()
        setMessages((prev) => [
          ...prev,
          { id: liveMessageIdRef.current, role: 'assistant', content: '', streaming: true },
        ])
        // The same value just pinned onto the chat by createChat above, so
        // this first turn and every later one (see the second
        // chatStream.start below) name the identical week.
        const firstResult = await chatStream.start(firstPayload, {
          chatId: activeChatId,
          classId,
          voice: voiceOpen,
          weekNumber: effectiveWeek,
        })

        // Asked instead of building — onDone (above) already rendered the
        // question cards as their own message. Nothing left to do here
        // until the teacher answers, which re-enters submit() as a normal
        // message and lands right back in this same branch.
        if (firstResult?.questions?.length) return

        if (!firstResult || !firstResult.toolCalled) {
          // The model just replied (a clarifying remark, not a question
          // card) with no tool call at all — onDone already rendered that
          // text. Nothing to build yet.
          return
        }

        let firstHistory = [
          ...messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`),
          `USER: ${content}`,
        ].join('\n\n')
        if (firstResult.text?.trim()) {
          firstHistory += `\n\nASSISTANT: ${firstResult.text}`
        }
        /* Say something before disappearing for half a minute. When the
           model decides to build, it emits a tool call and NO text — fine
           in the text chat, where the week strip fills in visibly, but in a
           spoken conversation it lands as the assistant simply going silent
           mid-exchange, which is indistinguishable from it having broken. */
        if (voiceOpen) {
      voice.speak(VOICE_BUILDING)
        }
        // stream.start() flips stream.isStreaming synchronously before its
        // first await, so busy is already covered by the time preparing drops.
        stream.start(firstHistory, { chatId: activeChatId, weekNumber: effectiveWeek, classId }).catch(() => {})
        return
      }

      // A plan already exists, so this message is ambiguous between "just
      // talking about it" and "revise it" — that's the one case worth asking
      // the model to route, since a bare follow-up ("why Thursday?") shouldn't
      // silently rebuild the week.
      const payloadMessages = [
        ...messages.map((m) => ({ role: m.role, content: m.content || m.planLabel || m.weekLabel || '' })),
        { role: 'user', content },
      ]
      // Same handoff as above: chatStream.start() sets chatStream.isStreaming
      // synchronously, so busy stays continuously true across this call even
      // though we're about to `await` its whole run rather than fire-and-forget.
      setPreparing(false)
      /* conversationWeek, not effectiveWeek — and no longer omitted. This
         used to send no week at all, because effectiveWeek had drifted to
         the class's next unplanned week by now and would have named the
         wrong one. The cost was that generate.py's "THE TEACHER IS
         CURRENTLY WORKING ON …" block, and the pacing-guide unit lookup
         attached to it, reached the model on a chat's first turn and never
         again — so the model spent the rest of every conversation (typed or
         spoken) with no idea which week it was on. The chat's pinned week
         doesn't drift, so it's safe to keep sending. */
      liveMessageIdRef.current = nextId()
      setMessages((prev) => [
        ...prev,
        { id: liveMessageIdRef.current, role: 'assistant', content: '', streaming: true },
      ])
      const chatResult = await chatStream.start(payloadMessages, {
        chatId: activeChatId,
        classId,
        voice: voiceOpen,
        weekNumber: conversationWeek,
      })

      // The generate_quiz alternative — a distinct request from
      // generate_lesson_plan (see quizRequested's own comment in
      // useChatStream), handled and returned from here entirely rather
      // than falling into the revise-the-plan branch below.
      if (chatResult?.quizRequested) {
        if (!artifact?.planId) {
          // The system prompt already tells the model not to call this
          // tool with no plan built yet (see routes/generate.py's
          // has_plan) — reaching here means that held anyway, from a race
          // rather than the model ignoring the instruction, so this is a
          // plain apology rather than a real error.
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: 'assistant',
              content: "I need to build this week's plan before I can make a quiz for it.",
            },
          ])
          return
        }
        setQuizBuilding(true)
        // A fallback, not a second announcement: onDone already showed the
        // model's own text above when it wrote any (a natural "Sure, I'll
        // build that now" it just isn't required to write — see
        // routes/generate.py's system prompt). Only fires when it said
        // NOTHING, which is common: a real build takes several real
        // seconds, and answer-two-taps-then-silence-until-a-finished-quiz-
        // appears-out-of-nowhere reads as broken, not as "working on it."
        // quizBuilding's own spinner in the rail already solves this for a
        // teacher watching the rail, not one watching the chat — which is
        // most of them, most of the time.
        // Captured before setViewingQuiz(null) below clears it — this is
        // "the quiz already open in this conversation," the same role
        // artifact.planId already plays for plans. Iterating on a quiz used
        // to always call createQuiz, which only ever inserts a new row
        // (routes/plans.py), so every "make it harder" piled up a separate
        // quiz next to the one just built instead of changing it. The model
        // decides revise-vs-new (generate_quiz's revises_current, routed
        // through llm.py's system prompt) since it has the conversational
        // context to tell "make it harder" from "also make a matching
        // quiz" — this only needs an existing quiz to revise.
        const revisingQuizId =
          chatResult.quizRequested.revisesCurrent && viewingQuiz?.id ? viewingQuiz.id : null

        if (!chatResult.text?.trim()) {
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: 'assistant',
              content: revisingQuizId
                ? 'Updating the quiz now.'
                : `Building your quiz now — ${chatResult.quizRequested.numQuestions} ${questionTypesProse(chatResult.quizRequested.questionTypes)} questions.`,
            },
          ])
        }

        // Show skeleton
        setViewKind('quiz')
        setViewingQuiz(null)
        if (!expanded && !isPhone) setExpanded(true)
        if (isPhone) setRailOpen(false)

        try {
          const quiz = revisingQuizId
            ? await api.reviseQuiz(artifact.planId, revisingQuizId, content)
            : await api.createQuiz(artifact.planId, chatResult.quizRequested)
          showReadyNotice(revisingQuizId ? 'Quiz updated' : 'Quiz ready')
          qc.invalidateQueries({ queryKey: qk.quizzes(artifact.planId) })
          setViewingQuiz(quiz)
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: 'assistant',
              content: revisingQuizId
                ? `Updated "${quiz.title}." Download it from the plan panel — it imports into Canvas as a QTI package.`
                : `Built "${quiz.title}." Download it from the plan panel — it imports into Canvas as a QTI package.`,
            },
          ])
        } catch (err) {
          toast.apiError(revisingQuizId ? 'Could not update the quiz' : 'Could not build the quiz', err)
        } finally {
          setQuizBuilding(false)
        }
        return
      }

      // The update_lesson_day alternative — a targeted, one-field change
      // instead of generate_lesson_plan's whole-week rebuild (see
      // backend/llm.py's tool declaration). Handled by handing off to the
      // SAME reviseDay() a teacher's own click on a document cell already
      // uses, rather than inventing a second revision path — one surgical
      // rewrite, two ways to ask for it.
      if (chatResult?.dayRevisionRequested) {
        const { day: dayName, field, feedback } = chatResult.dayRevisionRequested
        const dayIndex = DAYS.indexOf(dayName)
        // Recomputed here rather than closing over the top-level `livePlan`
        // const, same reasoning as reviseDayRef just below: that const is
        // declared further down this component, and referencing it from
        // this earlier-declared callback would be a temporal-dead-zone
        // crash on every render, not just a staleness risk. `artifact` and
        // `stream` are already this callback's own dependencies, so this
        // stays exactly as fresh as `livePlan` itself is.
        const days = (artifact?.plan || stream.preview)?.days || []
        const day = dayIndex >= 0 ? days[dayIndex] : null
        if (!artifact?.planId || !day) {
          // The system prompt already tells the model not to call this
          // tool with no plan built yet — same race-not-a-drifted-model
          // reasoning as the equivalent guard on generate_quiz above.
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: 'assistant',
              content: "I need to build this week's plan before I can change a specific day.",
            },
          ])
          return
        }
        await reviseDayRef.current?.(dayIndex, day, feedback, field)
        return
      }

      if (!chatResult || !chatResult.toolCalled) {
        // AI decided to just converse, no revision needed.
        return
      }

      // The AI called generate_lesson_plan. Combine history for the prompt.
      // We append any introductory text the AI just streamed ("I'll get right on that!")
      // so it's in the combined history. Same split as above: the last turn
      // carries the attachment text, everything before it is the transcript.
      let combinedHistory = [
        ...messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`),
        `USER: ${content}`,
      ].join('\n\n')
      if (chatResult.text?.trim()) {
        combinedHistory += `\n\nASSISTANT: ${chatResult.text}`
      }

      // Same silence problem as a first build — see VOICE_BUILDING's use above.
      if (voiceOpen) {
        voice.speak(VOICE_REVISING)
      }
      // Same fallback as the quiz-build path below, and the same reason: the
      // model isn't REQUIRED to say anything before calling generate_lesson_plan
      // (chatResult.text is what onDone already showed, above, when it did),
      // and a revision is a real model call — answer-then-silence-then-a-
      // sudden "Updated the week" reads as broken. Voice mode already speaks
      // VOICE_REVISING, but that's audio, not a line in the transcript, so
      // this isn't gated on voiceOpen.
      if (!chatResult.text?.trim()) {
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: 'assistant', content: 'Reworking the week now — one moment.' },
        ])
      }
      setRevising(true)
      try {
        const row = await api.revisePlan(artifact.planId, combinedHistory)
        setArtifact((a) => ({
          ...a,
          plan: row.plan_json,
          warnings: row.warnings,
          retrievedIds: row.retrieved_ids,
        }))
        // Same "reference what's actually there" treatment as the fresh-
        // build confirmation above, not the old flat "Updated the week and
        // rebuilt the document." every revision produced verbatim.
        const reply = {
          id: nextId(),
          role: 'assistant',
          content: `Done — ${row.week_label || 'the week'} is updated${unitSuffix(
            row.unit,
            ', still centered on '
          )}. Let me know if anything else needs adjusting.`,
          planId: row.id,
          weekLabel: row.week_label,
          plan: row.plan_json,
          retrievedCodes: row.retrieved_ids,
        }
        setMessages((prev) => [...prev, reply])
        if (activeChatId) {
          void persistMessage(activeChatId, { role: 'assistant', content: reply.content, plan_id: row.id })
        }
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: 'assistant', isError: true, content: err.message, hint: err.hint },
        ])
        toast.apiError("Couldn't revise that", err)
      } finally {
        setRevising(false)
      }
    },
    [query, attachments, busy, chatId, classId, draftKey, artifact, stream, chatStream, messages, navigate, qc, toast, mayGenerate, openPaywall, effectiveWeek, conversationWeek, voiceOpen, voice, isPhone, viewingQuiz, expanded, location.state?.mode, persistMessage, showReadyNotice]
  )

  /* Composer's actual onSubmit — typing a follow-up and hitting Enter while
     the current turn is still busy used to just do nothing (canSend was
     false, so the keydown handler never called submit at all): the text
     sat there, with no feedback that anything had or hadn't happened. Now
     it queues instead, and the effect below sends it the moment `busy`
     clears — same submit() everything else already goes through, just
     deferred rather than dropped.

     Guards on typed text OR attachments, not text alone — submit() itself
     already treats an attachment with no typed comment as real content to
     send (its own "Guards on the COMBINED text" comment). This function
     used to check `typed` by itself, so attaching a file with nothing
     typed and hitting Send did nothing at all: no message, no queue entry,
     no error — Composer's own canSend had already lit the button up for
     exactly that case, so it looked like a plain dropped click.

     Queues a snapshot of the CURRENT attachments alongside the text, and
     clears the composer's own list immediately (same as typed text
     clearing right below) — otherwise whatever the teacher attaches or
     removes between queuing and `busy` clearing is what actually ends up
     sent, not what was there when they hit Enter. */
  const queueOrSubmit = useCallback(
    (text) => {
      const typed = (text ?? query).trim()
      if (!typed && attachments.length === 0) return
      if (busy) {
        setQueuedMessage({ text: typed, attachments })
        setQuery('')
        clearComposerDraft(draftKey)
        setAttachments([])
        return
      }
      submit(text)
    },
    [busy, query, submit, attachments, draftKey]
  )
  useEffect(() => {
    if (busy || !queuedMessage) return
    const next = queuedMessage
    setQueuedMessage(null)
    submit(next.text, { attachmentsOverride: next.attachments })
    // submit is intentionally excluded: it's recreated on every render (its
    // own dependency array above is enormous), and this only needs to run
    // when `busy` actually flips or a new message gets queued — the
    // null-out-before-submit above already makes a spurious re-run
    // harmless (queuedMessage is already null), so this is purely to avoid
    // re-checking on every unrelated render, not a correctness guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, queuedMessage])

  /* Per-cell revise, from clicking a cell in the document.
   *
   * `field` is what makes this surgical rather than merely local: without it the
   * backend regenerates the whole day, so "shorten the Do Now" also re-rolls
   * that day's standards and re-decides the grounding audit. With it exactly one
   * key changes. Both this and the composer end up in the transcript, so the
   * chat stays a complete record of what happened to the plan. */
  const reviseDay = useCallback(
    async (dayIndex, day, feedback, field = null) => {
      if (!artifact?.planId) return
      const label = field ? `${day.name}’s ${FIELD_LABELS[field] || field}` : day.name
      const ask = `Revise ${label}: ${feedback}`
      const askId = nextId()
      pinToTopIdRef.current = askId
      setMessages((prev) => [...prev, { id: askId, role: 'user', content: ask, created_at: new Date().toISOString() }])
      // Persisted for the same reason as the composer's own messages: a cell
      // tweak is a real edit to the week, and the transcript is meant to be a
      // complete record of what happened to the plan. It was writing to screen
      // only, so every in-cell revision vanished on reload.
      const saveTo = localFor.current
      if (saveTo) void persistMessage(saveTo, { role: 'user', content: ask, created_at: new Date().toISOString() })
      setRevising(true)
      try {
        const row = await api.reviseDay({
          plan_id: artifact.planId,
          day_index: dayIndex,
          feedback,
          ...(field ? { field } : {}),
        })
        setArtifact((a) => ({
          ...a,
          plan: row.plan_json,
          warnings: row.warnings,
          retrievedIds: row.retrieved_ids,
        }))
        flash(field ? [cellKey(dayIndex, field)] : [])
        const reply = `Updated ${label} and rebuilt the document.`
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: 'assistant',
            content: reply, created_at: new Date().toISOString(),
            planId: row.id,
            weekLabel: row.week_label,
            plan: row.plan_json,
            retrievedCodes: row.retrieved_ids,
          },
        ])
        // Carries plan_id, so the conversation keeps its link to the document.
        if (saveTo) {
          void persistMessage(saveTo, { role: 'assistant', content: reply, created_at: new Date().toISOString(), plan_id: row.id })
        }
      } catch (err) {
        /* The "Revise Thursday's Do Now…" message above was appended AND
           persisted before the request. With only a toast here, a failure left
           a question with no reply — and because the question was saved and the
           toast was not, it survived reload as an unanswered request nobody
           could explain. The reply is persisted for the same reason. */
        const failed = `Couldn’t revise ${label}. ${err.message}`
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: 'assistant', isError: true, content: failed, hint: err.hint },
        ])
        if (saveTo) void persistMessage(saveTo, { role: 'assistant', content: failed })
        toast.apiError(`Could not revise ${label}`, err)
      } finally {
        setRevising(false)
      }
    },
    [artifact, toast, flash, persistMessage]
  )
  // See reviseDayRef's own declaration, above submit(), for why this is a
  // plain assignment rather than a dependency-array entry.
  reviseDayRef.current = reviseDay

  /* The batch counterpart: one instruction, one field, applied to several days
     at once — what the tweak popover's "All N days" scope sends. Not reachable
     from submit()'s tool-call loop (there's no batch tool call), so unlike
     reviseDay this needs no ref. */
  const reviseDays = useCallback(
    async (dayIndices, feedback, field) => {
      if (!artifact?.planId) return
      const label = `${FIELD_LABELS[field] || field} across ${dayIndices.length} days`
      const ask = `Revise ${label}: ${feedback}`
      const askId = nextId()
      pinToTopIdRef.current = askId
      setMessages((prev) => [...prev, { id: askId, role: 'user', content: ask, created_at: new Date().toISOString() }])
      const saveTo = localFor.current
      if (saveTo) void persistMessage(saveTo, { role: 'user', content: ask, created_at: new Date().toISOString() })
      setRevising(true)
      try {
        const row = await api.reviseDays({
          plan_id: artifact.planId,
          day_indices: dayIndices,
          feedback,
          field,
        })
        setArtifact((a) => ({
          ...a,
          plan: row.plan_json,
          warnings: row.warnings,
          retrievedIds: row.retrieved_ids,
        }))
        flash(dayIndices.map((i) => cellKey(i, field)))
        const reply = `Updated ${label} and rebuilt the document.`
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: 'assistant',
            content: reply, created_at: new Date().toISOString(),
            planId: row.id,
            weekLabel: row.week_label,
            plan: row.plan_json,
            retrievedCodes: row.retrieved_ids,
          },
        ])
        if (saveTo) {
          void persistMessage(saveTo, { role: 'assistant', content: reply, created_at: new Date().toISOString(), plan_id: row.id })
        }
      } catch (err) {
        const failed = `Couldn’t revise ${label}. ${err.message}`
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: 'assistant', isError: true, content: failed, hint: err.hint },
        ])
        if (saveTo) void persistMessage(saveTo, { role: 'assistant', content: failed })
        toast.apiError(`Could not revise ${label}`, err)
      } finally {
        setRevising(false)
      }
    },
    [artifact, toast, flash, persistMessage]
  )

  /* The standard picker's own write, from clicking one of the retrieved
   * options in a Standards/ACT Alignment cell (LessonPlanTable's picker).
   * Sibling to reviseDay, not a case of it: api.setDayField sets the exact
   * chosen value with no model call, so there's no "feedback" to describe —
   * only which code was picked. Still logged to the transcript and flashed
   * the same way a tweak is, because it is just as real an edit to the week.
   */
  const pickStandard = useCallback(
    async (dayIndex, day, field, code) => {
      if (!artifact?.planId) return
      const label = `${day.name}’s ${FIELD_LABELS[field] || field}`
      const ask = `Set ${label} to ${code}.`
      const askId = nextId()
      pinToTopIdRef.current = askId
      setMessages((prev) => [...prev, { id: askId, role: 'user', content: ask, created_at: new Date().toISOString() }])
      const saveTo = localFor.current
      if (saveTo) void persistMessage(saveTo, { role: 'user', content: ask, created_at: new Date().toISOString() })
      setRevising(true)
      try {
        const row = await api.setDayField({
          plan_id: artifact.planId,
          day_index: dayIndex,
          field,
          value: code,
        })
        setArtifact((a) => ({
          ...a,
          plan: row.plan_json,
          warnings: row.warnings,
          retrievedIds: row.retrieved_ids,
        }))
        flash([cellKey(dayIndex, field)])
        const reply = `Updated ${label} and rebuilt the document.`
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: 'assistant',
            content: reply, created_at: new Date().toISOString(),
            planId: row.id,
            weekLabel: row.week_label,
            plan: row.plan_json,
            retrievedCodes: row.retrieved_ids,
          },
        ])
        if (saveTo) {
          void persistMessage(saveTo, { role: 'assistant', content: reply, created_at: new Date().toISOString(), plan_id: row.id })
        }
      } catch (err) {
        const failed = `Couldn’t update ${label}. ${err.message}`
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: 'assistant', isError: true, content: failed, hint: err.hint },
        ])
        if (saveTo) void persistMessage(saveTo, { role: 'assistant', content: failed })
        toast.apiError(`Could not update ${label}`, err)
      } finally {
        setRevising(false)
      }
    },
    [artifact, toast, flash, persistMessage]
  )

  /* Stopping used to say nothing at all: useLessonStream returns null on an
     AbortError and fires no callback, so the transcript kept the question and
     never acquired a reply. The teacher was left looking at their own message
     with no indication anything had happened. */
  const stopGenerating = useCallback(() => {
    stream.stop()
    const content = 'Stopped. Nothing was saved — ask again when you’re ready.'
    setMessages((prev) => [...prev, { id: nextId(), role: 'assistant', content, isError: true }])
    if (localFor.current) {
      void persistMessage(localFor.current, { role: 'assistant', content })
    }
  }, [stream, persistMessage])

  /* useChatStream.stop() has worked since it was written; nothing ever called
     it. The composer's own fallback — a spinner captioned "this can't be
     interrupted" — was therefore lying specifically about the conversational
     reply, which is interruptible and just wasn't wired. */
  const stopChatting = useCallback(() => {
    chatStream.stop()
    // Aborting never reaches onDone/onError, so the live placeholder (see
    // liveMessageIdRef) would otherwise sit there permanently mid-stream —
    // settle it (or drop it, if nothing had streamed yet) before adding the
    // "Stopped" message below.
    finalizeLiveMessage()
    const content = 'Stopped. Nothing was saved — ask again when you’re ready.'
    setMessages((prev) => [...prev, { id: nextId(), role: 'assistant', content, isError: true }])
    if (localFor.current) {
      void persistMessage(localFor.current, { role: 'assistant', content })
    }
  }, [chatStream, persistMessage, finalizeLiveMessage])

  /* Rebuild the last plan from the same prompt. `onRetry` and `isLast` were
     declared on Message and never passed, so the retry button could not render
     and the only recovery from a failed build was retyping the whole prompt. */
  const retryLast = useCallback(() => {
    const lastAsk = [...messages].reverse().find((m) => m.role === 'user')
    if (lastAsk) submit(lastAsk.content)
  }, [messages, submit])

  /* Both of these exist to keep <Message>'s props referentially stable, which
     is what makes memoizing it (components/Message.jsx) actually pay off —
     an inline arrow in the map below would hand every bubble a brand-new prop
     on every render and skip the memo entirely.

     Message ignores its first argument (it passes its own `message` back), so
     this can be one shared callback rather than one closure per row. */
  const handleEditMessage = useCallback((_m, next) => submit(next), [submit])

  /* One ref callback per message id, cached, so the same identity comes back
     on every render. An inline `ref={(el) => …}` is a NEW function each time,
     which React treats as a different ref: it calls the old one with null and
     the new one with the node on every single render, churning this Map
     constantly for no reason. */
  const messageRefCallbacks = useRef(new Map())
  const registerMessageRef = useCallback((id) => {
    const cached = messageRefCallbacks.current.get(id)
    if (cached) return cached
    const fn = (el) => {
      if (el) messageRefs.current.set(id, el)
      else messageRefs.current.delete(id)
    }
    messageRefCallbacks.current.set(id, fn)
    return fn
  }, [])

  // Auto-retry once on reconnect: a message that failed while the device
  // was genuinely offline (see the offline-aware hint above) shouldn't need
  // a teacher to notice wifi came back AND remember to tap Retry — the
  // browser already tells us the instant it does. Guarded on wasOfflineRef
  // so this only fires on a real offline->online transition (not on every
  // render where isOnline happens to be true), and read through refs
  // rather than closed over directly so this effect's own deps can stay on
  // just [isOnline] — the same "ref, not a stale closure" shape ChatPage
  // already uses for closeVoiceRef.
  const wasOfflineRef = useRef(false)
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const busyRef = useRef(busy)
  busyRef.current = busy
  const retryLastRef = useRef(retryLast)
  retryLastRef.current = retryLast
  useEffect(() => {
    if (!isOnline) {
      wasOfflineRef.current = true
      return
    }
    if (!wasOfflineRef.current) return
    wasOfflineRef.current = false
    const last = messagesRef.current[messagesRef.current.length - 1]
    if (last?.isError && !busyRef.current) retryLastRef.current()
  }, [isOnline])

  /* LessonQuestions' own Continue button, once every question has an answer.
     Clears `questions` off the message it came from (so the cards can't be
     re-clicked into a second, contradictory answer) and feeds the synthesized
     text straight back into the normal submit path — the model sees it as
     just another user turn, no different from having typed it. */
  const onAnswerQuestions = useCallback(
    (message, text) => {
      setMessages((prev) => prev.map((m) => (m.id === message.id ? { ...m, questions: null } : m)))
      // The clarifying-questions form lives in its own dock ABOVE the
      // composer (questionsPanel, below) — answering it collapses that dock,
      // which can leave `atBottom` stuck false from whatever it read before
      // (the dock's own height factors into the scroll math the same as any
      // other layout change). Answering is exactly as much "stay with the
      // conversation" as typing a reply and hitting send, so it force-snaps
      // back to the bottom rather than trusting a scroll position measured
      // against a dock that's mid-close.
      setAtBottom(true)
      submit(text)
    },
    [submit]
  )

  const onPlanRevised = useCallback((row) => {
    if (!row) return
    setArtifact((a) => ({
      ...a,
      plan: row.plan_json,
      warnings: row.warnings,
      retrievedIds: row.retrieved_ids,
    }))
  }, [])

  /* Mirrors chatStream's own growing text into the placeholder message
     pushed right before chatStream.start() (see the two call sites in
     submit(), and liveMessageIdRef's own comment above) — this is what lets
     that message grow in place instead of living outside `messages` until
     it's finished. */
  useEffect(() => {
    if (!chatStream.isStreaming) return
    const id = liveMessageIdRef.current
    if (!id) return
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content: chatStream.text } : m)))
  }, [chatStream.text, chatStream.isStreaming])

  /* ── scroll ───────────────────────────────────────────────────────────── */
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 120)
  }
  // Two very different jobs, picked apart by scrollModeRef (see its own
  // comment above): 'bottom' chases the very end — right for a
  // conversation that just loaded, where the latest exchange IS the thing
  // to land on. 'pinned' means a turn already anchored its own start
  // (pinToTopIdRef fired below) and nothing should drag the view further
  // while the reply grows underneath it — that dragging, once per SSE
  // chunk, was the whole "why do I have to scroll back up" complaint: for
  // any reply longer than one screen, chasing its bottom scrolls straight
  // past its own opening line.
  // Was requestAnimationFrame, to coalesce several SSE chunks landing in the
  // same frame into one scroll call — but rAF is throttled to roughly
  // nothing the moment a tab is backgrounded (switching tabs while the AI
  // is still writing, then coming back, is an ordinary thing to do), and a
  // pin that silently never fires is worse than a few redundant scroll
  // calls. The pin itself only ever needs to run once per turn regardless
  // (mode flips to 'pinned' and everything after returns early), so there
  // was nothing left to actually coalesce.
  useEffect(() => {
    const pinId = pinToTopIdRef.current
    if (pinId) {
      pinToTopIdRef.current = null
      scrollModeRef.current = 'pinned'
      // Instant, not smooth — smooth scrolling is itself an animation the
      // browser is free to throttle or stall exactly when a tab is
      // backgrounded (switching tabs while a reply is still being written
      // is ordinary), and this is a hard "you're on a new turn now"
      // repositioning, not a decorative flourish worth the risk of it
      // silently never finishing.
      messageRefs.current.get(pinId)?.scrollIntoView({ block: 'start' })
      return
    }
    if (scrollModeRef.current === 'pinned') return
    if (!atBottom) return
    // chatStream.text (the live reply streaming in below, before it lands in
    // `messages`) and stream.preview (the plan-building WeekStrip filling in
    // day by day) both grow the transcript's height without changing
    // `messages` itself — without them here, an existing conversation a
    // teacher is already at the bottom of wouldn't follow-scroll until the
    // whole generation finished. Irrelevant once a turn is 'pinned' above:
    // that branch already returns before this runs.
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, atBottom, chatStream.text, stream.preview])

  /* Voice mode's other half — see VoiceProvider for the mic button's. One
     effect watching `messages` catches every assistant reply this component
     creates (build confirmations, revision confirmations, errors, the whole
     handful of call sites in submit() below) without having to thread
     voice.speak() through each of them individually and risk a future one
     going quiet by omission. Guarded on the message's OWN id, not a count,
     so a load-more or a deleted message can't cause a stale reply to be
     spoken again.

     Only runs while this deliberate voice conversation is open; the provider
     never reconnects from page-load state. */
  useEffect(() => {
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'assistant' || last.streaming) return
    if (lastSpokenRef.current === last.id) return
    lastSpokenRef.current = last.id
    // spokenContent, when set, carries content the text-chat bubble
    // deliberately doesn't show in full — see speakableQuestions.
    const toSpeak = last.spokenContent || last.content
    // Only auto-speak if they are actively in the voice conversation,
    // not unexpectedly in the background while they are just typing.
    // spokenLive replies were already read aloud as they streamed (see
    // onSentence) — speaking them again here would repeat the whole turn.
    if (voiceOpen && !last.spokenLive) {
      // enqueue, not speak: a clarifying question's spokenContent follows
      // an intro that may still be playing from the stream, and replacing
      // would cut its own preamble off mid-word.
      voice.speak(toSpeak)
    }
  }, [messages, voice, voiceOpen])

  /* The card stack's data. Keyed on the WHOLE transcript, not just new
     assistant replies — the extraction call re-reads everything said each
     time (see llm.extract_decisions), because a teacher naming a text mid-
     utterance is itself a decision, not something only assistant turns
     produce.

     Used to only run while voice mode's panel was open — a teacher typing
     never saw "the plan so far" at all, only one talking to it did, which
     was half of why the deck read as an odd voice-only extra rather than
     a real feature. Runs for text chat too now, gated on there being no
     plan yet instead: once a week exists the rail shows the real document
     and its "Built from" list, and re-running extraction on a transcript
     that already has an artifact would just be wasted calls for a card
     stack nothing displays anymore. */
  useEffect(() => {
    if (artifact?.planId || messages.length === 0) return undefined
    let cancelled = false
    api
      .getDecisions(messages.map((m) => ({ role: m.role, content: m.content })))
      .then((res) => {
        if (!cancelled) setDecisions(res.decisions || [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [messages, artifact?.planId])


  /* Voice has one submit path. Realtime emits a completed transcription;
     ChatPage submits it through the same grounded flow as typed text, which
     is also the only place that saves the user message. */
  const submitRef = useRef(submit)
  submitRef.current = submit
  useEffect(
    () => voice.onUtterance((text) => {
      // A spoken interruption cancels any still-streaming grounded reply;
      // the new utterance itself then starts the same submit path. Settle
      // the interrupted turn's own placeholder first — otherwise the next
      // turn pushes a second one and the first is left stuck mid-stream,
      // stranded above it.
      chatStream.stop()
      finalizeLiveMessage()
      submitRef.current(text, { voiceTurn: true })
    }),
    [chatStream, voice, finalizeLiveMessage]
  )

  /* The clarification the conversation is currently waiting on, if any.
     Only ever the LAST message's — an older unanswered set has been
     overtaken by whatever was said since, and answering it now would send
     the conversation backwards. */
  const pendingQuestions = useMemo(() => {
    const last = messages[messages.length - 1]
    if (last?.role !== 'assistant' || !last?.questions?.length) return null
    return { message: last, questions: last.questions }
  }, [messages])

  /* What voice mode's own Replay button (below) reads out loud — the exact
     same "spokenContent, when set, else content" the auto-speak effect
     already uses (see its own comment), so replaying can never say
     something different than what was actually spoken the first time.
     null while there's nothing to replay yet, or while a reply is still
     mid-stream (streaming text isn't the finished line worth replaying). */
  const lastReplyText = useMemo(() => {
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'assistant' || last.streaming) return null
    return last.spokenContent || last.content || null
  }, [messages])

  const livePlan = artifact?.plan || stream.preview
  const liveArtifact = useMemo(
    () =>
      artifact ||
      (stream.preview || stream.isStreaming
        ? { plan: stream.preview, grounding: stream.grounding }
        : null),
    [artifact, stream.preview, stream.isStreaming, stream.grounding]
  )

  const isEmpty = messages.length === 0
  const hasArtifact = Boolean(liveArtifact && livePlan?.days?.length)
  /* Declared before chatPane, which reads it. The document always opens as a
     full glass overlay now (2026-08-27) — there is no more docked
     side-by-side mode, at any width. There used to be a `docOpen` sibling
     to this (below --xl was overlay, --xl and up docked chat+document as a
     three-column layout), removed because a docked document narrowed the
     chat pane's own composer anchor and its width math never actually
     matched the overlay's, which is what produced the "glass panel doesn't
     reach the rail" bug this replaced. One code path instead of two that
     had to be kept in sync. */
  const overlayOpen = expanded && hasArtifact
  const overlayExit = useExitTransition(overlayOpen, 130)
  const mobileReaderOpen = isPhone && viewKind === 'plan' && overlayExit.mounted
  // See overlayPortalHost's own creation comment: this host spans the full
  // viewport (or the docked box) at all times, so it must stop intercepting
  // clicks the instant there's nothing shown inside it, not just while it's
  // sized to zero.
  useEffect(() => {
    // The phone reader lives in ChatPage's normal tree. Its unused desktop
    // portal must remain inert or it can sit above the reader and eat taps.
    overlayPortalHost.style.pointerEvents = overlayExit.mounted && !mobileReaderOpen ? 'auto' : 'none'
  }, [mobileReaderOpen, overlayExit.mounted, overlayPortalHost])
  /* Measured live (rAF timestamps during the slide-in): the animation
     itself was a rock-solid ~13ms/frame for its whole duration, EXCEPT the
     first two frames (26.7ms, then 39.9ms) — that's not the CSS transform
     struggling, it's React mounting artifactEl's real DOM (the district
     table, potentially dozens of cells) in the exact same commit the slide
     starts in, which the browser has to lay out and paint before the very
     first frame of the animation can even begin compositing. Rendering
     nothing (just the empty glass panel — see .artifact-overlay's own
     background) for the first couple of frames, THEN mounting the real
     content, moves that cost off the animation's own opening beat instead
     of trying to make the mount itself cheaper. Two rAFs, not one: the
     first is "the browser has now painted whatever we rendered this tick";
     the second is where the CSS animation has actually started running on
     its own, so the table mount lands once the compositor is already
     carrying the motion rather than fighting it for the same frame. */
  const [artifactContentReady, setArtifactContentReady] = useState(false)
  useEffect(() => {
    if (!overlayOpen) {
      setArtifactContentReady(false)
      return undefined
    }
    // The desktop panel has enough GPU headroom for a two-frame delayed mount
    // that makes its slide-in look smoother. On a phone that delay can leave a
    // full-screen, focus-trapping sheet with no document in it while Safari is
    // also recompositing its blur. Mount the already-available plan directly.
    if (isPhone) {
      setArtifactContentReady(true)
      return undefined
    }
    let raf2 = null
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setArtifactContentReady(true))
    })
    return () => {
      cancelAnimationFrame(raf1)
      if (raf2 != null) cancelAnimationFrame(raf2)
    }
  }, [overlayOpen, isPhone])
  /* While the document overlay covers the transcript, a reply has nowhere
     visible to land — so it surfaces as a toast instead. Watches the last
     message rather than hooking every place this file appends one (there
     are a couple dozen, across streaming, tool calls, and voice); skips a
     revision reply (`planId` set) since that one already shows up directly
     in the document that's on screen, and skips while still streaming so
     this fires once, when the reply actually finishes. */
  const lastToastedReplyId = useRef(null)
  useEffect(() => {
    if (!overlayOpen) return
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'assistant' || last.streaming || last.isError) return
    if (last.id === lastToastedReplyId.current) return
    lastToastedReplyId.current = last.id
    if (last.planId) return
    const text = last.content?.trim()
    if (!text) return
    toast.success('New reply', text.length > 160 ? `${text.slice(0, 160)}…` : text)
  }, [messages, overlayOpen, toast])
  /* Voice mode used to be a full-screen/dialog takeover, mounted and
     unmounted outright with no exit of its own. Now it's a dock that grows
     out of the chat box itself, right above the composer — same
     mount-a-beat-longer-to-play-the-exit shape as overlayExit above. */
  const voiceExit = useExitTransition(voiceOpen, 180)
  /* The clarification round used to render inline in the transcript (see
     Message.jsx's history-only fallback for what that used to look like
     live) — now it docks above the composer instead, the same
     grows-out-of-the-chat-box shape as voiceExit right above. Only in text
     mode: voice mode already surfaces the same `pendingQuestions` through
     VoiceModePanel's own QuestionCards. */
  const questionsExit = useExitTransition(Boolean(pendingQuestions) && !voiceOpen, 180)
  /* pendingQuestions clears the instant it's answered (onAnswerQuestions
     nulls `questions` off the message in the same tick submit() fires), so
     the dock would have nothing left to render during its own closing
     animation without this — the last real round, held until the next one
     replaces it or the dock finishes unmounting. */
  const [lastQuestions, setLastQuestions] = useState(null)
  useEffect(() => {
    if (pendingQuestions) setLastQuestions(pendingQuestions)
  }, [pendingQuestions])
  /* The "Latest" jump-to-bottom pill used to unmount the instant atBottom
     flipped true — the one piece of chat chrome still doing a hard cut
     while every other transient here (toasts, attachment chips) plays a
     matched exit. 150ms, same as the attachment chip's own removal: both
     are a small pill leaving the page, not a panel. */
  const latestPill = useExitTransition(!atBottom && !isEmpty, 150)

  /* Auto-opens the drawer the moment a build starts or a plan exists; after
     that it is the teacher's to open or close. Fires at most ONCE per chat
     (railAutoOpenedRef) — `busy` flips true and back false on every later
     turn too (a revision, a follow-up, a quiz), and without the guard each
     of those turns re-ran this effect and force-reopened a drawer the
     teacher had just closed. "The plan so far" now lives inline in the chat
     itself (see the decisions list rendered with the messages), not in the
     rail, so landing a decision no longer needs to pop the rail open on its
     own — the rail has nothing to show for that case until a build
     actually starts. */
  useEffect(() => {
    if (railAutoOpenedRef.current) return
    if (busy || hasArtifact) {
      setRailOpen(true)
      railAutoOpenedRef.current = true
    }
  }, [busy, hasArtifact])

  // Process autoPrompt from navigation (e.g. 5-Minute Sub Plan)
  useEffect(() => {
    if (location.state?.autoPrompt && !chatId) {
      // Clear the state so it doesn't re-fire on hot reload or back navigation
      navigate(location.pathname, { replace: true, state: {} })
      submit(location.state.autoPrompt)
    }
  }, [location.state, chatId, navigate, submit, location.pathname])

  /** Opening the document from anywhere, optionally straight into a cell. */
  const openDocument = useCallback((tweak = null) => {
    setViewKind('plan')
    setOpenTweak(tweak)
    setExpanded(true)
  }, [])

  /* The rail's other rows open the same embossed panel the plan does (see
     ArtifactDetailPanel) instead of each inventing its own. `viewKind`
     switches what fills it; `viewingQuiz`/`viewingDoc` carry the one piece
     of data ChatPage doesn't already have some other way (the plan itself,
     the calendar, and the grounding scan are all already in scope below). */
  const openQuiz = useCallback((quiz) => {
    setViewKind('quiz')
    setViewingQuiz(quiz)
    setExpanded(true)
  }, [])
  const openStandards = useCallback(() => {
    setViewKind('standards')
    setExpanded(true)
  }, [])
  const openCalendar = useCallback(() => {
    setViewKind('calendar')
    setExpanded(true)
  }, [])
  const openDoc = useCallback((doc) => {
    setViewKind('document')
    setViewingDoc(doc)
    setExpanded(true)
  }, [])

  const collapse = useCallback(() => {
    setOpenTweak(null)
    setExpanded(false)
    /* Put focus back on the card that opened it.
       useFocusTrap captures the previously-focused element AFTER React has
       committed, and opening the docked document unmounts the rail in that
       same commit — so by then the trigger was already detached and the hook's
       `document.contains(previous)` guard correctly declined to restore. The
       result was focus on nothing: the next Tab started from "Skip to content"
       at the top of the app. The overlay path never had this, because there
       the trigger is a message button that stays mounted.

       Deferred a frame, because the rail has to remount first. */
    requestAnimationFrame(() => {
      document.getElementById('rail-open-title')?.focus({ preventScroll: true })
    })
  }, [])

  // Same scan ArtifactRail runs to decide its own "Standards" row sub-text —
  // recomputed here rather than threaded down, since the two components
  // don't otherwise share a parent-owned result and this is a plain array
  // scan, not a fetch.
  const retrievedCodes = liveArtifact?.grounding?.codes || liveArtifact?.retrievedIds || []
  const { grounded, ungrounded } = scanGrounding(livePlan, retrievedCodes)

  // What the overlay's own scrim-close button below (line ~1690) should say
  // it's closing — it used to hardcode "lesson plan" even while looking at
  // a quiz or the standards list, since it's shared chrome around whichever
  // of the two `artifactEl` renders.
  const viewLabel = VIEW_KIND_LABELS[viewKind] || VIEW_KIND_LABELS.plan

  const { checklist: coreChecklist, extra: extraDecisions } = useMemo(() => splitDecisions(decisions), [decisions])
  const contextualSuggestions = useMemo(
    () =>
      getContextualSuggestions({
        activeClass,
        activeChat,
        conversationWeek,
        effectiveWeek,
        messages,
        artifact: hasArtifact ? liveArtifact : null,
        decisions,
        pendingQuestions,
        busy,
        voiceOpen,
        calendar,
        hasPacingGuide,
        surface: 'chat',
        classCount: classes?.length,
      }),
    [
      activeChat,
      activeClass,
      busy,
      calendar,
      classes.length,
      conversationWeek,
      decisions,
      effectiveWeek,
      hasArtifact,
      hasPacingGuide,
      liveArtifact,
      messages,
      pendingQuestions,
      voiceOpen,
    ]
  )

  // Upgrades the composer's one suggestion from its generic "using my pacing
  // guide" template to a version grounded in what the pacing guide actually
  // says that week covers — but only for plan-current-week, the primary
  // "build this week" action. prepare-next-week (a secondary, look-ahead
  // suggestion) isn't worth a network round-trip: it only ever surfaces when
  // there's no more specific week in play, so there's nothing to ground it
  // against with any confidence. Debounced and cached per class+week so
  // navigating around the same week doesn't refire; falls back to the
  // generic template (contextualSuggestions unmodified) on any error, cold
  // cache, or missing pacing guide — this is a visual polish layer, never
  // something the composer should wait on or break over.
  const groundableSuggestion = contextualSuggestions.find((s) => s.id === 'plan-current-week') || null
  const suggestionKey = groundableSuggestion ? `${activeClass?.id || 'none'}:${groundableSuggestion.weekNumber}` : null
  const debouncedSuggestionKey = useDebouncedValue(suggestionKey, 400)
  const suggestionCacheRef = useRef(new Map())
  // {prompt, reason} together — grounding the message without also
  // grounding its caption left the row reading like two different
  // suggestions stapled together (a specific headline over a generic "this
  // is the current unplanned teaching week").
  const [aiSuggestion, setAiSuggestion] = useState(null)

  useEffect(() => {
    if (!debouncedSuggestionKey || debouncedSuggestionKey !== suggestionKey || !groundableSuggestion) {
      setAiSuggestion(null)
      return undefined
    }
    if (suggestionCacheRef.current.has(debouncedSuggestionKey)) {
      setAiSuggestion(suggestionCacheRef.current.get(debouncedSuggestionKey))
      return undefined
    }
    let cancelled = false
    api
      .getSuggestion({
        class_id: activeClass?.id || null,
        week_number: groundableSuggestion.weekNumber,
        week_label: groundableSuggestion.label,
      })
      .then((res) => {
        if (cancelled) return
        const grounded = res.prompt ? { prompt: res.prompt, reason: res.reason || null } : null
        suggestionCacheRef.current.set(debouncedSuggestionKey, grounded)
        setAiSuggestion(grounded)
      })
      .catch(() => {
        if (!cancelled) setAiSuggestion(null)
      })
    return () => {
      cancelled = true
    }
  }, [debouncedSuggestionKey, suggestionKey, groundableSuggestion, activeClass?.id])

  const enhancedSuggestions = useMemo(() => {
    if (!aiSuggestion || !groundableSuggestion) return contextualSuggestions
    return contextualSuggestions.map((s) =>
      s.id === groundableSuggestion.id
        ? { ...s, prompt: aiSuggestion.prompt, reason: aiSuggestion.reason || s.reason }
        : s
    )
  }, [contextualSuggestions, aiSuggestion, groundableSuggestion])

  // An open-settings suggestion (add-pacing-guide, add-school-calendar)
  // isn't a chat message — there's no sentence to type, send, or Tab-
  // complete for "go upload a file." The composer never sees one; it
  // lives in the Greeting's own sentence instead, and only there, since
  // Greeting itself only renders in the empty state (see `isEmpty` below).
  const emptyStateHint =
    !messages.length && enhancedSuggestions[0]?.action === 'open-settings' ? enhancedSuggestions[0] : null
  const composerSuggestions = useMemo(
    () => enhancedSuggestions.filter((s) => s.action !== 'open-settings'),
    [enhancedSuggestions]
  )

  const artifactEl =
    viewKind === 'plan' ? (
      <ArtifactPanel
        artifact={{ ...liveArtifact, plan: livePlan }}
        classId={classId}
        subject={activeClass?.subject}
        missingDays={stream.isStreaming ? 'pending' : artifact?.planId ? 'no_school' : 'incomplete'}
        onCollapse={collapse}
        onReviseDay={artifact?.planId ? reviseDay : undefined}
        onReviseDays={artifact?.planId ? reviseDays : undefined}
        onPickStandard={artifact?.planId ? pickStandard : undefined}
        onPlanRevised={onPlanRevised}
        busy={busy}
        preparing={preparing}
        streamingText={stream.text}
        openTweak={openTweak}
        setOpenTweak={setOpenTweak}
        flashCells={flashCells}
        onFullscreenChange={setArtifactFullscreen}
        mobileReader={isPhone && viewKind === 'plan'}
      />
    ) : (
      <ArtifactDetailPanel
        kind={viewKind}
        classId={classId}
        planId={artifact?.planId}
        onFullscreenChange={setArtifactFullscreen}
        plan={livePlan}
        subject={activeClass?.subject}
        quiz={viewingQuiz}
        quizBuilding={quizBuilding}
        doc={viewingDoc}
        grounded={grounded}
        ungrounded={ungrounded}
        weeks={calendar?.weeks || []}
        currentWeek={conversationWeek}
        onCollapse={collapse}
      />
    )

  // The desktop dock is portaled so it can remain over the document overlay.
  // On a phone that extra fixed layer has no benefit and can attach to a stale
  // anchor after a plan is built, putting its file controls over the header.
  // Keep the phone dock in the chat's normal flex flow instead.
  const renderComposerDock = (dock) => (isPhone ? dock : createPortal(dock, portalHost))

  const chatPane = (
    /* border-r-0, not a plain `border`: this pane's own background is only
       30% opaque (the glassmorphism pass above), so a border on the edge
       that touches the docked rail/document (ArtifactDrawer or ArtifactPanel,
       both fully opaque) let the page's own colourful gradient bleed through
       right at that seam — a visible tinted line between two panels that
       otherwise sit flush. The other three edges keep the glass border;
       only the shared seam drops it. */
    <div className="relative flex h-full min-h-0 flex-col bg-paper/30 backdrop-blur-3xl saturate-[1.2] border border-r-0 border-white/5 shadow-inner shadow-white/5">
      {/* Always on, unlike chat-head below it — right-aligned so it sits at
          the seam with whatever's docked on the right (the plans rail, or
          the open document), not lost against the far edge of the screen. */}
      {/* The top header bar: the downloads button pinned right (theme is now
          a Settings preference, not a header control — see SettingsPage).
          The class/week row used to be centered via absolute positioning —
          on Josh's own ask, it's a plain leading flex item now, flush
          against the same left edge as the message list and composer below
          it, not floating apart from the rest of the pane's own left
          margin. */}
      <div className="flex h-11 shrink-0 items-center bg-paper border-b border-edge px-2 z-10">
        {isPhone ? (
          /* The old dense row (ClassSwitcher + a pacing dot + WeekPicker + a
             calendar dot, all inline) doesn't fit a phone width without
             everything shrinking past readable — this is a back button (to
             MobileChatHome, the phone-only chats list ChatPage renders
             instead of this view when there's no chat open — see
             mobileShowHome's own comment) plus a single tappable title
             that opens ChatHeaderSheet, which carries the SAME controls
             the desktop row has, just given a full sheet to breathe in. */
          <>
            <button
              type="button"
              className="btn-icon tap-target shrink-0"
              aria-label="Back to your chats"
              onClick={() => (chatId ? navigate(`/c/${classId}`) : setMobileShowHome(true))}
            >
              <ChevronLeft size={20} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="tap-target flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left"
              onClick={() => setHeaderSheetOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={headerSheetOpen}
            >
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                {activeClass?.name || 'Choose a class'}
                {displayWeek ? ` · Week ${String(displayWeek.week).padStart(2, '0')}` : ''}
              </span>
              {!hasPacingGuide ? (
                <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" aria-hidden="true" />
              ) : null}
              <ChevronDown size={14} aria-hidden="true" className="shrink-0 text-ink-faint" />
            </button>
          </>
        ) : (
          <div className="chat-head pointer-events-auto flex min-w-0 max-w-[70%] flex-nowrap items-center">
            {/* Which prep, then which week — the two questions that together
                answer "what is this conversation about," read as one row
                instead of a switcher a whole sidebar away from the week it
                scopes. flex-nowrap overrides .chat-head's own wrap (needed
                when it was just WeekPicker alone): with two controls now
                sharing this row, wrapping stacked them into separate lines
                instead of the one row this is meant to read as. Each child
                gets min-w-0 so it truncates under real width pressure (an
                iPad's narrower chat pane, a long class name) rather than
                forcing the row wide enough to overflow the screen. */}
            <div className="flex items-center gap-2 shrink min-w-0">
              <ClassSwitcher
                classes={classes}
                activeClass={activeClass}
                classPath={`/c/${classId}`}
                inline
              />
              {!hasPacingGuide ? (
                <Tooltip
                  interactive
                  position="bottom"
                  content={
                    <span>
                      No pacing guide on file.{' '}
                      <Link
                        to={`/c/${classId}/class#section-docs`}
                        className="underline transition-colors hover:text-white"
                      >
                        Upload one
                      </Link>
                    </span>
                  }
                >
                  {/* A hover-only Tooltip has no touch equivalent — on phone
                      this dot used to sit there permanently unreadable and
                      untappable, since a tap has no "hover" step to open it
                      first. Making the dot itself a real Link means a tap
                      just does the tooltip's one action directly, and the
                      Tooltip still opens first on desktop hover the same as
                      before. tap-target widens the actual hit area to the
                      touch minimum without enlarging the 8px dot itself. */}
                  <Link
                    to={`/c/${classId}/class#section-docs`}
                    className="tap-target block h-2 w-2 shrink-0 rounded-full bg-red-500"
                    aria-label="No pacing guide on file — tap to upload one"
                  />
                </Tooltip>
              ) : null}
            </div>
          </div>
        )}
        <div className="ml-auto flex min-w-0 items-center gap-3">
          {!isPhone && classId && classId !== 'default' && classes.length > 0 ? (
            <div className="min-w-0 shrink">
              <WeekPicker
                options={weekOptions}
                value={conversationWeek}
                onChange={changeWeek}
                schoolName={calendar?.school?.name}
                disabled={busy}
              />
            </div>
          ) : null}
          {!isPhone && calendar?.school?.name ? (
            !calendar.school.has_calendar ? (
              <Tooltip
                interactive
                position="bottom-left"
                content={
                  <span>
                    No calendar on file.{' '}
                    <Link
                      to={`/c/${classId}/settings#section-school-calendar`}
                      className="underline transition-colors hover:text-white"
                    >
                      Upload one in settings
                    </Link>
                  </span>
                }
              >
                <div className="hidden min-w-0 cursor-default items-center gap-2 md:flex">
                  <span className="truncate text-xs font-medium text-ink-muted">
                    {calendar.school.name}
                  </span>
                  <div
                    className="h-2 w-2 shrink-0 rounded-full bg-red-500"
                    aria-hidden="true"
                  />
                </div>
              </Tooltip>
            ) : (
              <span className="hidden min-w-0 truncate text-xs font-medium text-ink-muted md:inline">
                {calendar.school.name}
              </span>
            )
          ) : null}
          {hasArtifact ? (
            <button
              type="button"
              className="fa-press relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--paper-raised)] text-[var(--accent-text)] shadow-[2px_2px_5px_rgba(var(--neo-dark-rgb),0.4),-2px_-2px_5px_rgba(var(--neo-light-rgb),0.75)] active:shadow-[inset_2px_2px_4px_rgba(var(--neo-dark-rgb),0.5),inset_-2px_-2px_4px_rgba(var(--neo-light-rgb),0.7)]"
              aria-label="Open downloads"
              title="Downloads ready"
              /* Opens the docked rail (ArtifactDrawer), not the full document —
                 on Josh's own ask, this button surfaces "a download is ready"
                 and lets the rail's own Download row take it from there,
                 instead of jumping straight into the lesson plan itself.
                 A phone has no docked rail to open (see the isPhone-only
                 ArtifactRail "bar" variant above the composer, which has no
                 open/close state of its own), so there openDocument() is
                 still the only way to reach it. */
              onClick={() => (isPhone ? openDocument() : setRailOpen(true))}
            >
              <Download size={18} aria-hidden="true" />
              {!railOpen ? (
                <span
                  className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-[rgb(var(--rail-pop-rgb))]"
                  aria-hidden="true"
                />
              ) : null}
            </button>
          ) : null}
        </div>
      </div>

      {isPhone ? (
        <ChatHeaderSheet
          open={headerSheetOpen}
          onClose={() => setHeaderSheetOpen(false)}
          classes={classes}
          activeClass={activeClass}
          classId={classId}
          hasPacingGuide={hasPacingGuide}
          calendar={calendar}
          weekOptions={weekOptions}
          conversationWeek={conversationWeek}
          changeWeek={changeWeek}
          busy={busy}
        />
      ) : null}

      <TemplateBanner />
      <TrialBanner />

      {isEmpty ? (
        <Greeting
          className={activeClass?.name}
          onOpenVoice={betaFeaturesEnabled ? openVoice : undefined}
          week={displayWeek}
          hint={emptyStateHint}
          onOpenSettings={handleOpenSettings}
        />
      ) : (
        <div className="min-h-0 flex-1 scroll-y" ref={scrollRef} onScroll={onScroll}>
          <div className={`chat-column mx-auto flex w-full flex-col px-gutter py-8 transition-all duration-500 ease-out ${
            voiceOpen ? 'max-w-5xl' : 'max-w-4xl'
          }`}>
            {messages.map((m, i) => {
              const prev = i > 0 ? messages[i - 1] : null
              const nextMsg = i < messages.length - 1 ? messages[i + 1] : null
              // A separator needs a real datetime on both sides of the seam —
              // an optimistic message pushed before its created_at comes back
              // from the server just doesn't get one this render; it picks
              // one up the moment the real message replaces it.
              const daySep = Boolean(m.created_at) && (!prev?.created_at || !isSameDay(prev.created_at, m.created_at))
              // Tight spacing for a same-role run (a quick multi-part reply,
              // or a teacher firing off two messages before one lands) — but
              // never across the seam a day separator already draws; that
              // seam is its own reset regardless of who said what either
              // side of it.
              const grouped = !daySep && prev?.role === m.role
              // Timestamp only on the last bubble of a run — same as any
              // chat app's own convention, and it means the common case
              // (turns already alternate every message) shows one on nearly
              // everything, while a run of same-role bubbles only labels
              // where it actually ended.
              const groupEnd =
                !nextMsg ||
                nextMsg.role !== m.role ||
                (nextMsg.created_at && m.created_at && !isSameDay(nextMsg.created_at, m.created_at))
              return (
                <div key={m.id}>
                  {daySep ? (
                    <div className={i === 0 ? 'pb-4' : 'pb-4 pt-3'}>
                      <DaySeparator label={dayLabel(m.created_at)} />
                    </div>
                  ) : null}
                  {/* The wrapper, not Message itself, carries the scroll ref —
                      Message is a plain function component, not forwardRef, and
                      wrapping costs nothing layout-wise (a bare block div around
                      what's already a block-level flex item). See messageRefs and
                      pinToTopIdRef's own comment below for what this ref is for. */}
                  <div
                    className={i === 0 || daySep ? '' : grouped ? 'mt-2' : 'mt-7'}
                    ref={registerMessageRef(m.id)}
                  >
                    <Message
                      message={m}
                      subject={activeClass?.subject}
                      isLast={i === messages.length - 1}
                      onRetry={m.isError && !busy ? retryLast : undefined}
                      /* The pencil rendered unguarded while this was never passed, so
                         clicking it opened a working editor whose "Send again" threw
                         and silently reverted the text.

                         Hoisted to a stable callback (handleEditMessage) rather than
                         an inline arrow: Message is memo'd now, and a fresh closure
                         here every render would defeat that for every bubble in the
                         thread — which is the whole cost this memo exists to avoid. */
                      onEdit={m.role === 'user' && !busy ? handleEditMessage : undefined}
                      /* The day-by-day breakdown moved into ArtifactRail's own
                         "This week" section on desktop, which sits right next to
                         the plan it describes instead of scrolling away with the
                         transcript. Phone has no rail to carry it, so it stays
                         here for isPhone. */
                      hideWeekStrip={!isPhone}
                      voiceOpen={voiceOpen}
                      showTimestamp={groupEnd}
                    />
                  </div>
                </div>
              )
            })}

            {/* "The plan so far" — used to live only in the side rail
                (ArtifactRail's own DecisionStack), a separate card next to
                the conversation instead of part of it. On request, a plain
                list in the chat flow itself: no checkmarks, no tap-to-edit,
                just what's been settled so far. Same visibility as the rail
                version had — gone once the plan itself is being written or
                already exists, since a built plan or its progress is a
                clearer answer to "what's settled" than this list.

                Also gone while `pendingQuestions` is open: LessonQuestions
                answers each of its own bullet questions locally and only
                calls onAnswerQuestions/submit once with everything bundled
                after the LAST one — so for the entire time a teacher is
                working through that card, none of their answers exist in
                `messages` yet, and extract_decisions has nothing new to
                find. Showing this list next to that card meant a teacher
                who'd just picked an anchor text watched this keep insisting
                "not yet decided" through every question after it, which
                read as the app losing the answer, not as it waiting on a
                bundle. */}
            {!hasArtifact && !busy && !pendingQuestions && decisions.length > 0 ? (
              // fa-rise: this used to pop in/out with the conditional itself,
              // no different from any other layout change — but it's tied to
              // a few booleans that flip turn to turn (hasArtifact, busy),
              // so it visibly appeared and vanished as the teacher was mid-
              // conversation, not just once. An entrance at least announces
              // "new" rather than the list just being suddenly there.
              <div className="w-full fa-rise">
                <p className="eyebrow mb-2">The plan so far</p>
                <ul className="flex flex-col gap-1 text-sm leading-relaxed text-ink-soft">
                  {[...coreChecklist, ...extraDecisions].map((item) => (
                    <li key={item.key}>
                      <span className="font-medium text-ink">{item.label}:</span>{' '}
                      {item.value != null ? item.value : <span className="italic text-ink-faint">not yet decided</span>}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* Progress is the week filling in, not three bouncing dots — a
                teacher can see which day is being written and how many are
                left, which is the only thing worth knowing while waiting.
                loose, not compact: a vertical neomorphic list has room for a
                distinct in-progress row (a spinner, not just a blank line)
                that the five-across grid never did, and each row's own
                fa-rise plays the instant that day actually lands, not on a
                fixed stagger.

                On desktop the list itself now lives in ArtifactRail's "This
                week" section instead — right next to the plan it's about,
                not scrolling away with the transcript — so this keeps only
                the eyebrow label here; isPhone still gets the full list,
                since phone has no rail to carry it. */}
            {stream.isStreaming ? (
              <div className="w-full">
                <p className="eyebrow mb-2">
                  {stream.preview?.days?.length ? 'Writing the week' : 'Retrieving standards'}
                </p>
                {isPhone ? (
                  <WeekStrip days={stream.preview?.days} writing loose className="max-w-xs" />
                ) : null}
              </div>
            ) : revising ? (
              <p className="eyebrow">Revising…</p>
            ) : preparing ? (
              // The gap this covers: submit()'s first await, for a brand-new
              // chat, is api.createChat — which can run long on a cold Render
              // instance or a slow phone connection, and none of the other
              // busy flags exist yet. Without this line the message just sent
              // sat on screen with literally nothing happening beneath it.
              <p className="eyebrow">Sending…</p>
            ) : null}

            <div ref={endRef} />
          </div>
        </div>
      )}

      {/* An invisible spacer, not the dock itself — the dock is portaled to
          document.body just below (see the createPortal call) so it can float
          ABOVE the document overlay instead of being covered by it (or, as
          a first attempt got only as far as, merely not-covered-but-still-
          adjacent-to it). z-index alone can't reach: .artifact-overlay sits
          inside two separate backdrop-filter stacking contexts (this file's
          own `saturate-[1.2]` transcript wrapper, and AppShell's
          `glass-panel` chat card) — filter/backdrop-filter creates a
          stacking context the same way transform does, and no z-index set
          on a descendant of one can ever outrank a z-index set on an
          element outside it, however high (confirmed empirically — even
          `position: fixed` with z-index 9999, left in place, still lost to
          the document underneath). A portal to document.body is a genuine
          escape from both.

          This anchor is what keeps the floating dock's SCREEN POSITION
          correct without duplicating this file's own layout math: it's a
          plain shrink-0 flex child exactly where the dock used to render
          in-flow, sized to composerDockH (the portaled dock's own measured
          height, synced back — see that effect, declared near openTweak
          above) so the transcript above it doesn't grow into space the
          floating dock is visually covering. The sync effect up there
          reads THIS element's getBoundingClientRect() and keeps the portal
          host positioned over it, so the dock still tracks the chat
          column's left edge and width (e.g. when the plans rail toggles)
          exactly as if it had never left. */}
      {!isPhone ? <div ref={composerAnchorRef} className="shrink-0" style={{ height: composerDockH || undefined }} aria-hidden="true" /> : null}
      {renderComposerDock(
        <div ref={composerDockRef} className="relative shrink-0 z-10" style={{ pointerEvents: 'auto' }}>
      {/* While a plan is still being written, retain the compact progress row.
          Once the saved plan lands, PlanPeek replaces it so the same space
          becomes a thumb-driven reader rather than a second plan card. */}
      {hasArtifact && isPhone && !expanded && !artifact?.planId ? (
        <ArtifactRail
          artifact={{ ...liveArtifact, plan: livePlan }}
          classId={classId}
          onExpand={() => openDocument()}
          onOpenQuiz={openQuiz}
          busy={busy}
          quizBuilding={quizBuilding}
          variant="bar"
          artifactLoadError={artifactLoadError}
          onRetryArtifact={retryArtifactLoad}
        />
      ) : null}

      {artifact?.planId && hasArtifact && isPhone && !expanded ? (
        <PlanPeek
          open={planPeekOpen}
          onToggle={setPlanPeekOpen}
          weekLabel={livePlan?.week_of}
        >
          <ArtifactPanel
            artifact={{ ...liveArtifact, plan: livePlan }}
            classId={classId}
            subject={activeClass?.subject}
            missingDays="no_school"
            onCollapse={() => setPlanPeekOpen(false)}
            onReviseDay={reviseDay}
            onReviseDays={reviseDays}
            onPickStandard={pickStandard}
            onPlanRevised={onPlanRevised}
            busy={busy}
            preparing={preparing}
            streamingText={stream.text}
            openTweak={openTweak}
            setOpenTweak={setOpenTweak}
            flashCells={flashCells}
            onFullscreenChange={() => {}}
            mobileReader
          />
        </PlanPeek>
      ) : null}

      {/* The dock. Composer must stay in the SAME slot of the same parent across
          the empty/non-empty transition — it owns a MediaRecorder, a
          ResizeObserver and an autosized inline height, all of which die on
          remount. Only the wrapper's className may change. */}
      <div className={`shrink-0 bg-transparent pb-5 ${hasArtifact && isPhone && !expanded ? 'pt-2' : 'pt-3'}`}>
        <div className={`mx-auto w-full px-gutter transition-all duration-500 ease-out ${
          voiceOpen ? 'max-w-5xl' : 'max-w-4xl'
        }`}>
          {/* Keep this jump control in normal flow. The previous absolute
              placement was relative to the entire composer dock (including
              the plan peek and artifact bar), so it could float over a chat
              bubble instead of sitting just above the composer. */}
          {latestPill.mounted ? (
            <div className="mb-2 flex justify-center">
              <button
                type="button"
                className={`fa-rise fa-press flex min-h-touch items-center gap-2 rounded-full bg-paper-inset px-3.5 text-xs font-medium text-ink-soft transition-colors hover:bg-edge${latestPill.closing ? ' fa-chip-exit' : ''}`}
                onClick={() => {
                  endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
                }}
              >
                <ArrowDown size={13} aria-hidden="true" /> Latest
              </button>
            </div>
          ) : null}
          {/* navigator.onLine, not a failed request — this is proactive
              (shown the instant a device loses its link, before a teacher
              even tries to send anything) rather than reactive to one
              already-failed send. Same visual language as the queued-follow-
              up pill below it: a fact about the composer's current state,
              not an error to dismiss. */}
          {!isOnline ? (
            <div className="neo-inset mb-2 flex items-center gap-2 rounded-lg bg-paper-sunken px-3 py-2 text-xs text-ink-soft">
              <TriangleAlert size={13} className="shrink-0 text-flag" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                You’re offline. Anything you send will retry automatically once you’re back on wifi or cell data.
              </span>
            </div>
          ) : null}
          {/* A build finishing already gets its own message in the transcript
              ("Built ... Tell me what to change") — this is for the teacher
              who scrolled up to reread something, or alt-tabbed away, and
              would otherwise miss it landing. Self-dismisses; there's
              nothing to act on here, unlike the queued-message pill below,
              so no × or click target. */}
          {readyNoticeExit.mounted ? (
            <div
              key={readyNoticeSeq}
              className={`mb-2 flex items-center gap-2 rounded-lg bg-paper-sunken px-3 py-2 text-xs text-ink-soft ${
                readyNoticeExit.closing ? 'fa-chip-exit' : 'fa-rise'
              }`}
            >
              <CheckCircle2 size={13} className="shrink-0 text-ok" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{lastReadyNotice}</span>
            </div>
          ) : null}
          {/* The only visible sign a queued follow-up exists at all — without
              it, Enter clearing the box while busy would look identical to
              the text just vanishing. Sent automatically the moment `busy`
              clears (see the effect near queueOrSubmit); the × here is the
              one way to change your mind and get the text back instead. */}
          {queuedMessage ? (
            <div className="neo-inset mb-2 flex items-center gap-2 rounded-lg bg-paper-sunken px-3 py-2 text-xs text-ink-soft">
              <Clock size={13} className="shrink-0 text-ink-faint" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">
                Will send when ready:{' '}
                <span className="text-ink">
                  {queuedMessage.text || `Sent ${queuedMessage.attachments.length} file(s)`}
                </span>
              </span>
              <button
                type="button"
                className="btn-icon shrink-0"
                aria-label="Cancel queued message"
                title="Cancel — puts the text and attachments back in the box"
                onClick={() => {
                  setQuery(queuedMessage.text)
                  setAttachments(queuedMessage.attachments)
                  setQueuedMessage(null)
                }}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </div>
          ) : null}
          <Composer
            value={query}
            onChange={setQuery}
            onSubmit={queueOrSubmit}
            /* Only a real stream is abortable — see the Composer. Revising has
               no AbortController yet, so `busy` without either flag correctly
               falls through to the composer's "can't be interrupted" spinner. */
            onStop={stream.isStreaming ? stopGenerating : chatStream.isStreaming ? stopChatting : undefined}
            isStreaming={busy}
            attachments={attachments}
            setAttachments={setAttachments}
            onSaveAttachmentAsDocument={activeClass && !hasPacingGuide ? saveAttachmentAsDocument : undefined}
            onOpenVoice={betaFeaturesEnabled ? openVoice : undefined}
            voiceModeActive={voiceOpen}
            suggestions={composerSuggestions}
            questionsPanel={
              questionsExit.mounted && lastQuestions ? (
                <div className={`questions-dock${pendingQuestions ? ' is-open' : ''}`}>
                  <div className={`questions-dock-body${questionsExit.closing ? ' is-closing' : ''}`}>
                    <LessonQuestions
                      questions={lastQuestions.questions}
                      onSubmit={(text) => onAnswerQuestions(lastQuestions.message, text)}
                    />
                  </div>
                </div>
              ) : null
            }
            voicePanel={
              voiceExit.mounted ? (
                <div className={`voice-dock${voiceOpen ? ' is-open' : ''}`}>
                  <div className={`voice-dock-body${voiceExit.closing ? ' is-closing' : ''}`}>
                    <VoiceModePanel
                      onClose={closeVoice}
                      onUtterance={submit}
                      /* The panel's retry uses the same active chat/week/mode
                         context to create a fresh provider session. */
                      chatId={chatId ?? null}
                      weekNumber={conversationWeek ?? null}
                      voiceMode="brainstorm"
                      busy={busy}
                      isSpeaking={voice.speaking}
                      /* Straight off VoiceProvider — the sentence whose audio is
                         playing right now, from the Realtime session's own
                         output-transcript deltas rather than guessed at from a
                         character interval. */
                      caption={voice.caption}
                      decisions={decisions}
                      messages={messages}
                      activeClass={activeClass}
                      calendar={calendar}
                      onBuild={() => submit('Looks good, build the lesson plan.')}
                      /* Replay button: speaks the last reply again through the same
                         Realtime speech queue, captioning itself as it goes like any
                         other spoken text. undefined (not a no-op function) when
                         there's nothing to replay yet — VoiceModePanel hides the
                         button outright rather than rendering it disabled. */
                      onReplayLast={
                        lastReplyText
                          ? () => {
                              voice.speak(lastReplyText)
                            }
                          : undefined
                      }
                      /* Non-null the moment a week is actually saved — see
                         VoiceModePanel's BuiltPlanCard, which takes over from the
                         running decisions checklist once this is set. artifact.planId,
                         not liveArtifact/stream.preview: those cover the in-progress
                         preview too, and this is specifically "it's done and saved,"
                         not "it's still being written." */
                      builtPlan={artifact?.planId ? { planId: artifact.planId, weekLabel: artifact.plan?.week_of } : null}
                      /* "Making it" — the same stream.preview days feeding the text
                         chat's own WeekStrip (see the "Writing the week" block
                         above), read here too rather than re-fetched, so voice mode
                         and the text view can never show two different days-done
                         counts for the same in-flight generation. */
                      building={stream.isStreaming}
                      buildDays={stream.preview?.days}
                      /* The clarification cards, tappable inside the panel — voice
                         mode asks ONE question at a time (see the backend's voice
                         prompt) and shows its options here rather than reading them
                         aloud. */
                      questions={pendingQuestions?.questions || null}
                      onAnswer={(text) => {
                        // Silence whatever is being read out, keep the session —
                        // stop() here ended voice mode outright the first time a
                        // teacher tapped an option on a clarification card.
                        voice.cancelSpeech()
                        onAnswerQuestions(pendingQuestions.message, text)
                      }}
                    />
                  </div>
                </div>
              ) : null
            }
            /* The example is worth its length on a laptop and clipped on a
               phone — the textarea is one row, so the second line of a wrapped
               placeholder is simply cut off mid-word. */
            placeholder={
              artifact?.planId
                ? isPhone
                  ? 'Revise this plan…'
                  : 'What should change? — e.g. make Thursday a Socratic seminar'
                : isPhone
                  ? 'Plan this week…'
                  : 'What do you need a lesson plan for?'
            }
            sendLabel={artifact?.planId ? 'Revise the plan' : 'Build the lesson plan'}
          />
        </div>
      </div>
      </div>,
      )}
    </div>
  )

  /* The phone landing screen — see mobileShowHome's own comment above. After
     every hook (Rules of Hooks), before the real return; chatPane above
     still gets computed even though it's discarded here, which costs a
     render nobody sees rather than risk moving hook-bearing code around
     this file to avoid it. */
  if (isPhone && !chatId && mobileShowHome) {
    return <MobileChatHome onNavigate={() => setMobileShowHome(false)} />
  }

  // On a phone, a lesson plan is a place to go, not a sheet competing with
  // chat, keyboard, and composer layers. This provides one predictable
  // vertical scroll surface while keeping the same plan data and actions.
  if (mobileReaderOpen) {
    return (
      <main className={`mobile-plan-reader${overlayExit.closing ? ' is-closing' : ''}`}>
        {artifactEl}
      </main>
    )
  }

  /* The chat pane keeps the SAME slot in the SAME parent in every state — only
     its width changes. Moving it between containers would remount the Composer,
     and the Composer owns a MediaRecorder and a ResizeObserver that do not
     survive that. */
  return (
    // fa-rise-panel, isPhone-only: this tree mounts fresh the moment
    // mobileShowHome flips false (a real unmount of MobileChatHome, not a
    // prop change on a tree already on screen — see the early return
    // above), so the same rise motion MobileChatHome plays on ITS own
    // mount plays here too. Chat-to-chat navigation while already here
    // doesn't remount this node (same route pattern, same position in the
    // tree), so it won't replay on every chat switch — only on the one
    // transition this is meant to soften. The -panel variant, not plain
    // fa-rise — see fa-rise-panel's own comment in base.css for why a
    // full-viewport container inside AppShell's blurred "main" panel
    // shouldn't animate opacity.
    <div ref={overlayAnchorRef} className={`flex h-full w-full min-w-0 gap-2${isPhone ? ' fa-rise-panel' : ''}`}>
      {/* OUTSIDE chatPane. It used to live inside it, and ArtifactPanel sets
          aria-modal="true" when overlaying — which tells assistive tech to
          ignore everything outside the dialog, so on a phone with the document
          open "Building the lesson plan." was never announced. "Revising" is in
          here too; it was a plain <p> with no live semantics at all. */}
      <div className="visually-hidden" role="status" aria-live="polite">
        {stream.isStreaming
          ? 'Building the lesson plan.'
          : revising
            ? 'Revising the plan.'
            : preparing
              ? 'Sending.'
              : chatStream.isStreaming
                ? /* The one busy state this region never announced — a sighted
                     teacher sees the "Thinking…" eyebrow (below), but nothing
                     here ever said so, which reads as dead air to anyone
                     depending on this region instead of looking at the
                     screen. */
                  'Thinking.'
                : artifact?.planId
                  ? 'Lesson plan ready.'
                  : ''}
      </div>

      <div className="flex min-w-0 flex-1 flex-col glass-panel rounded-2xl shadow-sm overflow-hidden">
        {chatPane}
      </div>

      {/* The rail docks from 768 up. Below 768 it is the bar inside chatPane
          instead (the isPhone-only ArtifactRail "bar" variant above the
          composer).

          Excluded once overlayOpen: this drawer reserves real flex width in
          the SAME row as the chat pane, which is what the composer's
          portal anchor measures (see composerAnchorRef's own comment) —
          leaving it mounted while the full-screen .artifact-overlay is open
          shrank that anchor to `row width - drawer width`, so the
          "edge-to-edge, composer included" overlay described just below
          never actually reached the left edge, and the composer it was
          supposed to float above sat at the shrunk width instead of the
          full one. The overlay already shows everything this drawer shows
          (Download, "Built from", grounding) at full size, so there is
          nothing this adds once it is open — it should get out of the way,
          not sit underneath eating width nobody can see it use. */}
      {!isPhone && !overlayOpen ? (
        <ArtifactDrawer
          open={railOpen}
          onToggle={() => setRailOpen((o) => !o)}
          hasArtifact={hasArtifact}
          artifact={{ ...liveArtifact, plan: livePlan }}
          classId={classId}
          onExpand={() => openDocument()}
          onOpenQuiz={openQuiz}
          onOpenStandards={openStandards}
          onOpenCalendar={openCalendar}
          onOpenDocument={openDoc}
          busy={busy}
          quizBuilding={quizBuilding}
          artifactLoadError={artifactLoadError}
          onRetryArtifact={retryArtifactLoad}
          onSuggestPrompt={suggestRailPrompt}
        />
      ) : null}

      {/* The document always opens as a full glass overlay (2026-08-27) —
          there is no more docked side-by-side mode at any width, so this is
          the only way `artifactEl` ever renders. On desktop it goes
          edge-to-edge, composer included — the composer dock is portaled
          above this (see its own comment near chatPane's return), floating
          on TOP of the panel rather than being carved out of its bounds.
          On phone, that same "floats on top" composer would otherwise sit
          directly over the bottom ~130px of the sheet (both anchor to the
          screen's own bottom edge), which doesn't just look wrong — a
          touch landing in that band hits the composer's textarea instead
          of the sheet underneath it, and "I cannot scroll down to view
          more" (reported 2026-08-27) was exactly that: the last stretch of
          the sheet's own scrollable content was there, just underneath an
          invisible composer sitting on top of it. --composer-h feeds
          composerDockH (the portal dock's own live-measured height,
          already tracked for the anchor above) into the sheet's bottom
          media query in base.css, so the sheet's own bottom edge stops
          short of the composer instead of running underneath it. */}
      {/* Always portaled into overlayPortalHost (see its own comment near
          artifactFullscreen) — never switched between rendered-in-place and
          portaled, which is what used to remount ArtifactPanel (and reset
          its isFullscreen state) the instant maximize was clicked. The host
          itself is resized to either #main's own box (docked) or the true
          viewport (fullscreen), so .artifact-overlay's own offsets
          (base.css) keep working unchanged either way. */}
      {overlayExit.mounted && !mobileReaderOpen
        ? createPortal(
            <>
              <button
                type="button"
                aria-label={`Close ${viewLabel}`}
                className={`panel-scrim${overlayExit.closing ? ' is-closing' : ''}`}
                onClick={collapse}
              />
              <div
                className={`artifact-overlay${overlayExit.closing ? ' is-closing' : ''}${artifactFullscreen ? ' is-overlay-fullscreen' : ''}`}
                style={{ '--composer-h': `${composerDockH}px` }}
              >
                {/* artifactContentReady: see its own comment near overlayOpen —
                    the real content (the district table, potentially dozens of
                    cells) mounts a couple of frames late on purpose, so laying
                    it out doesn't compete with the slide-in's own opening
                    frames. Empty glass for a ~30ms blink, not a spinner: at
                    this duration a loading indicator would just be visual
                    noise flashing in and out, and the panel's own background
                    already reads as "something is here." Skipped entirely
                    while closing — the exit is fast (130ms) and this has
                    already been showing real content the whole time it was
                    open, so there is nothing to stagger on the way out. */}
                {artifactContentReady || overlayExit.closing ? artifactEl : null}
              </div>
            </>,
            overlayPortalHost
          )
        : null}

      <AddDocumentDialog
        open={documentDialogOpen}
        onClose={() => setDocumentDialogOpen(false)}
        cls={activeClass}
        onChanged={() => qc.invalidateQueries({ queryKey: qk.classDocuments(classId) })}
      />

    </div>
  )
}
