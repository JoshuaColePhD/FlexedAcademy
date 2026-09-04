import { Fragment, lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import usaMap from '@svg-maps/usa'
import {
  ArrowRight,
  CheckCircle2,
  FileText,
  Loader2,
  Sparkles,
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
import { inferGradeFromQuery, matchesFramework } from '../lib/frameworks'
import { US_STATES } from '../lib/states'
import { ONBOARDING_STEPS, derivePlan, nextStep, prevStep } from '../lib/onboardingPlan'
import { FrameworkPicker } from './FrameworkPicker'
import { SchoolSelect } from './SchoolSelect'
import { PendingCalendarReview } from './PendingCalendarReview'
import { CalendarBody } from './ArtifactDetailPanel'
import { UploadDropzone } from './UploadDropzone'
import { OnboardingStepRail } from './onboarding/OnboardingStepRail'
import { OnboardingQuestion, OnboardingChoiceLabel } from './onboarding/OnboardingQuestion'
import { OnboardingActions } from './onboarding/OnboardingActions'
import { AvatarPicker } from './AvatarPicker'
// ClassDocuments used to live inside ClassPage.jsx and was re-exported from
// there; it later moved out to its own file (components/ClassDocuments.jsx)
// with nothing left behind at the old path, so this lazy import silently
// resolved to `{ default: undefined }` and crashed the MaterialsStep below
// with "Element type is invalid" the moment a teacher reached it — every
// first-run account, since /welcome always leaves `documents` in the plan.
const ClassDocuments = lazy(() => import('./ClassDocuments.jsx').then((module) => ({ default: module.ClassDocuments })))


// Keep the onboarding gate honest about what the current standards catalog
// can actually support. Add a state code here when its standards are ingested;
// the UI will then enable it automatically in the same alphabetical list.
const INGESTED_STANDARDS_STATES = new Set(['AL'])

/* Direction-aware, and actually wired up this time.
 *
 * `custom={direction}` was already being handed to AnimatePresence with no
 * variants to consume it — the visible animation was a CSS keyframe
 * (onboarding-step-enter) that had an enter and no exit, so mode="wait" was
 * waiting for nothing and a step leaving simply vanished.
 *
 * Asymmetric on purpose: mode="wait" plays exit fully before enter starts, so
 * two symmetric --t-base legs would total 440ms for a step swap. --t-fast out
 * and --t-base in lands around --t-enter instead. --ease-glide rather than
 * --ease-out, because --ease-out is already at full speed on its first frame,
 * which reads as a snap at panel size (see that token's own comment).
 *
 * <MotionConfig reducedMotion="user"> in App.jsx neutralises the transform for
 * anyone who asked; base.css's blanket prefers-reduced-motion block only
 * governs CSS, which is why the rail's own transitions stay in CSS.
 */
const STEP_VARIANTS = {
  enter: (dir) => ({ opacity: 0, x: dir * 16 }),
  center: { opacity: 1, x: 0, transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] } },
  exit: (dir) => ({ opacity: 0, x: dir * -16, transition: { duration: 0.13, ease: [0.22, 1, 0.36, 1] } }),
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
  const [savingState, setSavingState] = useState(false)
  const [stateError, setStateError] = useState(false)

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

  const saveState = async () => {
    if (!state) {
      setStateError(true)
      return
    }
    setStateError(false)
    setSavingState(true)
    try {
      if (state !== (activeClass?.state || '')) {
        await api.updateClass(activeClass.id, { state })
        qc.invalidateQueries({ queryKey: qk.classes })
      }
      goNext()
    } catch (err) {
      toast.apiError('Could not save your state', err)
    } finally {
      setSavingState(false)
    }
  }

  /* Keep one progress sequence for the whole first-run flow. Welcome is a
   * real decision (state), so excluding it here made the next screen reset
   * from "Step 1 of 6" to "Step 1 of 5". The closing celebration is the only
   * screen that should stay outside the numbered sequence. */
  /* The rail owns progress now, so this is just the sequence it renders.
     What used to be here as well -- an `eyebrow` string, plus `currentStep`
     and `totalSteps` -- was three ways of saying the same thing, and two of
     them were dead: five step components passed currentStep/totalSteps into a
     StepHeader signature that never accepted them, so they rendered nothing at
     all while looking like they were doing the work. */
  const progressSteps = plan.filter((key) => key !== 'preview')

  const saveSchool = async () => {
    setSavingSchool(true)
    try {
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
      if (school && school !== (activeClass?.school || '')) {
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

  const saveCourse = async () => {
    if (!subject) {
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
        const created = await api.createClass({ subject, grade })
        setCreatedClass(created)
        await Promise.all([qc.invalidateQueries({ queryKey: qk.classes }), refresh()])
      } else {
        const patch = {}
        if (subject !== activeClass.subject) patch.subject = subject
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
  const railSteps = progressSteps.map((key) => ({ key, label: ONBOARDING_STEPS[key]?.label || key }))

  const card = (
    <>
      {/* Slim top bar, wordmark centred — the reference layout's chrome, and
          the same treatment /welcome's own header gives it. */}
      <div className="onboarding-topbar">
        <span className="onboarding-wordmark">FlexEd Academy</span>
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

      <div className="onboarding-body">
        <OnboardingStepRail steps={railSteps} activeKey={stepKey} onGoTo={goTo} />
        <div className="onboarding-column">
          {/* data-fill hands the card's own height down to a step whose
              content is itself a scroll region (the course browser), so there
              is only ever one scrollbar. */}
          <div className="onboarding-content" data-fill={stepKey === 'course' ? 'true' : undefined}>

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
              >
            {stepKey === 'avatar' ? (
              <ProfileStep
                name={teacherName}
                setName={setTeacherName}
                saving={savingProfile}
                onNext={saveProfile}
              />
            ) : stepKey === 'state' ? (
              <StateStep
                state={state}
                setState={(value) => { setState(value); setStateError(false) }}
                stateError={stateError}
                saving={savingState}
                onNext={saveState}
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
                saving={savingSchool}
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
    </>
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
      <AvatarPicker size="lg" previewName={name} />

      {/* No skip. There is nothing to skip past — the name is pre-filled and
          the icon already defaults to initials, so Continue IS the "leave it
          as it is" path. A Skip button beside a filled-in field only invites
          the question of what it would even do. */}
      <OnboardingActions onNext={onNext} busy={saving} />
    </div>
  )
}

function StateStep({ state, setState, stateError, saving, onNext }) {
  const stateListRef = useRef(null)
  const availableStates = US_STATES
  const firstAvailableStateIndex = 0

  const moveState = (event, index) => {
    const lastIndex = availableStates.length - 1
    let nextIndex = index
    const direction = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (direction) {
      nextIndex = index + direction
      nextIndex = index + direction
      if (nextIndex < 0 || nextIndex > lastIndex) nextIndex = index
    }
    if (event.key === 'Home') nextIndex = firstAvailableStateIndex
    if (event.key === 'End') {
      nextIndex = lastIndex
      nextIndex = lastIndex
    }
    if (nextIndex === index) return

    event.preventDefault()
    const [nextValue] = availableStates[nextIndex]
    setState(nextValue)
    const nextButton = stateListRef.current?.querySelectorAll('button')[nextIndex]
    nextButton?.focus()
    nextButton?.scrollIntoView({ block: 'nearest' })
  }

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
      <OnboardingQuestion
        question="What state are you coming from?"
      />
      {/* The two-column split lives in CSS now, keyed on the CARD's width
          rather than the viewport's. It was `lg:grid-cols-[minmax(0,0.78fr)_minmax(22rem,1.22fr)]`
          — viewport breakpoints for a layout inside a fixed 58rem card, so at
          1440px the utilities fired while the content column was still only
          ~640px wide: the 22rem minimum on the map left ~290px for the list,
          and "Teaching state" and "Coming soon" both wrapped. */}
      <div className="onboarding-state-layout" data-has-state={state ? 'true' : undefined}>
        <div className="onboarding-neomorphic-pane onboarding-state-chooser flex min-h-0 flex-col rounded-2xl p-6 lg:h-full">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-ink">Teaching state</p>
            <span className="onboarding-state-available">Available now</span>
          </div>
          <div ref={stateListRef} role="listbox" aria-label="Teaching state" className="onboarding-neomorphic-list onboarding-state-list mt-3 rounded-xl p-1.5 lg:min-h-0 lg:flex-1">
            {availableStates.map(([value, label], index) => {
              const isSelected = state === value
              const isAvailable = INGESTED_STANDARDS_STATES.has(value)
              return (
                <button
                  key={value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  tabIndex={isAvailable && (isSelected || (!state && index === firstAvailableStateIndex)) ? 0 : -1}
                  disabled={!isAvailable}
                  onClick={() => setState(value)}
                  onKeyDown={(event) => moveState(event, index)}
                  className={`flex min-h-11 w-full items-center justify-between rounded-lg border px-3 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${!isAvailable
                    ? 'cursor-not-allowed border-transparent text-ink-faint opacity-55'
                    : isSelected
                      ? 'onboarding-state-selected border-accent/30 bg-accent/10 font-semibold text-ink'
                      : 'border-transparent text-ink-soft hover:border-edge hover:bg-paper-sunken hover:text-ink'
                  }`}
                >
                  <span>{label}</span>
                  <span className={`text-2xs font-semibold tracking-wider ${isAvailable && isSelected ? 'text-accent-text' : 'text-ink-faint'}`}>{isAvailable ? value : 'Coming soon'}</span>
                </button>
              )
            })}
          </div>
          <p className="onboarding-state-support-note">More states are on the way. We’ll only ask you to choose when their standards are ready.</p>
          {stateError ? <p className="mt-2 text-xs font-medium text-mark">Choose your state to continue.</p> : null}
        </div>
        {state ? <StateMapPreview stateCode={state} /> : null}
      </div>
      <OnboardingActions onNext={onNext} busy={saving} disabled={!state} />
    </motion.div>
  )
}

function StateMapPreview({ stateCode }) {
  const selected = usaMap.locations.find((location) => location.id === stateCode.toLowerCase())
  const [viewBox, setViewBox] = useState(usaMap.viewBox)
  const pathRef = useRef(null)

  // Always measure a new state against the source map's coordinate system.
  // Measuring while the previous state is still zoomed makes getBBox() return
  // transformed coordinates, which can move the next outline outside the
  // visible SVG frame.
  useLayoutEffect(() => {
    setViewBox(usaMap.viewBox)
  }, [selected?.id])

  useLayoutEffect(() => {
    if (viewBox !== usaMap.viewBox) return
    const bounds = pathRef.current?.getBBox()
    if (!bounds || !bounds.width || !bounds.height) return
    const padding = Math.max(bounds.width, bounds.height) * 0.16
    setViewBox(`${bounds.x - padding} ${bounds.y - padding} ${bounds.width + padding * 2} ${bounds.height + padding * 2}`)
  }, [selected?.id, viewBox])

  if (!selected) return null

  return (
    <div className="onboarding-glass-pane flex min-h-72 flex-col rounded-2xl border-accent/20 bg-accent/5 p-6 lg:h-full">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-2xs font-semibold uppercase tracking-widest text-accent-text">Your state</p>
          <p className="mt-1 text-base font-semibold text-ink">{selected.name}</p>
        </div>
        <span className="rounded-full bg-accent/10 px-2.5 py-1 text-xs font-semibold tracking-wider text-accent-text">{stateCode}</span>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <AnimatePresence mode="wait" initial={false}>
          <motion.svg
            key={selected.id}
            initial={{ opacity: 0, scale: 0.94 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.35, ease: 'easeOut' }}
            viewBox={viewBox}
            role="img"
            aria-label={`Outline of ${selected.name}`}
            className="h-56 w-full origin-center"
          >
            <path
              ref={pathRef}
              d={selected.path}
              fill="none"
              className="stroke-accent-text"
              strokeWidth="2.5"
              strokeLinejoin="round"
            />
          </motion.svg>
        </AnimatePresence>
      </div>
      <div className="mt-3 flex flex-wrap justify-center gap-2" aria-label="State-based setup">
        {['Standards', 'School calendar', 'Course options'].map((item) => (
          <span key={item} className="rounded-full border border-accent/15 bg-paper-raised/70 px-2.5 py-1 text-2xs font-medium text-accent-text">
            {item}
          </span>
        ))}
      </div>
    </div>
  )
}

function SchoolStep({
  school,
  onSchoolChange,
  schools,
  saving,
  onBack,
  onNext,
  onSkip,
}) {
  return (
    <div>
      <OnboardingQuestion
        question="Which school do you teach at?"
        lead="Choose your school, then continue to its format and calendar."
      />
      <SchoolSelect
        ariaLabel="School"
        id="onboarding-school"
        schools={schools}
        value={school}
        onChange={onSchoolChange}
        emptyOption={{ value: '', label: 'Choose a school' }}
        inputClassName="neo-select min-h-touch w-full rounded-lg border border-edge bg-paper py-2.5 pl-3.5 pr-8 text-sm text-ink outline-none focus:border-accent"
      />
      <OnboardingActions
        onNext={onNext}
        busy={saving}
        onBack={onBack}
        onSkip={onSkip}
        skipLabel={ONBOARDING_STEPS.school.skipLabel}
      />
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
  const pending = selectedSchool?.has_pending_calendar
  const confirmed = selectedSchool?.has_calendar

  return (
    <div>
      <OnboardingQuestion
        question={ONBOARDING_STEPS.calendar.title}
        lead={
          pending
            ? 'A colleague at your school already set this up. Worth a look before we date your plans with it.'
            : confirmed
              ? 'This is what your plans will be dated against.'
              : "We don't have a calendar for your school yet, so plans will be labelled by week number — Week 1, Week 2 — with no dates attached."
        }
      />
      {pending ? (
        <PendingCalendarReview schoolId={school} />
      ) : confirmed ? (
        <ConfirmedCalendarReview schoolId={school} />
      ) : null}
      <OnboardingActions
        onNext={onNext}
        onBack={onBack}
        onSkip={onNext}
        skipLabel={ONBOARDING_STEPS.calendar.skipLabel}
      />
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
      {/* One footer per phase of the nested upload -> processing -> review ->
          confirmed machine, each with exactly one filled control. `processing`
          has no button on purpose: there is nothing to press while soffice
          works, and offering a disabled Continue there just invites clicking
          it. */}
      {phase === 'upload' ? (
        <OnboardingActions
          onNext={onNext}
          nextLabel={hasInput ? 'Analyze format' : 'Continue'}
          busy={saving}
          onBack={onBack}
          onSkip={onSkip}
          skipLabel="Skip — use a neutral layout for now"
        />
      ) : phase === 'processing' ? (
        <div className="onboarding-actions">
          <p className="flex items-center gap-2 text-sm text-ink-muted">
            <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Working on it…
          </p>
        </div>
      ) : phase === 'review' ? (
        <OnboardingActions
          onNext={onConfirm}
          nextLabel="Use this format"
          disabled={!reviewable}
          onBack={onEdit}
          backLabel="Choose another file"
        />
      ) : (
        <OnboardingActions onNext={onNext} onBack={onBack} />
      )}
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
function CourseStep({ subject, setSubject, grade, setGrade, frameworks, saving, error, onBack, onNext }) {
  const [query, setQuery] = useState('')

  /* The grade select used to feed only the class this step saves — it sat
     right beside a browser full of courses and did nothing to it, which reads
     as broken the moment anyone tries it. Every framework carries its own
     grades[] already (that's what powers the "elementary"/"middle"/"high"
     search synonyms in lib/frameworks.js), so narrowing the list is a filter,
     not a new capability. '' is "all grades". Ported from WelcomePage, which
     this step replaces. */
  const gradeFilteredFrameworks = useMemo(
    () => (!grade ? frameworks : frameworks.filter((f) => (f.grades || []).includes(Number(grade)))),
    [frameworks, grade],
  )

  /* A course chosen under one grade can fall outside the list the moment the
     grade changes (AP Calculus picked at 11th, then grade dropped to 3rd) —
     left alone, Continue would save a course that is no longer even visible. */
  useEffect(() => {
    if (subject && !gradeFilteredFrameworks.some((f) => f.id === subject)) setSubject('')
  }, [gradeFilteredFrameworks, subject, setSubject])

  /* The search box understands grade words too, which used to silently fight
     the select: leave it on 11th, type "elementary", get zero results and no
     hint why. A specific number is unambiguous, so it snaps the select to that
     grade. A band word spans several grades with no single right answer, so it
     only widens back to all grades — and only when the current grade actually
     conflicts, leaving a grade already inside the band alone. */
  useEffect(() => {
    const intent = inferGradeFromQuery(query)
    if (!intent) return
    if (intent.type === 'grade') {
      if (grade !== intent.grade) setGrade(intent.grade)
    } else if (intent.type === 'band' && grade && !intent.grades.includes(Number(grade))) {
      setGrade('')
    }
  }, [query, grade, setGrade])

  /* A plain course-name search ("cybersecurity") isn't a grade word, so the
     inference above doesn't fire — and it can still come up empty purely
     because the grade filter excludes every match. FrameworkPicker's generic
     "No course matches" is right for a typo; this gives the real reason
     specifically when the search WOULD have hits at another grade. */
  const emptyMessage = useMemo(() => {
    if (!grade) return undefined
    /* No query at all, and the grade filter has emptied the list. Ported from
       /welcome, which only covered the WITH-a-query case and so left a teacher
       whose grade simply has no courses staring at a blank panel with nothing
       saying why. Reachable for real: the corpus is ingested per grade band,
       so a grade with nothing behind it yet is a state the catalog can be in,
       not just a mock-data artifact. */
    if (!query.trim()) {
      return gradeFilteredFrameworks.length
        ? undefined
        : `No ${gradeLabel(grade) || grade} courses yet — try All grades.`
    }
    if (gradeFilteredFrameworks.some((f) => matchesFramework(f, query))) return undefined
    if (!frameworks.some((f) => matchesFramework(f, query))) return undefined
    return `No ${gradeLabel(grade) || grade} courses match “${query}” — try All grades.`
  }, [query, grade, gradeFilteredFrameworks, frameworks])

  return (
    <div className="onboarding-class-step">
      <OnboardingQuestion
        className="onboarding-class-header"
        question="Which course are you teaching?"
      />
      <div className="onboarding-course-browser">
        <div className="onboarding-course-picker">
          <FrameworkPicker
            frameworks={gradeFilteredFrameworks}
            value={subject}
            onChange={setSubject}
            onQueryChange={setQuery}
            emptyMessage={emptyMessage}
            id="onboarding-framework"
            variant="inline"
            afterInput={(
              <label className="onboarding-course-grade-control" htmlFor="onboarding-grade">
                <span>Grade</span>
                <select
                  id="onboarding-grade"
                  value={grade}
                  onChange={(e) => setGrade(e.target.value)}
                  className="neo-select min-h-touch rounded-lg border border-edge bg-paper py-2.5 pl-3.5 pr-8 text-sm text-ink outline-none focus:border-accent"
                >
                  {/* Present and empty on purpose. The grade a teacher never
                      chose must not look chosen — see the note on the grade
                      state in the wizard. */}
                  <option value="">All grades</option>
                  {GRADES.map((g) => (
                    <option key={g.value} value={g.value}>
                      {g.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          />
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
        <div className="onboarding-course-browser-actions">
          <OnboardingActions onNext={onNext} busy={saving} onBack={onBack} />
        </div>
      </div>
    </div>
  )
}

function MaterialsStep({ cls, onBack, onNext }) {
  return (
    <div>
      <OnboardingQuestion
        question="Add your teaching materials"
        lead="Optional. Add the planning source FlexEd should use to organize new plans. You can add supporting materials later."
      />
      <Suspense fallback={<p className="text-xs text-ink-muted">Loading documents…</p>}>
        <ClassDocuments cls={cls} variant="onboarding" />
      </Suspense>
      {/* The skip states its own cost, rather than a bare "Skip for now".
          A teacher who skips this keeps planning fine; they just don't get
          plans that follow their pacing guide, and nothing said so before. */}
      <OnboardingActions
        onNext={onNext}
        onBack={onBack}
        onSkip={onNext}
        skipLabel="Skip — I’ll add these later"
      />
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
function PreviewStep({ finishing, onFinish, stateLabel, schoolName, courseName, gradeName, formatName, editableSteps = [], onEdit, onBack }) {
  const setupItems = [
    { key: 'state', label: 'State', value: stateLabel || 'Not set yet', edit: 'state' },
    { key: 'course', label: 'Course', value: courseName || 'Not set yet', edit: 'course' },
    { key: 'grade', label: 'Grade', value: gradeName || 'Not set yet', edit: 'course' },
    { key: 'school', label: 'Your school', value: schoolName || 'Not set yet', edit: 'school' },
    { key: 'format', label: 'School format', value: formatName, edit: 'format' },
  ]

  return (
    <motion.div 
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, type: "spring", bounce: 0.2 }}
      className="onboarding-final"
    >
      <div className="onboarding-final-kicker">Workspace ready</div>
      <h2 id="onboarding-title" className="onboarding-final-title">Your teaching workspace is ready.</h2>
      <p className="onboarding-final-intro">Everything is saved and ready for your first plan.</p>
      <section className="onboarding-final-stage" aria-label="Workspace ready">
        <div className="onboarding-final-stage-glow" aria-hidden="true" />
        <div className="onboarding-final-ring" aria-hidden="true" />
        <div className="onboarding-final-ring onboarding-final-ring-secondary" aria-hidden="true" />
        <motion.div
          initial={{ scale: 0.86, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.4, type: 'spring', bounce: 0.25 }}
          className="onboarding-final-logo"
        >
          <img src="/icon-512.png" alt="" />
          <span className="onboarding-final-logo-check" aria-hidden="true">
            <CheckCircle2 size={30} strokeWidth={2.5} />
          </span>
        </motion.div>
      </section>

      <dl className="onboarding-final-setup" aria-label="Saved setup details">
        {setupItems.map((item) => (
          <div key={item.key} className="onboarding-final-setup-item">
            <dt>{item.label}</dt>
            <dd>
              {item.value}
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
            </dd>
          </div>
        ))}
      </dl>

      <button
        type="button"
        disabled={finishing}
        className="onboarding-continue onboarding-final-cta fa-press"
        onClick={onFinish}
      >
        {finishing ? <Loader2 size={17} className="mr-2 animate-spin" aria-hidden="true" /> : null}
        {finishing ? 'Opening your workspace…' : 'Open my workspace'}
        {!finishing ? <ArrowRight size={17} className="ml-2" aria-hidden="true" /> : null}
      </button>

      {/* The one line worth keeping from the deleted `tips` step. That step
          showed three abstract tips on a screen with nothing to act on; a
          concrete prompt here, one click from the composer, is the same advice
          at the moment it can actually be used. The other two tips are in git
          history — a proper first-session suggestion belongs in
          lib/contextualSuggestions.js, which has its own priority/context
          contract and five consumers, so it is a separate piece of work rather
          than a paste. */}
      <div className="onboarding-next-note">
        <Sparkles size={15} aria-hidden="true" />
        <span><strong>Try this first:</strong> “Plan a week for my next unit using my course standards.”</span>
      </div>

      <div className="onboarding-final-footer">
        <span>Your setup is saved. You can change anything later in Settings.</span>
        {onBack ? (
          <button type="button" className="onboarding-quiet" onClick={onBack}>Back</button>
        ) : null}
      </div>
    </motion.div>
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
    <div className={`mt-3 rounded-xl bg-ok/10 p-3 text-xs ${compact ? 'w-full' : 'max-w-sm'}`}>
      <p className="font-medium text-ok mb-2">Confirmed by your colleagues</p>
      <CalendarBody weeks={submission.weeks} />
    </div>
  )
}
