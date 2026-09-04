import { createContext, Fragment, lazy, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import usaMap from '@svg-maps/usa'
import {
  BookOpen,
  Building2,
  Calculator,
  Check,
  CheckCircle2,
  Code2,
  FileText,
  FlaskConical,
  GraduationCap,
  Grid2x2,
  HeartPulse,
  Landmark,
  Languages,
  Loader2,
  Mail,
  MapPin,
  Palette,
  Search,
  Sparkles,
  Users,
  X,
} from 'lucide-react'
import { api } from '../lib/api'
import { qk } from '../lib/queryKeys'
import { deferOnboarding } from '../lib/onboardingWizardBus'
import { GENERIC_SCHOOL, hasChosenSchool, hasUsableSchoolTemplate } from '../lib/schools'
import { useAuth } from '../lib/authContext'
import { useToast } from '../lib/toastContext'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useExitTransition } from '../hooks/useExitTransition'
import { GRADES, gradeLabel, gradeSelectValue } from '../lib/grades'
import {
  GROUP_ARTS,
  GROUP_CS,
  GROUP_ENGLISH,
  GROUP_HISTORY,
  GROUP_MATH,
  GROUP_OTHER,
  GROUP_PE_HEALTH,
  GROUP_SCIENCE,
  GROUP_SPECIAL_ED,
  GROUP_WORLD_LANG,
  gradeRangeLabel,
  groupFrameworks,
  matchesFramework,
} from '../lib/frameworks'
import { US_STATES, isStandardsReady } from '../lib/states'
import { ONBOARDING_STEPS, derivePlan, nextStep, prevStep } from '../lib/onboardingPlan'
import { SchoolSelect } from './SchoolSelect'
import { PendingCalendarReview } from './PendingCalendarReview'
import { CalendarBody } from './ArtifactDetailPanel'
import { UploadDropzone } from './UploadDropzone'
import { OnboardingStepRail } from './onboarding/OnboardingStepRail'
import { OnboardingQuestion, OnboardingChoiceLabel } from './onboarding/OnboardingQuestion'
import { OnboardingActions } from './onboarding/OnboardingActions'
import { AvatarPicker } from './AvatarPicker'
import { getAvatar, getInitials } from '../lib/avatars'
// ClassDocuments used to live inside ClassPage.jsx and was re-exported from
// there; it later moved out to its own file (components/ClassDocuments.jsx)
// with nothing left behind at the old path, so this lazy import silently
// resolved to `{ default: undefined }` and crashed the MaterialsStep below
// with "Element type is invalid" the moment a teacher reached it — every
// first-run account, since /welcome always leaves `documents` in the plan.
const ClassDocuments = lazy(() => import('./ClassDocuments.jsx').then((module) => ({ default: module.ClassDocuments })))


/* Steps move UP the way a path does, not sideways like pages.
 *
 * The rail beside them travels DOWN as setup progresses, so the content
 * advancing upward is the same motion read from the other side: forward, the
 * next question rises into place; back, the previous one drops in from above.
 * A horizontal slide said "different page" instead, which is the opposite of
 * what a numbered sequence wants to say.
 *
 * 20px, where the app's own vertical reveals are 4-8px (--motion-reveal,
 * .fa-rise, App.jsx's route transition). Deliberately larger: those are
 * elements settling INTO a page, and this is the whole pane changing, which is
 * one authored moment rather than the scattered motion DESIGN.md rules out.
 *
 * Asymmetric, because AnimatePresence mode="wait" plays exit fully before
 * enter starts: two symmetric --t-base legs would total 440ms for one step.
 * --t-fast out and --t-base in lands around --t-enter. --ease-glide rather
 * than --ease-out, which is already at full speed on its first frame and
 * reads as a snap at this size (see that token's own comment).
 *
 * <MotionConfig reducedMotion="user"> in App.jsx neutralises the transform for
 * anyone who asked; base.css's blanket prefers-reduced-motion block only
 * governs CSS, which is why the rail's own transitions stay in CSS.
 */
const STEP_VARIANTS = {
  enter: (dir) => ({ opacity: 0, y: dir * 20 }),
  center: { opacity: 1, y: 0, transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] } },
  exit: (dir) => ({ opacity: 0, y: dir * -20, transition: { duration: 0.13, ease: [0.22, 1, 0.36, 1] } }),
}

/* The action row belongs to the wizard, not to each individual question.
 *
 * Steps register only their current action contract; this shared row renders
 * once below the active question in the content column. That keeps short steps
 * self-contained instead of pinning their navigation to a separate screen
 * footer, while long steps retain ordinary, safe scrolling to their actions.
 *
 * A ref, rather than action config in the plan module, is deliberate. The
 * plan is dependency-free and describes durable flow shape; callbacks, busy
 * flags, and the format upload's local review phase are live React concerns.
 * The ref lets the footer read the latest callbacks without turning a child
 * effect into a render loop every time a handler closes over fresh state. */
const OnboardingActionContext = createContext(null)

function useOnboardingActions(config) {
  const register = useContext(OnboardingActionContext)
  const configRef = useRef(config)
  configRef.current = config

  useLayoutEffect(() => {
    if (!register) return undefined
    return register(configRef)
  }, [register])
}

/* The teacher's own chosen icon, pinned to the footer's own bottom-left
 * corner from the moment they pick one on the Profile step onward — a
 * small, persistent confirmation of "this is you" that stays in view for
 * the rest of setup instead of only appearing back on Settings later.
 * Falls back to initials the same way AvatarPicker's own "no avatar" tile
 * does, since avatar: null is a real, deliberate choice — not a state that
 * still needs picking. */
function OnboardingFooterAvatar({ configRef }) {
  const { user } = useAuth()
  if (!user) return null
  const avatar = getAvatar(user.avatar)
  // Only matters when there's no chosen avatar — a real emoji pick doesn't
  // change just because the name field is mid-edit.
  const previewName = configRef?.current?.previewName
  return (
    <span
      className={`onboarding-footer-avatar${avatar ? ` ${avatar.bg}` : ''}`}
      aria-hidden="true"
      title={avatar?.label || 'Your icon'}
    >
      {avatar ? avatar.emoji : getInitials(previewName ?? user.name)}
    </span>
  )
}

function OnboardingFooter({ configRef }) {
  const config = configRef?.current
  if (!config) return <div className="onboarding-footer" aria-hidden="true" />

  if (config.status) {
    return (
      <div className="onboarding-footer">
        <OnboardingFooterAvatar configRef={configRef} />
        <p className="flex items-center gap-2 text-sm text-ink-muted" role="status">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" /> {config.status}
        </p>
      </div>
    )
  }

  return (
    <div className="onboarding-footer">
      <OnboardingFooterAvatar configRef={configRef} />
      {config.onBack ? (
        <button type="button" className="onboarding-quiet onboarding-footer-back" onClick={config.onBack}>
          <span aria-hidden="true">←</span> {config.backLabel || 'Back'}
        </button>
      ) : null}
      <OnboardingActions {...config} hideBack hideSkip />
      {config.onSkip ? (
        <button type="button" className="onboarding-quiet onboarding-footer-skip" onClick={config.onSkip}>
          {config.skipLabel || 'Skip for now'}
        </button>
      ) : null}
    </div>
  )
}

/* Post-login guided setup — welcome, confirm the school & template, confirm
 * the class, upload supporting documents, a few tips, done. Every step below
 * reuses an existing piece rather than re-implementing it: SchoolSelect and
 * api.uploadSchoolTemplate (WelcomePage.jsx), api.updateClass + FrameworkPicker
 * (ClassPage.jsx's own ClassDetail edit form), and ClassDocuments itself
 * (also ClassPage.jsx, exported for exactly this reuse).
 *
 * Gating (who sees this, and when) lives in the caller — this component only
 * renders what `open` and `cls` say to. `cls` is the account's current/first
 * class; there is nothing to confirm or upload against without one.
 *
 * `variant`: 'modal' (default) is AppShell's "take the tour again" — a dialog
 * layered over the app the account has already been using. 'page' is the
 * first-run case (OnboardingSetupPage.jsx): a brand-new account has no app
 * underneath to layer over, so it renders as the page itself — no scrim, no
 * dialog role, nothing to click past to reach a half-set-up class.
 */
export function OnboardingWizard({ open, onClose, cls, variant = 'modal' }) {
  /* The class may not exist yet.
   *
   * /welcome used to collect course + grade and POST /api/classes before this
   * component ever mounted, which is why it could assume a class and bail
   * without one. It also meant the teacher answered course and grade there and
   * then answered them again here, because the plan derivation branched on
   * `variant === 'page'` and pushed the course step unconditionally for the
   * first run. Now there is one flow: the course step creates the class.
   *
   * Held in state rather than pushed back up through a callback and a route
   * change. Navigating to /c/:id/onboarding at this point would REMOUNT the
   * wizard on a different Route and reset stepKey to the plan's first step,
   * throwing away the answers the teacher had just given. The URL stays
   * /onboarding for the whole first run; a reload mid-flow is handled by the
   * path that already existed for it — RootRedirect sees a class, sends them
   * into it, and ClassRoutes' guard sends them back here to resume, which is
   * safe because every step saves before it advances. */
  const [createdClass, setCreatedClass] = useState(null)
  /* The name that gets PRINTED on the plans.
   *
   * db.py seeds settings.teacher from users.name, and service.py's identity
   * stamp puts that straight into the .docx header — so this is the name a
   * teacher's district sees, not just a greeting. It was never asked for
   * anywhere in setup: signup requires one, and Google hands over whatever it
   * has on file, which is a legal name ("Joshua Cole") where a lesson plan
   * usually wants what the school calls you. Confirming it costs one field on
   * a step that had nothing at stake. */
  const [teacherName, setTeacherName] = useState('')
  const [savingProfile, setSavingProfile] = useState(false)
  const activeClass = cls || createdClass
  const toast = useToast()
  const qc = useQueryClient()
  const { user, refresh } = useAuth()
  const { mounted, closing } = useExitTransition(open, 220)
  const dialogRef = useRef(null)
  const scrollRef = useRef(null)
  const settledStepRef = useRef(null)
  const [footerRef, setFooterRef] = useState(null)
  const registerFooter = useCallback((nextRef) => {
    setFooterRef(nextRef)
    return () => setFooterRef((current) => (current === nextRef ? null : current))
  }, [])

  /* Tracked by KEY, not by index. The step list is built from what this
   * account still has to answer (see `plan` below), so it isn't a fixed
   * length — and an index into a list that can grow or shrink underneath you
   * is how a wizard lands someone on the wrong screen. A key stays put.
   *
   * Starts null rather than at a hardcoded first step. It used to be
   * useState('welcome'), and when the steps were renamed that literal stopped
   * matching any branch of the dispatch below — which fell through to the
   * FINISH screen. So the flow rendered "your workspace is ready" for one
   * frame before the effect corrected it, and because AnimatePresence
   * mode="wait" holds an exiting child until its animation completes, that
   * wrong screen was what a teacher actually sat looking at. Deriving it means
   * there is no literal to fall out of step with the plan. */
  const [stepKey, setStepKey] = useState(null)
  // +1/-1, read by the step's own enter animation (onboarding-step-enter,
  // base.css) to decide which side it slides in from — forward feels like
  // moving on, back feels like undoing, and a single direction for both
  // would read as the same motion regardless of which key the teacher
  // just pressed.
  const [direction, setDirection] = useState(1)

  // School and lesson-plan format steps
  const [school, setSchool] = useState(cls?.school || '')
  const [templateFile, setTemplateFile] = useState(null)
  const [templateUrl, setTemplateUrl] = useState('')
  const [blankTemplateAttested, setBlankTemplateAttested] = useState(false)
  const [savingSchool, setSavingSchool] = useState(false)
  const [savingTemplate, setSavingTemplate] = useState(false)
  const [templatePhase, setTemplatePhase] = useState('upload')
  const [templateAnalysis, setTemplateAnalysis] = useState(null)
  const [templateFindings, setTemplateFindings] = useState([])
  const [templateAnalysisStatus, setTemplateAnalysisStatus] = useState(null)

  // State is the first onboarding decision because it determines which
  // standards catalog the rest of the setup should be grounded in.
  const [state, setState] = useState(cls?.state || '')
  const [stateError, setStateError] = useState(null)

  // Confirm-class step
  const [subject, setSubject] = useState(cls?.subject || '')
  /* '' -- not DEFAULT_GRADE -- for a class that has no grade yet.
     gradeSelectValue falls back to '11' when its second argument is omitted,
     so this used to open on 11th for a brand-new class and a K-5 teacher who
     never touched the select got a class silently grounded in grade 11
     language. routes/classes.py defaults the same way and prompts.py's
     grounding_constraints uses grade directly to decide which standards are
     eligible at all, so nothing downstream would have caught it. Empty means
     unchosen, saveCourse refuses to continue without it, and it doubles as
     "all grades" for the course filter below. */
  const [grade, setGrade] = useState(gradeSelectValue(cls?.grade, ''))
  const [savingCourse, setSavingCourse] = useState(false)
  const [courseError, setCourseError] = useState(null)
  /* The course step's own three-screen flow (grade, then discipline, then
     course) — lifted up here rather than kept as CourseStep's own local
     state because the footer (Back/Continue label, disabled state) lives
     OUTSIDE CourseStep and only re-renders when ITS OWN props change.
     useOnboardingActions writes into a ref every render, but nothing makes
     OnboardingFooter re-render just because that ref mutated — only a
     state change on a shared ancestor (this component) does that. Local
     state inside CourseStep would leave the footer showing stale button
     labels one screen behind. */
  const [courseSubStep, setCourseSubStep] = useState(() => (subject ? 'course' : grade ? 'discipline' : 'grade'))
  const [courseDiscipline, setCourseDiscipline] = useState(null)

  const [finishing, setFinishing] = useState(false)

  const { data: frameworks = [] } = useQuery({
    queryKey: qk.frameworks,
    queryFn: () => api.getFrameworks(),
    staleTime: Infinity,
    enabled: open,
  })
  const { data: schools = [] } = useQuery({
    queryKey: qk.schools,
    queryFn: () => api.listSchools(),
    staleTime: Infinity,
    enabled: open,
  })
  const { data: schoolTemplatesData, isLoading: schoolTemplatesLoading } = useQuery({
    queryKey: ['school-templates', school],
    queryFn: () => api.listSchoolTemplates(school),
    enabled: open && hasChosenSchool(school),
  })
  /* Memoized because the plan derivation takes it as a dependency. `?? []`
     inline produced a brand-new array identity every render, so that useMemo
     never memoized anything and oxlint flagged the dependency as a lie. */
  const schoolTemplates = useMemo(() => schoolTemplatesData?.templates || [], [schoolTemplatesData])
  const [selectingTemplateId, setSelectingTemplateId] = useState(null)

  // Reset to a clean first step every time this opens on a (possibly
  // different) class, rather than resuming wherever a previous open left off.
  useEffect(() => {
    if (!open) return
    settledStepRef.current = null
    /* The class this wizard just created, arriving back through the prop, is
       not a different class — and resetting for it wipes out the answers that
       created it.
    
       Worth spelling out, because the obvious fix isn't one. Keying this
       effect on `cls?.id` instead of the active class looks sufficient, but
       saveCourse calls refresh() and invalidates qk.classes, so
       OnboardingSetupPage re-reads and hands the brand-new class down as
       `cls` a beat later. The prop changes from undefined to the new id either
       way, the effect fires, stepKey resets to the plan's first step, and the
       teacher lands back on the profile question with a class they can't see
       they already made. Compare against what we created, not against
       whether anything changed. */
    if (cls?.id && cls.id === createdClass?.id) return
    setStepKey(livePlan[0])
    setTeacherName(user?.name || '')
    setDirection(1)
    setSchool(activeClass?.school || '')
    setTemplateFile(null)
    setTemplateUrl('')
    setBlankTemplateAttested(false)
    setTemplatePhase('upload')
    setTemplateAnalysis(null)
    setTemplateFindings([])
    setTemplateAnalysisStatus(null)
    setSelectingTemplateId(null)
    setState(activeClass?.state || '')
    setStateError(false)
    setSubject(activeClass?.subject || '')
    setGrade(gradeSelectValue(activeClass?.grade, ''))
    setCourseSubStep(activeClass?.subject ? 'course' : activeClass?.grade ? 'discipline' : 'grade')
    // Re-derived once frameworks load — see the effect inside CourseStep.
    setCourseDiscipline(null)
    /* Keyed on the class this wizard was OPENED with, not on activeClass.
       activeClass changes the moment the course step creates one, and this
       effect resets stepKey to the plan's first step — so on the very first
       run, creating the class threw the teacher straight back to the profile
       question with their answers re-read from the class they had just made.
       "Opened on a different class" and "created a class mid-flow" are not the
       same event, and only the first one should reset anything. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cls?.id])

  /* Wrapped, not passed directly: useFocusTrap hands onEscape the keyboard
     event, and onClose's first parameter is now the class the flow finished
     with — so a bare reference made Escape look like "closed with this
     KeyboardEvent as your class". */
  useFocusTrap(dialogRef, { active: open, trap: true, onEscape: () => onClose(activeClass) })

  /* hasChosenSchool, not a bare `school` truthiness check — see lib/schools.js.
     users.school DEFAULTs to 'generic', so a brand-new account that has never
     been asked anything already holds a truthy value here, while
     schools.find() for that same value returns undefined because 'generic' is
     deliberately not a row in the table. The old test read
     `school && selectedSchool && ...`, so BOTH halves evaluated falsy for
     exactly the accounts the step exists for: every new teacher silently
     skipped it, was never asked where they teach, and got dateless weeks plus
     the default school's layout on every download with nothing saying so. */
  const chosenSchool = hasChosenSchool(school)
  const selectedSchool = schools.find((s) => s.id === school)
  // A school can have a usable hand-written or verified generated builder
  // while its separate template-content review is still pending. Onboarding
  // should ask for a file only when downloads genuinely have no usable school
  // format, not when the review status happens to lag behind the builder.
  const schoolHasUsableTemplate = hasUsableSchoolTemplate(selectedSchool)
  const schoolNeedsTemplate = chosenSchool && selectedSchool && !schoolHasUsableTemplate

  /* Which steps this account actually has to sit through. The page variant is
   * the first-run setup, so it always includes a course confirmation even if
   * /welcome already supplied a starting value. That gives the teacher a
   * clear chance to choose the course that should drive standards and plan
   * language; the modal variant used from Settings still skips a completed
   * course choice and only shows genuinely unfinished setup.
   */
  /* Live, not stateful, and now derived in ONE place — lib/onboardingPlan.js,
   * which scripts/test-onboarding-steps.mjs imports directly. It used to be
   * computed here and re-implemented in that test, which is how the two came
   * to disagree while CI stayed green.
   *
   * Still called through useMemo rather than committed by an effect. `schools`
   * is an async query, so schoolNeedsTemplate can flip from false to true
   * partway through a render; a version of this that stored the plan in state
   * and recomputed it from a useEffect lagged one render behind that flip
   * (effects commit after the render that triggered them), which was how the
   * welcome screen's old step-count copy briefly showed a stale number before
   * correcting itself.
   *
   * firstRun maps to the page variant, which IS the first-run route
   * (OnboardingSetupPage); Settings' "take the tour again" opens the modal and
   * skips the avatar question. hasMaterials is false for now: which documents
   * a class already has is ClassDocuments' own query, not this component's, so
   * the step is always offered and is skippable rather than being hidden on
   * data this component doesn't hold.
   */
  const livePlan = useMemo(
    () =>
      derivePlan({
        firstRun: variant === 'page',
        subject,
        grade,
        state,
        school,
        schools,
        schoolTemplates,
        schoolTemplatesLoading,
        calendarStatus: selectedSchool?.has_pending_calendar
          ? 'pending'
          : selectedSchool?.has_calendar
            ? 'confirmed'
            : 'none',
        hasMaterials: false,
      }),
    [variant, subject, grade, state, school, schools, schoolTemplates, schoolTemplatesLoading, selectedSchool],
  )

  /* Frozen the moment the teacher leaves welcome — once they've started
   * moving through the flow, the shape must not shift under them even if
   * school/subject change later (e.g. the SchoolStep itself edits `school`). */
  const [frozenPlan, setFrozenPlan] = useState(null)
  useEffect(() => {
    if (!open) { setFrozenPlan(null); return }
    if (stepKey === plan[0]) { setFrozenPlan(null); return }
    setFrozenPlan((prev) => prev || livePlan)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, stepKey])
  const plan = frozenPlan || livePlan

  const goTo = (next) => {
    setDirection(plan.indexOf(next) > plan.indexOf(stepKey) ? 1 : -1)
    setStepKey(next)
  }
  const goNext = () => goTo(nextStep(plan, stepKey))
  const goBack = () => goTo(prevStep(plan, stepKey))

  /* The rail now includes the closing screen as the route's visible endpoint.
     `preview` is still terminal in the PLAN (and its CTA still records
     completion); including it here only gives the journey a destination
     instead of making the progress rail disappear at the exact moment a
     teacher should be able to see what they have reached. */
  const progressSteps = plan

  const settleStep = useCallback(() => {
    /* Reset only after the incoming pane has finished entering. Resetting on
       goTo() moved the outgoing pane to the top while AnimatePresence was
       still showing it, which made a Back click look like the document jumped
       before the step itself changed. The focus target is deliberately the
       heading, not the first control: it tells a screen-reader user which
       question arrived and does not skip the explanation that makes a choice
       safe to make. */
    if (settledStepRef.current === stepKey) return
    const isInitialEntry = settledStepRef.current === null
    settledStepRef.current = stepKey
    scrollRef.current?.scrollTo({ top: 0, behavior: 'auto' })
    if (!isInitialEntry) document.getElementById('onboarding-title')?.focus({ preventScroll: true })
  }, [stepKey])

  /* A teacher outside the ingested states asking for theirs.
   *
   * Records the interest and emails support (backend/routes/onboarding.py).
   * The state they asked for is remembered locally so the button can settle
   * into an acknowledgement rather than staying pressable — asking twice is
   * harmless server-side, but a button that looks like it did nothing invites
   * exactly that. */
  const [requestingState, setRequestingState] = useState(false)
  const [requestedState, setRequestedState] = useState(null)

  const requestStateStandards = async (code) => {
    setRequestingState(true)
    try {
      await api.requestStateStandards(code)
      setRequestedState(code)
    } catch (err) {
      toast.apiError('Could not send that request', err)
    } finally {
      setRequestingState(false)
    }
  }

  const saveSchool = async () => {
    /* The state is the required half of this step: it is what says which
       course of study a plan's standards are quoted from. The school half is
       skippable — see the step's own Skip. */
    if (!state) {
      setStateError('Choose your state — it decides which standards your plans quote.')
      return
    }
    if (!isStandardsReady(state)) {
      setStateError(
        "We don't have that state's standards yet. Ask for it above, then pick Alabama to carry on for now.",
      )
      return
    }
    setStateError(null)
    setSavingSchool(true)
    try {
      /* No class yet on a first run — this step now runs BEFORE the course
         step that creates one. The account-level updateMe above is what makes
         that safe for the school half: db.create_class stamps
         get_user_school(), so the class inherits it. The state half is held in
         component state and handed to api.createClass by saveCourse. Patch
         directly only when a class already exists, which is the re-run and
         resume case. */
      if (activeClass && state !== (activeClass.state || '')) {
        await api.updateClass(activeClass.id, { state })
        qc.invalidateQueries({ queryKey: qk.classes })
      }
      // Keep the account-level school in sync with the class selection. This
      // also authorizes the just-selected teacher to upload a personal
      // template for that school after choosing it in onboarding.
      if (school && school !== user?.school) {
        await api.updateMe({ school })
      }
      /* Only ever WRITES a school, never clears one.
      
         The guard used to be a plain inequality, so advancing without choosing
         PATCHed school: '' straight over whatever the class already had. That
         is reachable in one click — this step's Continue has never been
         disabled, and it is skippable by design — and the value it wiped is
         load-bearing: schoolcal.py resolves the calendar from it and
         docx_build resolves the district format from it, so a blanked school
         quietly costs the teacher both. A teacher who doesn't answer keeps the
         account default ('generic'), which plans by week number and says so on
         the calendar step, rather than ending up with neither. */
      if (activeClass && school && school !== (activeClass.school || '')) {
        await api.updateClass(activeClass.id, { school })
        qc.invalidateQueries({ queryKey: qk.classes })
      }
      goNext()
    } catch (err) {
      toast.apiError('Could not save that', err)
    } finally {
      setSavingSchool(false)
    }
  }

  const saveTemplate = async () => {
    if (templatePhase === 'confirmed') {
      goNext()
      return
    }
    if (!templateFile && !templateUrl.trim()) {
      goNext()
      return
    }
    setSavingTemplate(true)
    setTemplatePhase('processing')
    try {
      const result = await api.uploadSchoolTemplate(school, {
        file: templateFile,
        sourceUrl: templateUrl.trim() || undefined,
        blankTemplateAttested,
        templateScope: schoolTemplates.length ? 'personal' : 'school_candidate',
      })
      let parsedAnalysis = result?.analysis || null
      if (!parsedAnalysis && result?.template?.analysis_summary) {
        try {
          parsedAnalysis = JSON.parse(result.template.analysis_summary)
        } catch {
          parsedAnalysis = null
        }
      }
      setTemplateAnalysis(parsedAnalysis)
      setTemplateFindings(result?.findings || [])
      setTemplateAnalysisStatus(result?.template?.analysis_status || result?.status || null)
      setTemplatePhase('review')
      qc.invalidateQueries({ queryKey: qk.schools })
      qc.invalidateQueries({ queryKey: ['school-templates', school] })
    } catch (err) {
      setTemplatePhase('upload')
      toast.apiError('Could not submit that format', err)
    } finally {
      setSavingTemplate(false)
    }
  }

  const selectOnboardingTemplate = async (template) => {
    setSelectingTemplateId(template.id)
    try {
      await api.selectSchoolTemplate(school, template.id)
      await qc.invalidateQueries({ queryKey: ['school-templates', school] })
      toast.success('Template selected', 'This format will be used for your lesson plans.')
    } catch (err) {
      toast.apiError('Could not select that template', err)
    } finally {
      setSelectingTemplateId(null)
    }
  }

  const saveProfile = async () => {
    const next = teacherName.trim()
    setSavingProfile(true)
    try {
      /* Only writes a real change, and never blanks the name: signup and
         Google both guarantee one, so an empty field here means the teacher
         cleared it rather than that they have none — and settings.teacher
         feeds the .docx header, so writing '' would strip their name off every
         plan they download. */
      if (next && next !== (user?.name || '')) {
        await api.updateMe({ name: next })
        await refresh()
      }
      goNext()
    } catch (err) {
      toast.apiError('Could not save your name', err)
    } finally {
      setSavingProfile(false)
    }
  }

  /* Takes an optional override rather than reading `subject` alone: the
     course sub-step calls setSubject(fw.id) and this in the same click
     handler, and `subject` inside this closure is still the PREVIOUS
     render's value at that point — setState never applies mid-handler. A
     picked course would otherwise save whatever was picked before it (or
     nothing, on the very first pick), which is exactly the bug a comment
     right below this one used to warn about for the old click-then-Continue
     flow and would silently reintroduce here for click-to-advance. */
  const saveCourse = async (overrideSubject) => {
    const courseSubject = overrideSubject ?? subject
    if (!courseSubject) {
      setCourseError('Pick a course — it decides which standards your plans are grounded in.')
      return
    }
    /* Grade is validated, not defaulted, and this is the one validation in the
       flow that is load-bearing rather than tidy. routes/classes.py's
       ClassBody.grade defaults every new class to 11, and prompts.py's
       grounding_constraints uses grade directly to decide which standards are
       even eligible — so a K-8 teacher who never answered got plans silently
       grounded in grade 11 language. db.py's migration 38 is a monument to
       the same bug arriving from the other direction. */
    if (!grade) {
      setCourseError('Pick a grade — it decides which standards and language fit your students.')
      return
    }
    setCourseError(null)
    setSavingCourse(true)
    try {
      if (!activeClass) {
        /* First run: this step IS the class creation, which /welcome used to
           do before the wizard mounted. The account-level school baseline
           comes with it — users.school defaults to 'generic', and setting it
           explicitly here keeps a teacher whose school isn't listed able to
           finish (schoolcal.py's NO_CALENDAR_SCHOOL_ID plans by week number
           rather than stopping short). hasChosenSchool() still reports false
           for it, so the school step is still asked. */
        if (!user?.school) await api.updateMe({ school: GENERIC_SCHOOL })
        const created = await api.createClass({ subject: courseSubject, grade })
        setCreatedClass(created)
        await Promise.all([qc.invalidateQueries({ queryKey: qk.classes }), refresh()])
      } else {
        const patch = {}
        if (courseSubject !== activeClass.subject) patch.subject = courseSubject
        if (grade !== gradeSelectValue(activeClass.grade, '')) patch.grade = grade
        if (Object.keys(patch).length) {
          await api.updateClass(activeClass.id, patch)
          qc.invalidateQueries({ queryKey: qk.classes })
        }
      }
      goNext()
    } catch (err) {
      toast.apiError('Could not set that up', err)
    } finally {
      setSavingCourse(false)
    }
  }

  const finish = async () => {
    setFinishing(true)
    try {
      await api.markOnboardingSeen()
      // refresh() re-reads /api/auth/me, which is what ClassRoutes' own
      // `!user.onboarding_seen_at` check (App.jsx) reads to decide whether to
      // send this teacher back here.
      //
      // (It used to be worth noting that useAuth's `user` was plain component
      // state and invalidating qk.me wouldn't touch it. That is no longer
      // true — AuthProvider backs `user` with the qk.me query now — but
      // refresh() is still the right call: it awaits the fresh answer rather
      // than firing an invalidate and racing the redirect below.)
      await refresh()
    } catch (err) {
      /* Deliberately NOT silent, and no longer a dead end.
         This close is followed by ClassRoutes redirecting any account without
         onboarding_seen_at straight back here — so swallowing the failure and
         closing anyway produced an instant loop with no escape, the X button
         included. Offline or a 500 meant the teacher could not get into the
         app at all. Deferring for this session lets them past; the flag is
         sessionStorage, so the wizard genuinely does return next login. */
      deferOnboarding(user?.id)
      toast.apiError("Couldn't save your setup progress", err)
    } finally {
      setFinishing(false)
      onClose(activeClass)
    }
  }

  /* No `|| !cls` any more. The first two steps run before a class exists —
     see the note on createdClass at the top. The modal variant is still only
     opened over an account that has one. */
  if (!mounted) return null

  /* Labels come from lib/onboardingPlan.js, beside the step order and the
     questions, so a renamed step cannot end up with a stale rail label. */
  const railSteps = progressSteps.map((key) => ({
    key,
    label: key === 'preview' ? 'Ready' : ONBOARDING_STEPS[key]?.label || key,
    terminal: key === 'preview',
  }))

  const card = (
    <OnboardingActionContext.Provider value={registerFooter}>
      {/* Slim top bar, wordmark centred — the reference layout's chrome, and
          the same treatment /welcome's own header gives it. */}
      <div className="onboarding-topbar">
        {/* Same seal used in AppShell's own sidebar header — reused rather
            than a second mark invented for onboarding, so the first screen
            a new account sees and the app it lands in afterward carry the
            same logo. */}
        <svg viewBox="0 0 64 64" className="onboarding-topbar-logo" aria-hidden="true">
          <circle cx="32" cy="32" r="29" fill="transparent" className="land-seal-disc" />
          <circle cx="32" cy="32" r="30.5" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="1.6 3.4" className="land-seal-ticks" />
          <circle cx="32" cy="32" r="27" fill="none" stroke="currentColor" strokeWidth="2.5" className="land-seal-ring" />
          <path d="M20 33l8 8 16-18" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" className="land-seal-check" />
        </svg>
        <span className="onboarding-wordmark">FlexEd Academy</span>
        {/* A mailto:, not a button that sends anything itself — this just
            opens whatever mail client the teacher already has, with them as
            the one composing and sending. Placed even on the page variant,
            which otherwise has no top-right control at all: a school or
            class genuinely missing from FlexEd's own catalog is not
            something Back/Skip anywhere in this flow can resolve. */}
        <a
          href="mailto:joshuacolephd@gmail.com?subject=Missing%20school%20or%20class%20in%20FlexEd"
          className={`onboarding-topbar-contact${variant !== 'page' ? ' onboarding-topbar-contact-with-close' : ''}`}
          title="Having trouble finding your class or school? Email us and we'll get it added."
        >
          <Mail size={14} aria-hidden="true" />
          Contact
        </a>
        {/* The page variant gets NO close button, and that gate is
            load-bearing: App.jsx's ClassRoutes guard routes any account
            without onboarding_seen_at straight back here, so an X on first run
            promises an exit that doesn't exist. The modal IS genuinely
            dismissible — it's Settings' "take the tour again", over an app the
            teacher is already using. (This gate existed, was removed, and is
            restored here.) */}
        {variant !== 'page' ? (
          <button
            type="button"
            className="onboarding-topbar-close"
            onClick={finish}
            aria-label="Close"
            title="Skip for now"
          >
            <X size={18} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {/* The scroll lives out here now, one level above the grid, so the grid
          can be content-height and centre itself with auto margins. Auto
          margins are the safe way to do it: they take up free space when
          there is some and resolve to zero when the content is taller than
          the frame, where `justify-content: center` would push the top of a
          tall step out of reach instead. */}
      <div className="onboarding-scroll" ref={scrollRef}>
        <div className="onboarding-body">
          <OnboardingStepRail steps={railSteps} activeKey={stepKey} onGoTo={goTo} />
          <div className="onboarding-column">
          {/* data-fill hands the card's own height down to a step whose
              content is itself a scroll region (the course browser), so there
              is only ever one scrollbar. */}
            <div
              className="onboarding-content"
              data-fill={stepKey === 'course' ? 'true' : undefined}
              /* .onboarding-content is normally only min-height tall (a
                 floor, not a fill) — that's what leaves the deliberate blank
                 space below every other short step. The school step's own
                 centering has nothing to centre INTO unless this box actually
                 grows to the full column height first. */
              data-center={stepKey === 'school' ? 'true' : undefined}
            >

            <AnimatePresence mode="wait" custom={direction} initial={false}>
              {/* Keyed on stepKey, so a null key mounts nothing at all rather
                  than an empty animated wrapper that mode="wait" would then
                  have to wait for. */}
              {stepKey ? (
              <motion.div
                key={stepKey}
                custom={direction}
                variants={STEP_VARIANTS}
                initial="enter"
                animate="center"
                exit="exit"
                onAnimationComplete={settleStep}
                /* Every other step is top-aligned on purpose (see
                   .onboarding-content above) so the rail's current item stays
                   level with the question it labels. This step has no rail
                   label to line up with mid-question — just two short
                   fields floating over a watermark — so it's centred in the
                   full frame instead, equidistant from the rail's top and
                   the footer, not pinned to the question's usual top edge. */
                className={stepKey === 'school' ? 'onboarding-step-center' : undefined}
              >
            {stepKey === 'avatar' ? (
              <ProfileStep
                name={teacherName}
                setName={setTeacherName}
                saving={savingProfile}
                onNext={saveProfile}
              />
            ) : stepKey === 'school' ? (
              <SchoolStep
                school={school}
                onSchoolChange={(value) => {
                  setSchool(value)
                  setTemplateFile(null)
                  setTemplateUrl('')
                  setBlankTemplateAttested(false)
                  setTemplatePhase('upload')
                  setTemplateAnalysis(null)
                  setTemplateFindings([])
                  setTemplateAnalysisStatus(null)
                }}
                schools={schools}
                state={state}
                setState={(value) => { setState(value); setStateError(null) }}
                error={stateError}
                saving={savingSchool}
                requesting={requestingState}
                requestedState={requestedState}
                onRequestState={requestStateStandards}
                onBack={goBack}
                onNext={saveSchool}
                onSkip={goNext}
              />
            ) : stepKey === 'calendar' ? (
              <CalendarStep
                school={school}
                selectedSchool={selectedSchool}
                onBack={goBack}
                onNext={goNext}
              />
            ) : stepKey === 'format' ? (
              <FormatStep
                schoolName={selectedSchool?.name || school}
                templates={schoolTemplates}
                templatesLoading={schoolTemplatesLoading}
                selectingTemplateId={selectingTemplateId}
                onSelectTemplate={selectOnboardingTemplate}
                schoolNeedsTemplate={schoolNeedsTemplate}
                schoolFormatReady={schoolHasUsableTemplate}
                phase={templatePhase}
                analysis={templateAnalysis}
                findings={templateFindings}
                analysisStatus={templateAnalysisStatus}
                templateFile={templateFile}
                setTemplateFile={(file) => {
                  setTemplateFile(file)
                  setTemplatePhase('upload')
                  setTemplateAnalysis(null)
                  setTemplateFindings([])
                  setTemplateAnalysisStatus(null)
                }}
                templateUrl={templateUrl}
                setTemplateUrl={(value) => {
                  setTemplateUrl(value)
                  setTemplatePhase('upload')
                  setTemplateAnalysis(null)
                  setTemplateFindings([])
                }}
                blankTemplateAttested={blankTemplateAttested}
                setBlankTemplateAttested={setBlankTemplateAttested}
                saving={savingTemplate}
                onBack={goBack}
                onNext={saveTemplate}
                onSkip={() => goNext()}
                onEdit={() => setTemplatePhase('upload')}
                onConfirm={() => {
                  setTemplatePhase('confirmed')
                  toast.success('Format confirmed', 'This format will be used for new plans.')
                }}
              />
            ) : stepKey === 'course' ? (
              <CourseStep
                subject={subject}
                /* Clears the error, and deliberately does NOT advance.
                   This used to be `onChange={(v) => { setSubject(v); if (error) onNext() }}`
                   inside CourseStep, where onNext is saveCourse — which closes
                   over the CURRENT render's `subject`. So picking a course
                   while the error was showing called saveCourse() with subject
                   still '' and simply re-set the same error, which read as the
                   click doing nothing at all. Auto-advancing on a click inside
                   a browse list is also hostile on its own: a teacher scanning
                   courses got teleported forward by a misclick. Same wrapper
                   shape as setState above. */
                setSubject={(value) => { setSubject(value); setCourseError(null) }}
                grade={grade}
                setGrade={(value) => { setGrade(value); setCourseError(null) }}
                frameworks={frameworks}
                saving={savingCourse}
                error={courseError}
                onBack={goBack}
                onNext={saveCourse}
                subStep={courseSubStep}
                setSubStep={setCourseSubStep}
                discipline={courseDiscipline}
                setDiscipline={setCourseDiscipline}
              />
            ) : stepKey === 'materials' ? (
              <MaterialsStep cls={activeClass} onBack={goBack} onNext={goNext} />
            ) : stepKey === 'preview' ? (
              /* Explicitly matched, not a trailing `else`. As a fallthrough
                 this branch rendered the finish screen for ANY key it didn't
                 recognise, so a stale or renamed key told the teacher setup
                 was complete when it wasn't — the exact "lands on the wrong
                 screen" failure the key-based stepping above exists to
                 prevent. An unrecognised key now renders nothing and the
                 effect that owns stepKey corrects it.

                 The `tips` step is gone. It asked nothing, sat between the
                 work and the finish, and rendered the same five-field summary
                 this screen renders again immediately afterwards with
                 different CSS and a different field order. Its summary — the
                 better of the two, because it had per-field Edit links — is
                 now this screen's receipt, and its three static tips belong in
                 the composer's first-session empty state rather than on a
                 slide nobody reads twice. */
              <PreviewStep
                finishing={finishing}
                onFinish={finish}
                stateLabel={US_STATES.find(([value]) => value === state)?.[1]}
                schoolName={selectedSchool?.name || school}
                courseName={frameworks.find((framework) => framework.id === subject)?.label || subject}
                gradeName={gradeLabel(grade)}
                formatName={schoolHasUsableTemplate || templatePhase === 'confirmed' ? 'School format' : 'Add later'}
                editableSteps={plan}
                onEdit={(target) => { if (plan.includes(target)) goTo(target) }}
                onBack={goBack}
              />
            ) : null}
              </motion.div>
              ) : null}
            </AnimatePresence>
            </div>
          </div>
        </div>
      </div>
      <OnboardingFooter configRef={footerRef} />
    </OnboardingActionContext.Provider>
  )

  if (variant === 'page') {
    /* No scrim, no dialog role: there is no app underneath to layer over yet
       (see the comment on `variant` above) and nothing here should read as
       dismissible-by-clicking-past, since there's nothing behind it to reach.

       No ground of its own either, which is the change. This route already
       renders inside App.jsx's `.app-texture .neo-world` root with `.app-blob`
       drifting behind it — the same ground /welcome uses one screen earlier.
       It used to paint `.onboarding-mac-classic` over all of that: a
       hardcoded cool blue-grey gradient with `!important`, in an app whose
       paper is deliberately warm. Every accent-tinted glass override under
       `.onboarding-shell` existed only to compensate for that. */
    return (
      <div className="onboarding-ground">
        <div className="onboarding-card onboarding-card-fill glass-panel fa-rise-panel">
          {/* The app's own drifting aurora, on the mat rather than behind it —
              see .onboarding-card > .app-blob. */}
          <div className="app-blob" aria-hidden="true" />
          {card}
        </div>
      </div>
    )
  }

  return (
    /* No `position: absolute` override. .dialog-scrim is fixed/inset-0 for a
       reason and every other dialog in the app uses it as written — this one
       copy was mounted inside AppShell's #main pane, so absolute positioning
       scoped the scrim to that pane alone: the sidebar and the top bar stayed
       lit and, more to the point, still took clicks. A dialog marked
       aria-modal that you can click straight past isn't modal. */
    <div
      className={`dialog-scrim${closing ? ' is-closing' : ''}`}
      onMouseDown={(e) => e.target === e.currentTarget && finish()}
    >
      {/* Opaque, not glass. .onboarding-blob is gone with it: that blob's own
          comment described a bug it could only mitigate — with Reduce
          Transparency, in Low Power Mode, or on a weak GPU the blur renders
          weaker than expected and the live app showed through the panel. There
          is nothing behind a scrim worth diffusing anyway. */}
      <div
        className={`onboarding-card onboarding-card-dialog neo-panel${closing ? ' is-closing' : ''}`}
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
      >
        {card}
      </div>
    </div>
  )
}

/* The opener: the one question in setup with no wrong answer.
 *
 * It goes first deliberately. Every other step asks the teacher for something
 * that feels like work — where they teach, which standards, their district's
 * document — and the flow used to lead with the weakest of them, a list where
 * exactly one row was clickable. Picking a face costs nothing, cannot be got
 * wrong, and the result shows up immediately in the account menu, so the first
 * thing setup does is give something back.
 *
 * Renders the shared AvatarPicker, which owns the optimistic write, so there
 * is nothing to save on Continue — the pick has already landed by then. Hence
 * no `saving` state and no onNext handler of its own.
 */
function ProfileStep({ name, setName, saving, onNext }) {
  /* previewName isn't a real action, but it rides along in the same config
     ref the footer already reads every render — the footer avatar's
     initials-fallback (OnboardingFooterAvatar) needs to follow what's being
     TYPED here, the same way AvatarPicker's own preview ring already does,
     rather than only updating once this step is saved. */
  useOnboardingActions({ onNext, busy: saving, previewName: name })
  return (
    <div>
      <OnboardingQuestion
        question={ONBOARDING_STEPS.avatar.title}
        lead="Your name is printed in the header of every plan you download, so it's worth getting right — whatever your school actually calls you, not necessarily what's on your contract."
      />

      <OnboardingChoiceLabel as="label" htmlFor="onboarding-name">
        The name on your plans
      </OnboardingChoiceLabel>
      <input
        id="onboarding-name"
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        /* Pre-filled from the account, which signup required and Google
           supplies — so this is a confirmation, not a blank the teacher has to
           fill before they can get anywhere. */
        placeholder="e.g. Mr. Cole"
        autoComplete="name"
        maxLength={120}
        className="neo-inset w-full max-w-measure-narrow rounded-lg bg-paper-raised px-3.5 py-2.5 text-sm text-ink outline-none focus:ring-1 focus:ring-accent"
      />

      <OnboardingChoiceLabel>And an icon, if you like</OnboardingChoiceLabel>
      <AvatarPicker size="xl" previewName={name} />

      {/* No skip. There is nothing to skip past — the name is pre-filled and
          the icon already defaults to initials, so Continue IS the "leave it
          as it is" path. A Skip button beside a filled-in field only invites
          the question of what it would even do. */}
    </div>
  )
}

/* Each state's fitted viewBox, measured once and cached forever — a state's
 * outline never changes shape, so there's nothing to re-measure on a second
 * selection.
 *
 * This used to measure with getBBox() on the VISIBLE path itself, reset to
 * the full US map's viewBox first (a path can only be measured once it's
 * actually laid out) and then refit a moment later in a second effect. That
 * meant two separate commits — one with the wrong (full-map) viewBox, one
 * with the right one — and the browser is free to paint in between them.
 * Most of the time React's layout effects run and re-render before the next
 * paint and nobody sees it, but there's no guarantee of that, which is
 * exactly why it read as an intermittent glitch: a single state's outline,
 * tiny, sitting whever it actually falls on the full US map. Measuring
 * against a detached, off-screen path — never the one on screen — means the
 * visible svg gets its correct viewBox on its very first render. There is no
 * wrong frame for the browser to paint. */
const stateViewBoxCache = new Map()
let measurementSvg = null

function measureStateViewBox(location) {
  if (stateViewBoxCache.has(location.id)) return stateViewBoxCache.get(location.id)

  let viewBox = usaMap.viewBox
  if (typeof document !== 'undefined') {
    if (!measurementSvg) {
      measurementSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      measurementSvg.setAttribute('aria-hidden', 'true')
      Object.assign(measurementSvg.style, { position: 'fixed', top: '-9999px', left: '-9999px' })
      document.body.appendChild(measurementSvg)
    }
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', location.path)
    measurementSvg.appendChild(path)
    const bounds = path.getBBox()
    measurementSvg.removeChild(path)
    if (bounds.width && bounds.height) {
      const padding = Math.max(bounds.width, bounds.height) * 0.16
      viewBox = `${bounds.x - padding} ${bounds.y - padding} ${bounds.width + padding * 2} ${bounds.height + padding * 2}`
    }
  }
  stateViewBoxCache.set(location.id, viewBox)
  return viewBox
}

/* Decoration, not confirmation — the select's own value already says which
 * state got chosen, so this doesn't need a header or a chip row repeating
 * it. It sits behind the fields as a large, pale outline rather than beside
 * them in its own boxed card, which is what made it read as a second,
 * disconnected widget instead of part of the question. */
function StateWatermark({ stateCode }) {
  const selected = usaMap.locations.find((location) => location.id === stateCode.toLowerCase())
  const viewBox = useMemo(() => (selected ? measureStateViewBox(selected) : null), [selected])

  if (!selected) return null

  return (
    // A plain wrapper handles centring the shape in the frame; motion.svg
    // below writes its own inline `transform` for the scale/opacity entrance,
    // which would silently clobber a CSS transform used for positioning if
    // this div's job were done on the svg itself instead.
    <div className="onboarding-where-watermark" aria-hidden="true">
      <AnimatePresence initial={false}>
        <motion.svg
          key={selected.id}
          initial={{ opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
          viewBox={viewBox}
          className="onboarding-where-watermark-svg"
        >
          <path d={selected.path} fill="none" strokeWidth="2.5" strokeLinejoin="round" />
        </motion.svg>
      </AnimatePresence>
    </div>
  )
}

/* "Where do you teach?" — answered with a state, and then a school.
 *
 * The state used to be a step of its own, which spent a whole screen on a
 * fifty-row listbox where exactly one row was clickable. Here it is the thing
 * that narrows the next control: pick a state, the school list appears filtered
 * to it. That narrowing is real as of migration 76, which added schools.state
 * — before that every row was an Alabama school by construction but never as
 * recorded fact, so a filter would have looked like one and returned
 * everything.
 *
 * Asking it on this step rather than page one also keeps the save simple:
 * classes.state is a column on the class, and the course step has already
 * created one by now, so it is a plain PATCH rather than something threaded
 * through api.createClass.
 */
function SchoolStep({
  school,
  onSchoolChange,
  schools,
  state,
  setState,
  error,
  saving,
  requesting,
  requestedState,
  onRequestState,
  onBack,
  onNext,
  onSkip,
}) {
  const ready = Boolean(state) && isStandardsReady(state)
  useOnboardingActions({
    onNext,
    busy: saving,
    onBack,
    onSkip: ready ? onSkip : undefined,
    skipLabel: "Skip the school — I'll plan by week number",
  })
  /* Rows with no recorded state are kept rather than filtered out: NULL means
     "not recorded" (create_school is reachable from the admin page and from a
     calendar submission with no state to hand), and dropping them would hide a
     real school from the teacher who just asked for it. */
  const schoolsInState = ready ? schools.filter((s) => !s.state || s.state === state) : []
  const stateName = US_STATES.find(([value]) => value === state)?.[1] || state

  return (
    // The question sits directly in the shell, unshifted, at the same inset
    // from the rail every other step's question uses. Watermark + fields are
    // nested one level deeper, in their own box — that's the one that grows
    // to fill the remaining height (for a watermark that fills the page) AND
    // carries the horizontal re-centring shift, so the shift never touches
    // the question above it.
    <div className="onboarding-where-shell">
      <OnboardingQuestion question={ONBOARDING_STEPS.school.title} />

      <div className="onboarding-where-body">
        {state ? <StateWatermark stateCode={state} /> : null}
        <div className="onboarding-where-layout">
        <div className="onboarding-where-fields">
          <OnboardingChoiceLabel as="label" htmlFor="onboarding-state">
            State
          </OnboardingChoiceLabel>
          <select
            id="onboarding-state"
            value={state}
            onChange={(e) => setState(e.target.value)}
            className="neo-select neo-inset min-h-touch w-full rounded-lg bg-paper-raised py-2.5 pl-3.5 pr-9 text-sm text-ink outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="">Choose your state</option>
            {US_STATES.map(([value, label]) => (
              /* Selectable, not disabled. A teacher outside Alabama should be
                 able to say so and ask for theirs — see onRequestState — rather
                 than find forty-nine greyed rows and no way to register that
                 they turned up. */
              <option key={value} value={value}>
                {isStandardsReady(value) ? label : `${label} — not ready yet`}
              </option>
            ))}
          </select>

          {/* The school list appears only once the state is one we have
              schools for, so the two controls read as a sequence rather than
              two dropdowns to fill in either order. */}
          {/* No mode="wait" here, deliberately. The outer step swap needs it —
              it is what keeps id="onboarding-title" unique across a
              transition — but these two children are mutually exclusive and
              can overlap for a frame without harm. With mode="wait" the
              school select could not mount until the request panel had
              finished exiting, so a stalled exit animation left a teacher who
              switched from an un-ingested state back to Alabama with no way to
              reach the school list at all. */}
          <AnimatePresence initial={false}>
            {ready ? (
              <motion.div
                key="school"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              >
                <OnboardingChoiceLabel as="label" htmlFor="onboarding-school" className="onboarding-where-school-label">
                  School
                </OnboardingChoiceLabel>
                <SchoolSelect
                  ariaLabel="School"
                  id="onboarding-school"
                  schools={schoolsInState}
                  value={school}
                  onChange={onSchoolChange}
                  emptyOption={{ value: '', label: `Choose a school in ${stateName}` }}
                  inputClassName="neo-inset min-h-touch w-full rounded-lg bg-paper-raised py-2.5 pl-3.5 pr-9 text-sm text-ink outline-none focus:ring-1 focus:ring-accent"
                />
              </motion.div>
            ) : state ? (
              /* An un-ingested state. It says what does and doesn't work
                 rather than just refusing, because most of the product does
                 work — it is the standards library that is Alabama-only. */
              <motion.div
                key="request"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                className="onboarding-state-request"
              >
                <p>
                  <strong>{stateName} standards aren&rsquo;t loaded yet.</strong> Every standard
                  FlexEd quotes is ingested document by document, so plans cite real codes instead
                  of a paraphrase — and a half-ingested catalog would let it cite one that
                  doesn&rsquo;t exist.
                </p>
                <p>
                  Planning, your school&rsquo;s calendar and your district&rsquo;s format all work
                  anywhere. It&rsquo;s the standards library that&rsquo;s Alabama&rsquo;s for now.
                </p>
                {requestedState === state ? (
                  <p className="onboarding-state-requested">
                    <CheckCircle2 size={15} aria-hidden="true" />
                    Asked for — we&rsquo;ll email you when {stateName} is in.
                  </p>
                ) : (
                  <button
                    type="button"
                    className="btn fa-press"
                    onClick={() => onRequestState(state)}
                    disabled={requesting}
                  >
                    {requesting ? <Loader2 size={14} className="mr-1.5 animate-spin" aria-hidden="true" /> : null}
                    {requesting ? 'Sending…' : `Ask for ${stateName}`}
                  </button>
                )}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
        </div>
      </div>

      {error ? (
        <p key={error} className="fa-flash mt-3 text-xs font-medium text-mark" role="alert">
          {error}
        </p>
      ) : null}

    </div>
  )
}

/* The school year, on its own screen.
 *
 * This used to render underneath the school picker, sharing its Continue
 * button — two decisions on one screen, with the more consequential one
 * visually subordinate. A wrong calendar silently mis-dates every plan for a
 * year, so it gets asked rather than shown in passing.
 *
 * It is also the only place in the product that can tell a teacher the truth
 * about the generic school. backend/schoolcal.py's NO_CALENDAR_SCHOOL_ID
 * returns week NUMBERS with no dates attached to any of them, and until now
 * that fact lived only in a code comment — a teacher could finish setup on the
 * generic school and never be told their plans would have no dates on them.
 */
function CalendarStep({ school, selectedSchool, onBack, onNext }) {
  useOnboardingActions({
    onNext,
    onBack,
    onSkip: onNext,
    skipLabel: ONBOARDING_STEPS.calendar.skipLabel,
  })
  const pending = selectedSchool?.has_pending_calendar
  const confirmed = selectedSchool?.has_calendar
  const toast = useToast()

  /* Same submission the "Replace calendar" button uses on Settings' School
   * & Templates panel (SettingsPage.jsx) — a new file goes through the same
   * admin-review path as any other calendar submission, it doesn't silently
   * overwrite the confirmed one. Kept local to this step rather than lifted
   * to the wizard: nothing else needs it, and it's the same shape as
   * Settings' own copy already is. */
  const [calendarToolsOpen, setCalendarToolsOpen] = useState(false)
  const [uploadingCalendar, setUploadingCalendar] = useState(false)
  const [calendarUrl, setCalendarUrl] = useState('')

  const submitCalendar = async ({ file, url }) => {
    if ((!file && !url) || !selectedSchool) return
    setUploadingCalendar(true)
    try {
      await api.uploadSchoolCalendar(selectedSchool.name, { file, sourceUrl: file ? undefined : url })
      toast.success('Calendar submitted', 'An administrator will review it before it becomes the school calendar.')
      setCalendarToolsOpen(false)
    } catch (err) {
      toast.apiError('Could not upload the calendar', err)
    } finally {
      setUploadingCalendar(false)
      setCalendarUrl('')
    }
  }

  return (
    <div>
      <OnboardingQuestion
        question={ONBOARDING_STEPS.calendar.title}
        lead={
          pending
            ? 'A colleague at your school already set this up. Worth a look before we date your plans with it.'
            : confirmed
              ? undefined
              : "We don't have a calendar for your school yet, so plans will be labelled by week number — Week 1, Week 2 — with no dates attached."
        }
      />
      {pending ? (
        <PendingCalendarReview schoolId={school} />
      ) : confirmed ? (
        <>
          <ConfirmedCalendarReview schoolId={school} />
          <button
            type="button"
            className="onboarding-quiet mt-3"
            onClick={() => setCalendarToolsOpen((open) => !open)}
          >
            {calendarToolsOpen ? 'Hide upload' : "Doesn't look right? Upload a different calendar"}
          </button>
          {calendarToolsOpen ? (
            <div className="mt-3 rounded-xl border border-edge bg-paper-sunken p-3">
              <p className="text-xs text-ink-soft">
                Starting a new school year, or need to fix a date? Your plans can use what you upload right
                away — it only becomes the shared calendar for everyone else at your school once another
                teacher confirms it.
              </p>
              <div className="onboarding-ingest-path onboarding-ingest-path-static" aria-label="What happens after you upload">
                <div className="onboarding-ingest-step is-active">
                  <span>1</span><strong>You upload</strong>
                </div>
                <div className="onboarding-ingest-line" aria-hidden="true" />
                <div className="onboarding-ingest-step">
                  <span>2</span><strong>A teacher confirms it</strong>
                </div>
                <div className="onboarding-ingest-line" aria-hidden="true" />
                <div className="onboarding-ingest-step">
                  <span>3</span><strong>Shared school-wide</strong>
                </div>
              </div>
              <UploadDropzone
                uploading={uploadingCalendar}
                label="Upload calendar"
                onFile={(file) => submitCalendar({ file })}
                url={calendarUrl}
                onUrlChange={setCalendarUrl}
                onUrlSubmit={() => submitCalendar({ url: calendarUrl.trim() })}
              />
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

function FormatStep({
  schoolName,
  templates,
  templatesLoading,
  selectingTemplateId,
  onSelectTemplate,
  schoolNeedsTemplate,
  schoolFormatReady,
  phase,
  analysis,
  findings,
  analysisStatus,
  templateFile,
  setTemplateFile,
  templateUrl,
  setTemplateUrl,
  blankTemplateAttested,
  setBlankTemplateAttested,
  saving,
  onBack,
  onNext,
  onSkip,
  onEdit,
  onConfirm,
}) {
  const sections = analysis?.sections || []
  const errors = findings.filter((finding) => finding.severity === 'error')
  const warnings = findings.filter((finding) => finding.severity === 'warning')
  const hasInput = Boolean(templateFile || templateUrl.trim())
  const reviewable = sections.length > 0 && analysisStatus !== 'failed'
  const title = phase === 'processing'
    ? 'Analyzing your format'
    : phase === 'review'
      ? 'Review the detected format'
      : phase === 'confirmed'
        ? 'Your format is ready'
        : 'Add your lesson-plan format'
  const personalDefault = templates.find((template) => template.is_personal_default)
  const schoolDefault = templates.find((template) => template.is_school_default)
  const defaultTemplate = personalDefault || schoolDefault
  const body = phase === 'processing'
    ? 'FlexEd is reading the structure of your template now.'
    : phase === 'review'
      ? 'Check the sections FlexEd found before making this the format for new plans.'
      : phase === 'confirmed'
        ? 'This format is now connected to your planning workflow.'
        : defaultTemplate || schoolFormatReady
          ? 'Your school format is ready and will be used for new plans. You can add a personal format if you want.'
          : schoolName
            ? `Give FlexEd a blank example from ${schoolName}, or choose a format already on file.`
          : 'Give FlexEd a blank example of the format you want your plans to follow.'

  useOnboardingActions(
    phase === 'upload'
      ? { onNext, nextLabel: hasInput ? 'Analyze format' : 'Continue', busy: saving, onBack, onSkip, skipLabel: 'Skip — use a neutral layout for now' }
      : phase === 'processing'
        ? { status: 'Working on it…' }
        : phase === 'review'
          ? { onNext: onConfirm, nextLabel: 'Use this format', disabled: !reviewable, onBack: onEdit, backLabel: 'Choose another file' }
          : { onNext, onBack },
  )

  return (
    <div>
      <OnboardingQuestion
        question={title}
        lead={body}
      />
      <div className="onboarding-template-panel rounded-2xl p-5 sm:p-7">
        {phase === 'upload' ? (
          <>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="onboarding-template-kicker">Template setup</p>
                <h3 className="mt-1 text-xl font-semibold tracking-tight text-ink">
                  {defaultTemplate || schoolFormatReady ? 'Use the school format or add your own' : schoolNeedsTemplate ? 'Teach FlexEd your format' : 'Choose how plans should look'}
                </h3>
                <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ink-muted">
                  Upload a blank lesson-plan example. FlexEd will read the sections, order, and layout before it formats future plans.
                </p>
              </div>
              <span className={`onboarding-template-status ${schoolNeedsTemplate ? 'is-needed' : 'is-ready'}`}>
                {schoolNeedsTemplate ? 'Needed' : 'Optional'}
              </span>
            </div>

            <TemplateIngestPath phase={phase} />

            {templates.length || templatesLoading ? (
              <div className="onboarding-template-choice mt-6">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-faint">{defaultTemplate ? 'Default for new plans' : 'Formats already available'}</p>
                <OnboardingTemplateChoices
                  templates={templates}
                  loading={templatesLoading}
                  selectingTemplateId={selectingTemplateId}
                  onSelect={onSelectTemplate}
                />
              </div>
            ) : null}

            <div className="onboarding-template-input-grid mt-6">
              <div className="onboarding-template-upload-wrap">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-ink">{templates.length ? 'Add a personal format' : 'Upload a blank format'}</p>
                    <p className="mt-0.5 text-xs text-ink-muted">PDF or Word document, or a shareable Google Doc.</p>
                  </div>
                  <div className="flex flex-wrap gap-1.5" aria-label="What FlexEd reads">
                    {['Sections', 'Order', 'Layout'].map((item) => (
                      <span key={item} className="onboarding-template-chip">{item}</span>
                    ))}
                  </div>
                </div>
                <UploadDropzone
                  label="Choose file"
                  selectedFileName={templateFile?.name}
                  onFile={(file) => {
                    setTemplateFile(file)
                    setTemplateUrl('')
                  }}
                  url={templateUrl}
                  onUrlChange={(v) => {
                    setTemplateUrl(v)
                    if (v) setTemplateFile(null)
                  }}
                  templateUpload
                  compactGuidance
                  className="onboarding-template-upload"
                  blankTemplateAttested={blankTemplateAttested}
                  onBlankTemplateAttestedChange={setBlankTemplateAttested}
                />
              </div>
              <TemplatePreview file={templateFile} url={templateUrl} />
            </div>
          </>
        ) : phase === 'processing' ? (
          <>
            <TemplateIngestPath phase={phase} />
            <div className="onboarding-template-processing">
              <Loader2 size={24} className="animate-spin text-accent-text" aria-hidden="true" />
              <div>
                <p className="text-sm font-semibold text-ink">Analyzing format…</p>
                <p className="mt-1 text-sm leading-relaxed text-ink-muted">Looking for headings, tables, labels, and the order your plans should follow.</p>
              </div>
            </div>
            <TemplatePreview file={templateFile} url={templateUrl} />
          </>
        ) : phase === 'review' ? (
          <>
            <TemplateIngestPath phase={phase} />
            <div className="onboarding-analysis-grid mt-6">
              <TemplatePreview file={templateFile} url={templateUrl} />
              <div className="onboarding-analysis-card">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="onboarding-template-kicker">Detected sections</p>
                    <p className="mt-1 text-sm font-semibold text-ink">Does this look right?</p>
                  </div>
                  <span className={`onboarding-template-status ${reviewable ? 'is-ready' : 'is-needed'}`}>
                    {reviewable ? 'Ready to review' : 'Needs another file'}
                  </span>
                </div>
                {sections.length ? (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {sections.map((section, index) => (
                      <span key={`${section.name || section.title || 'section'}-${index}`} className="onboarding-detected-field">
                        {section.name || section.title || `Section ${index + 1}`}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="mt-4 rounded-lg bg-mark/10 p-3 text-sm leading-relaxed text-mark">FlexEd couldn’t verify any sections in this file. Try a blank PDF or Word template with visible headings or tables.</p>
                )}
                {errors.length || warnings.length ? (
                  <div className="onboarding-analysis-notes mt-4">
                    {errors.concat(warnings).slice(0, 3).map((finding, index) => (
                      <p key={`${finding.check_name || 'note'}-${index}`} className={finding.severity === 'error' ? 'is-error' : 'is-warning'}>{finding.message}</p>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </>
        ) : (
          <>
            <TemplateIngestPath phase={phase} />
            <div className="onboarding-template-confirmed">
              <div className="onboarding-template-confirmed-icon"><CheckCircle2 size={23} aria-hidden="true" /></div>
              <div>
                <p className="text-base font-semibold text-ink">This format will be used for new plans.</p>
                <p className="mt-1 text-sm leading-relaxed text-ink-muted">FlexEd will keep the detected sections, order, and layout in view as it builds your plans.</p>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function TemplateIngestPath({ phase }) {
  const steps = [
    ['upload', 'Upload'],
    ['processing', 'Analyze'],
    ['confirmed', 'Use in plans'],
  ]
  const activeIndex = phase === 'review' ? 1 : phase === 'confirmed' ? 2 : phase === 'processing' ? 1 : 0
  return (
    <div className="onboarding-ingest-path" aria-label="Template setup steps">
      {steps.map(([key, label], index) => (
        <Fragment key={key}>
          <div className={`onboarding-ingest-step ${index <= activeIndex ? 'is-active' : ''}`}>
            <span>{index + 1}</span><strong>{label}</strong>
          </div>
          {index < steps.length - 1 ? <div className="onboarding-ingest-line" aria-hidden="true" /> : null}
        </Fragment>
      ))}
    </div>
  )
}

function TemplatePreview({ file, url }) {
  const [previewUrl, setPreviewUrl] = useState('')

  useEffect(() => {
    if (!file || file.type !== 'application/pdf') {
      setPreviewUrl('')
      return undefined
    }
    const objectUrl = URL.createObjectURL(file)
    setPreviewUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [file])

  return (
    <div className="onboarding-template-preview">
      <p className="onboarding-template-kicker">Template preview</p>
      {previewUrl ? (
        <iframe title={`${file.name} preview`} src={previewUrl} className="onboarding-template-preview-frame" />
      ) : file ? (
        <div className="onboarding-template-preview-file">
          <FileText size={28} className="text-accent-text" aria-hidden="true" />
          <p className="mt-3 truncate text-sm font-semibold text-ink">{file.name}</p>
          <p className="mt-1 text-xs text-ink-muted">Word document selected</p>
        </div>
      ) : url?.trim() ? (
        <div className="onboarding-template-preview-file">
          <FileText size={28} className="text-accent-text" aria-hidden="true" />
          <p className="mt-3 text-sm font-semibold text-ink">Google Doc selected</p>
          <p className="mt-1 truncate text-xs text-ink-muted">{url}</p>
        </div>
      ) : (
        <div className="onboarding-template-preview-empty">
          <FileText size={24} aria-hidden="true" />
          <span>Your preview will appear here after you choose a file.</span>
        </div>
      )}
    </div>
  )
}

function OnboardingTemplateChoices({ templates, loading, selectingTemplateId, onSelect }) {
  if (loading) {
    return (
      <div className="mt-3 flex items-center gap-2 text-xs text-ink-muted" role="status">
        <Loader2 size={13} className="animate-spin" aria-hidden="true" />
        Loading saved formats…
      </div>
    )
  }

  return (
    <div className="mt-3 space-y-2">
      <p className="text-xs font-medium text-ink">Choose your starting format</p>
      {templates.map((template) => {
        const ready = ['analyzed', 'analyzed_with_warnings'].includes(template.analysis_status)
        const hasPersonalDefault = templates.some((candidate) => candidate.is_personal_default)
        const selected = Boolean(template.is_personal_default) || (!hasPersonalDefault && Boolean(template.is_school_default))
        const label = template.is_personal_default
          ? 'Your default'
            : template.is_school_default
              ? 'Default for this school'
              : template.template_scope === 'school_candidate'
                ? 'School candidate'
                : 'Personal template'
        const date = template.approved_at || template.created_at
        return (
          <div key={template.id} className="flex items-center justify-between gap-3 rounded-md border border-edge bg-paper-raised px-3 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-ink">{template.filename}</p>
              <p className="mt-0.5 text-2xs text-ink-muted">
                {label} · {template.approved_at ? 'Approved' : 'Added'} · {date ? new Date(date).toLocaleDateString() : 'date pending'}
              </p>
            </div>
            {selected ? (
              <span className="inline-flex shrink-0 items-center gap-1 text-right text-2xs font-medium text-emerald-700">
                <CheckCircle2 size={13} aria-hidden="true" />
                {template.is_personal_default ? 'Your format · selected' : 'School format · selected'}
              </span>
            ) : (
              <button
                type="button"
                className="btn shrink-0"
                disabled={!ready || selectingTemplateId === template.id}
                onClick={() => onSelect(template)}
              >
                {selectingTemplateId === template.id ? <Loader2 size={12} className="mr-1 animate-spin" aria-hidden="true" /> : null}
                {ready ? (template.is_school_default ? 'Use school format' : 'Use for my plans') : 'Preparing…'}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
const COURSE_GROUP_ICONS = {
  [GROUP_ENGLISH]: BookOpen,
  [GROUP_MATH]: Calculator,
  [GROUP_SCIENCE]: FlaskConical,
  [GROUP_HISTORY]: Landmark,
  [GROUP_WORLD_LANG]: Languages,
  [GROUP_ARTS]: Palette,
  [GROUP_PE_HEALTH]: HeartPulse,
  [GROUP_CS]: Code2,
  [GROUP_SPECIAL_ED]: Users,
  [GROUP_OTHER]: Grid2x2,
}

/* One big-row choice, shared by all three CourseStep screens (grade,
 * discipline, course) — same shape as a topic-picker's radio card: an
 * optional icon, a label (+ small sublabel), an optional count, and a
 * checkmark that only appears once chosen. Kept as one component rather than
 * three near-identical ones so the three screens read as ONE pattern used
 * three times, not three separately-designed lists that happen to look
 * similar.
 */
function OnboardingBigChoice({ icon: Icon, label, sublabel, count, selected, onClick }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className={`onboarding-bigchoice${selected ? ' onboarding-bigchoice-selected' : ''}`}
    >
      {Icon ? (
        <span className="onboarding-bigchoice-icon" aria-hidden="true">
          <Icon size={18} />
        </span>
      ) : null}
      <span className="onboarding-bigchoice-text">
        <span className="onboarding-bigchoice-label">{label}</span>
        {sublabel ? <span className="onboarding-bigchoice-sublabel">{sublabel}</span> : null}
      </span>
      {typeof count === 'number' ? <span className="onboarding-bigchoice-count">{count}</span> : null}
      <span className="onboarding-bigchoice-radio" aria-hidden="true">
        {selected ? <Check size={13} /> : null}
      </span>
    </button>
  )
}

const COURSE_SUB_STEPS = ['grade', 'discipline', 'course']

/* One purple dash per screen in the course step's own three-screen flow,
 * filled up to and including the current one — a sub-progress bar for a
 * sub-flow, distinct from the wizard's own step rail (Profile/School/
 * Course/…) which only ever advances once per whole step, not once per
 * screen inside this one. */
function OnboardingSubProgress({ current }) {
  // 'search' is a bypass around discipline+course, not a fourth screen with
  // its own dash — it lands on the same final "pick one and you're done"
  // decision course does, so it fills the rail the same way that does.
  const index = current === 'search' ? COURSE_SUB_STEPS.length - 1 : COURSE_SUB_STEPS.indexOf(current)
  return (
    <div className="onboarding-subprogress" role="presentation">
      {COURSE_SUB_STEPS.map((key, i) => (
        <span key={key} className={`onboarding-subprogress-dash${i <= index ? ' onboarding-subprogress-dash-filled' : ''}`} />
      ))}
    </div>
  )
}

/* First of the course step's three screens: which grade. Filters the
 * catalog the same way the old grade <select> did — every framework already
 * carries its own grades[] (lib/frameworks.js), so narrowing is a filter,
 * not a new capability. '' is "all grades". */
function GradeSubStep({ grade, setGrade, onBack, onNext }) {
  useOnboardingActions({ onNext, onBack })
  return (
    <div className="onboarding-class-step">
      <OnboardingQuestion question="What grade do you teach?" lead="Narrows the course list to what's actually taught at that grade." />
      <OnboardingSubProgress current="grade" />
      {/* Picking a grade advances straight to the next screen — unlike
          discipline and course, there's nothing further to weigh once a
          grade is picked (no icon, no course count to compare), so waiting
          for a second Continue click is pure friction. */}
      <div className="onboarding-bigchoice-list" role="listbox" aria-label="Grade">
        <OnboardingBigChoice
          label="All grades"
          selected={grade === ''}
          onClick={() => {
            setGrade('')
            onNext()
          }}
        />
        {GRADES.map((g) => (
          <OnboardingBigChoice
            key={g.value}
            label={g.label}
            selected={grade === g.value}
            onClick={() => {
              setGrade(g.value)
              onNext()
            }}
          />
        ))}
      </div>
    </div>
  )
}

/* Second screen: which discipline. `groups` is the grade-filtered catalog,
 * already bucketed by lib/frameworks.js's groupFrameworks — the same
 * grouping the old discipline rail used, just as full rows instead of a
 * narrow sidebar. */
function DisciplineSubStep({ groups, discipline, setDiscipline, onBack, onNext, onSearch }) {
  useOnboardingActions({ onNext, onBack, disabled: !discipline })
  return (
    <div className="onboarding-class-step">
      <OnboardingQuestion question="Which subject area?" lead="Narrows the list to just the courses in that discipline." />
      <OnboardingSubProgress current="discipline" />
      {/* Escape hatch for a teacher who already knows the course by name —
          the three-screen flow is a fine default, but it costs three clicks
          to reach something a search box used to answer in one. Placed
          here, not on the grade screen: this is the point where browsing
          the actual catalog starts. */}
      <button type="button" className="onboarding-course-search-link" onClick={onSearch}>
        <Search size={14} aria-hidden="true" />
        Search for a course instead
      </button>
      {groups.length ? (
        <div className="onboarding-bigchoice-list" role="listbox" aria-label="Subject area">
          {groups.map((g) => (
            <OnboardingBigChoice
              key={g.name}
              icon={COURSE_GROUP_ICONS[g.name]}
              label={g.name}
              count={g.items.length}
              selected={discipline === g.name}
              onClick={() => {
                setDiscipline(g.name)
                onNext()
              }}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-ink-muted">No courses at this grade yet — go back and try All grades.</p>
      )}
    </div>
  )
}

/* Third and final screen: the actual course. This is what saveCourse (the
 * real onNext) records, so it carries `saving`/`error` the way the step
 * always has. */
function CourseSubStep({ items, subject, setSubject, saving, error, onBack, onNext }) {
  useOnboardingActions({ onNext, onBack, busy: saving, disabled: !subject })
  return (
    <div className="onboarding-class-step">
      <OnboardingQuestion
        question="Which course, exactly?"
        lead="This picks the standards your plans are grounded in, so it's the one answer worth getting exactly right."
      />
      <OnboardingSubProgress current="course" />
      {items.length ? (
        <div className="onboarding-bigchoice-list" role="listbox" aria-label="Course">
          {items.map((fw) => (
            <OnboardingBigChoice
              key={fw.id}
              label={fw.label}
              sublabel={gradeRangeLabel(fw)}
              selected={subject === fw.id}
              onClick={() => {
                setSubject(fw.id)
                /* onNext here is the real saveCourse, which normally reads
                   `subject` from its own closure — still the PREVIOUS
                   render's value this synchronously after setSubject, since
                   state updates never apply mid-handler. The override arg
                   is what lets this click both pick AND save the course
                   just picked, rather than the one before it. */
                onNext(fw.id)
              }}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-ink-muted">No courses in this subject yet.</p>
      )}
      {/* .fa-flash, not a framer shake: it is the app's one informational
          animation, and it is already gated by the blanket
          prefers-reduced-motion block. Keyed on the message so a second
          failure replays it. */}
      {error ? (
        <p key={error} className="fa-flash mt-1.5 px-1 text-xs font-medium text-mark" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/* A bypass around discipline+course for a teacher who already knows the
 * course by name — reached from the "Search for a course instead" link on
 * the discipline screen. Still respects the grade filter (frameworks passed
 * in are already grade-filtered, not the full catalog), so a search here
 * can't surface a course that doesn't fit the grade already chosen. */
function SearchSubStep({ frameworks, subject, setSubject, saving, error, onBack, onNext }) {
  const [query, setQuery] = useState('')
  useOnboardingActions({ onNext, onBack, busy: saving, disabled: !subject })
  const results = useMemo(() => frameworks.filter((f) => matchesFramework(f, query)), [frameworks, query])
  return (
    <div className="onboarding-class-step">
      <OnboardingQuestion question="Search for your course" lead="Type a course name, or a grade word like “elementary” or “Pre-AP”." />
      <OnboardingSubProgress current="search" />
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="e.g. AP Calculus, world history…"
        autoFocus
        autoComplete="off"
        className="onboarding-course-search-input neo-inset"
      />
      {results.length ? (
        <div className="onboarding-bigchoice-list onboarding-course-search-results" role="listbox" aria-label="Course results">
          {results.map((fw) => (
            <OnboardingBigChoice
              key={fw.id}
              label={fw.label}
              sublabel={gradeRangeLabel(fw)}
              selected={subject === fw.id}
              onClick={() => {
                setSubject(fw.id)
                // Same override-arg reasoning as CourseSubStep's click
                // handler — onNext is the real saveCourse, and `subject`
                // inside its closure is still last render's value here.
                onNext(fw.id)
              }}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-ink-muted">
          {query.trim() ? `No course matches “${query}”.` : 'Start typing to search the catalog.'}
        </p>
      )}
      {error ? (
        <p key={error} className="fa-flash mt-1.5 px-1 text-xs font-medium text-mark" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/* The dispatcher: picks which of the three screens above is showing.
 *
 * This used to be one screen — a search box over a three-column browser
 * (grade rail, discipline rail, course list) all visible at once. Rebuilt as
 * three sequential screens (grade, then discipline, then course), each one
 * big single-choice list: fewer decisions on screen at a time, at the cost
 * of the search box as a fast path for a teacher who already knows their
 * course by name. subStep/discipline are lifted into the wizard itself (see
 * courseSubStep/courseDiscipline there) rather than kept as local state
 * here — the footer that shows Back/Continue lives outside this component
 * and only re-renders when the WIZARD re-renders, not when this component's
 * own local state changes. */
function CourseStep({
  subject,
  setSubject,
  grade,
  setGrade,
  frameworks,
  saving,
  error,
  onBack,
  onNext,
  subStep,
  setSubStep,
  discipline,
  setDiscipline,
}) {
  const gradeFilteredFrameworks = useMemo(
    () => (!grade ? frameworks : frameworks.filter((f) => (f.grades || []).includes(Number(grade)))),
    [frameworks, grade],
  )
  const groups = useMemo(() => groupFrameworks(gradeFilteredFrameworks), [gradeFilteredFrameworks])

  /* A course chosen under one grade can fall outside the list the moment the
     grade changes (AP Calculus picked at 11th, then grade dropped to 3rd) —
     left alone, Continue would save a course that is no longer even visible.
     Same reasoning for discipline once grade narrows its group away. */
  useEffect(() => {
    if (subject && !gradeFilteredFrameworks.some((f) => f.id === subject)) setSubject('')
  }, [gradeFilteredFrameworks, subject, setSubject])
  useEffect(() => {
    if (discipline && !groups.some((g) => g.name === discipline)) setDiscipline(null)
  }, [groups, discipline, setDiscipline])

  /* Resuming on a class that already has a subject (Back from Calendar, or
     reopening mid-flow): the wizard reset discipline to null because it has
     no way to know the grouping before the framework catalog has loaded.
     Once it has, derive it from the subject that's already chosen, so Back
     from the course screen lands on the discipline it actually belongs to
     rather than an empty screen. */
  useEffect(() => {
    if (discipline || !subject) return
    const match = groups.find((g) => g.items.some((f) => f.id === subject))
    if (match) setDiscipline(match.name)
  }, [subject, discipline, groups, setDiscipline])

  if (subStep === 'search') {
    return (
      <SearchSubStep
        frameworks={gradeFilteredFrameworks}
        subject={subject}
        setSubject={setSubject}
        saving={saving}
        error={error}
        onBack={() => setSubStep('discipline')}
        onNext={onNext}
      />
    )
  }

  if (subStep === 'discipline') {
    return (
      <DisciplineSubStep
        groups={groups}
        discipline={discipline}
        setDiscipline={setDiscipline}
        onBack={() => setSubStep('grade')}
        onNext={() => setSubStep('course')}
        onSearch={() => setSubStep('search')}
      />
    )
  }

  if (subStep === 'course') {
    const items = groups.find((g) => g.name === discipline)?.items || []
    return (
      <CourseSubStep
        items={items}
        subject={subject}
        setSubject={setSubject}
        saving={saving}
        error={error}
        onBack={() => setSubStep('discipline')}
        onNext={onNext}
      />
    )
  }

  return <GradeSubStep grade={grade} setGrade={setGrade} onBack={onBack} onNext={() => setSubStep('discipline')} />
}

function MaterialsStep({ cls, onBack, onNext }) {
  useOnboardingActions({ onNext, onBack, onSkip: onNext, skipLabel: 'Skip — I’ll add these later' })
  return (
    <div>
      <OnboardingQuestion
        question="Add your teaching materials"
        lead="Optional. Add the planning source FlexEd should use to organize new plans. You can add supporting materials later."
      />
      <Suspense fallback={<p className="text-xs text-ink-muted">Loading documents…</p>}>
        <ClassDocuments cls={cls} variant="onboarding" />
      </Suspense>
    </div>
  )
}

/* The closing screen, and now the only place the setup summary is rendered.
 *
 * There used to be two: the `tips` step drew a five-field summary with
 * per-field Edit links, and this screen drew the same five values again
 * immediately afterwards as a <dl>, in a different order, with different CSS.
 * Two authors, no shared source. The version with the Edit links won, because
 * a summary you cannot act on is decoration.
 *
 * Field order follows the order the questions were asked, which the old <dl>
 * did not — it led with school and buried course last, so the receipt didn't
 * read as a record of what had just happened.
 */
const PREVIEW_ITEM_ICONS = {
  state: MapPin,
  course: BookOpen,
  grade: GraduationCap,
  school: Building2,
  format: FileText,
}

function PreviewStep({ finishing, onFinish, stateLabel, schoolName, courseName, gradeName, formatName, editableSteps = [], onEdit, onBack }) {
  useOnboardingActions({
    onNext: onFinish,
    nextLabel: finishing ? 'Opening your workspace…' : 'Open my workspace',
    busy: finishing,
    onBack,
  })
  const setupItems = [
    { key: 'state', label: 'State', value: stateLabel || 'Not set yet', edit: 'state' },
    { key: 'course', label: 'Course', value: courseName || 'Not set yet', edit: 'course' },
    { key: 'grade', label: 'Grade', value: gradeName || 'Not set yet', edit: 'course' },
    { key: 'school', label: 'Your school', value: schoolName || 'Not set yet', edit: 'school' },
    { key: 'format', label: 'School format', value: formatName, edit: 'format' },
  ]

  return (
    <div className="onboarding-final">
      {/* A small overshoot (custom cubic-bezier past 1) reads as a pop rather
          than a plain fade — the one moment in the whole flow that's a
          celebration rather than a question, so it's allowed a little more
          motion than everywhere else. Each row below stays a normal ease-out
          fade-up, staggered, so the checklist reads as a receipt printing
          itself rather than a single canned reveal. */}
      <div className="onboarding-final-hero">
        {/* The same seal used in the topbar and in AppShell's own sidebar
            header, just much bigger — the destination this whole flow was
            walking toward, not a new mark invented for one screen. Gets a
            small overshoot on entrance (past scale 1, past rotate 0) and a
            slow, continuous breathing glow afterward — the one moment in the
            whole flow that's a celebration rather than a question, so it's
            allowed motion nothing else here gets. Both collapse under the
            app's blanket prefers-reduced-motion rule (base.css) same as
            everything else. */}
        <motion.div
          className="onboarding-final-hero-logo"
          initial={{ opacity: 0, scale: 0.55, rotate: -8 }}
          animate={{ opacity: 1, scale: 1, rotate: 0 }}
          transition={{ duration: 0.6, ease: [0.34, 1.56, 0.64, 1] }}
          aria-hidden="true"
        >
          <svg viewBox="0 0 64 64" className="onboarding-final-hero-svg">
            <circle cx="32" cy="32" r="29" fill="transparent" className="land-seal-disc" />
            <circle cx="32" cy="32" r="30.5" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="1.6 3.4" className="land-seal-ticks" />
            <circle cx="32" cy="32" r="27" fill="none" stroke="currentColor" strokeWidth="2.5" className="land-seal-ring" />
            <path d="M20 33l8 8 16-18" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" className="land-seal-check" />
          </svg>
        </motion.div>
        <motion.p
          className="onboarding-final-hero-ready"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}
        >
          Ready
        </motion.p>
      </div>
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, delay: 0.4, ease: [0.22, 1, 0.36, 1] }}>
        <p className="onboarding-final-kicker">Workspace ready</p>
        <h2 id="onboarding-title" tabIndex={-1} className="onboarding-final-title">Your teaching workspace is ready.</h2>
        <p className="onboarding-final-intro">Everything is saved and ready for your first plan.</p>
      </motion.div>

      <div className="onboarding-final-cards" role="list" aria-label="Saved setup details">
        {setupItems.map((item, index) => {
          const Icon = PREVIEW_ITEM_ICONS[item.key]
          return (
            <motion.div
              key={item.key}
              role="listitem"
              className="onboarding-final-card"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.32, delay: 0.5 + index * 0.06, ease: [0.22, 1, 0.36, 1] }}
            >
              <span className="onboarding-final-card-icon" aria-hidden="true">
                <Icon size={16} strokeWidth={2} />
              </span>
              <span className="onboarding-final-card-text">
                <span className="onboarding-final-card-label">{item.label}</span>
                <span className="onboarding-final-card-value">{item.value}</span>
              </span>
              {/* Only offered for a step this account actually saw — the plan
                  is 4-7 steps, so an Edit link to a step that was never in it
                  would jump to a screen the teacher has no context for. */}
              {editableSteps.includes(item.edit) ? (
                <button
                  type="button"
                  className="onboarding-setup-summary-edit"
                  onClick={() => onEdit(item.edit)}
                >
                  Edit<span className="sr-only"> {item.label}</span>
                </button>
              ) : null}
            </motion.div>
          )
        })}
      </div>

      {/* The one line worth keeping from the deleted `tips` step. That step
          showed three abstract tips on a screen with nothing to act on; a
          concrete prompt here, one click from the composer, is the same advice
          at the moment it can actually be used. The other two tips are in git
          history — a proper first-session suggestion belongs in
          lib/contextualSuggestions.js, which has its own priority/context
          contract and five consumers, so it is a separate piece of work rather
          than a paste. */}
      <motion.div
        className="onboarding-next-note"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.32, delay: 0.5 + setupItems.length * 0.06 + 0.05, ease: [0.22, 1, 0.36, 1] }}
      >
        <Sparkles size={15} aria-hidden="true" />
        <span><strong>Try this first:</strong> “Plan a week for my next unit using my course standards.”</span>
      </motion.div>

      <div className="onboarding-final-footer">
        <span>Your setup is saved. You can change anything later in Settings.</span>
      </div>
    </div>
  )
}

export function ConfirmedCalendarReview({ schoolId, compact = false }) {
  const { data: submission, isLoading } = useQuery({
    queryKey: ['schoolCalendarConfirmed', schoolId],
    queryFn: () => api.getConfirmedSchoolCalendar(schoolId),
    enabled: !!schoolId,
    retry: false,
  })

  if (isLoading) return <p className="mt-2 text-xs text-ink-muted">Loading calendar...</p>
  if (!submission || !submission.weeks) return null

  return (
    <div className={`mt-3 rounded-xl bg-ok/10 p-4 text-sm ${compact ? 'w-full' : 'max-w-2xl onboarding-calendar-card'}`}>
      <p className="font-medium text-ok mb-3">Confirmed by your colleagues</p>
      <CalendarBody weeks={submission.weeks} />
    </div>
  )
}
