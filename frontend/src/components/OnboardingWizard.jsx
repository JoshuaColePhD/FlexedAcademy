import { Fragment, lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import usaMap from '@svg-maps/usa'
import {
  ArrowRight,
  CheckCircle2,
  FileText,
  Loader2,
  Mic,
  School as SchoolIcon,
  Sparkles,
  X,
} from 'lucide-react'
import { api } from '../lib/api'
import { qk } from '../lib/queryKeys'
import { deferOnboarding } from '../lib/onboardingWizardBus'
import { hasChosenSchool, hasUsableSchoolTemplate } from '../lib/schools'
import { useAuth } from '../lib/authContext'
import { useToast } from '../lib/toastContext'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useExitTransition } from '../hooks/useExitTransition'
import { GRADES, gradeLabel, gradeSelectValue } from '../lib/grades'
import { US_STATES } from '../lib/states'
import { FrameworkPicker } from './FrameworkPicker'
import { SchoolSelect } from './SchoolSelect'
import { PendingCalendarReview } from './PendingCalendarReview'
import { CalendarBody } from './ArtifactDetailPanel'
import { UploadDropzone } from './UploadDropzone'
import { OnboardingStepRail } from './onboarding/OnboardingStepRail'
import { OnboardingQuestion } from './onboarding/OnboardingQuestion'
import { OnboardingActions } from './onboarding/OnboardingActions'
// ClassDocuments used to live inside ClassPage.jsx and was re-exported from
// there; it later moved out to its own file (components/ClassDocuments.jsx)
// with nothing left behind at the old path, so this lazy import silently
// resolved to `{ default: undefined }` and crashed the DocumentsStep below
// with "Element type is invalid" the moment a teacher reached it — every
// first-run account, since /welcome always leaves `documents` in the plan.
const ClassDocuments = lazy(() => import('./ClassDocuments.jsx').then((module) => ({ default: module.ClassDocuments })))


const TIPS = [
  {
    icon: Sparkles,
    step: '01',
    title: 'Start with a real teaching goal',
    body: 'Start with a course, standard, text, or goal. FlexEd turns it into a workable plan.',
  },
  {
    icon: SchoolIcon,
    step: '02',
    title: 'Keep the plan grounded',
    body: 'Your state, calendar, materials, and school format keep each plan connected to your work.',
  },
  {
    icon: Mic,
    step: '03',
    title: 'Shape it as you teach',
    body: 'Ask for a revision, more support, or a fresh approach whenever you need one.',
  },
]

// Keep the onboarding gate honest about what the current standards catalog
// can actually support. Add a state code here when its standards are ingested;
// the UI will then enable it automatically in the same alphabetical list.
const INGESTED_STANDARDS_STATES = new Set(['AL'])

/* One label per plan key, for the step rail.
 *
 * A short noun, not a sentence: it sits beside a question that already asks
 * the sentence, and the rail column is 11rem wide. These are the CURRENT plan
 * keys; when the flow re-sequencing lands they come from
 * lib/onboardingPlan.js's ONBOARDING_STEPS instead, which is where the labels
 * for the new keys already live.
 */
const STEP_LABELS = {
  welcome: 'State',
  school: 'School',
  class: 'Course',
  template: 'Format',
  documents: 'Materials',
  tips: 'Review',
}

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
  const toast = useToast()
  const qc = useQueryClient()
  const { user, refresh } = useAuth()
  const { mounted, closing } = useExitTransition(open, 220)
  const dialogRef = useRef(null)

  /* Tracked by KEY, not by index. The step list is built from what this
   * account still has to answer (see `plan` below), so it isn't a fixed
   * length — and an index into a list that can grow or shrink underneath you
   * is how a wizard lands someone on the wrong screen. A key stays put. */
  const [stepKey, setStepKey] = useState('welcome')
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
  const [grade, setGrade] = useState(gradeSelectValue(cls?.grade))
  const [savingClass, setSavingClass] = useState(false)
  const [classError, setClassError] = useState(false)

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
  const schoolTemplates = schoolTemplatesData?.templates || []
  const [selectingTemplateId, setSelectingTemplateId] = useState(null)

  // Reset to a clean first step every time this opens on a (possibly
  // different) class, rather than resuming wherever a previous open left off.
  useEffect(() => {
    if (!open) return
    setStepKey(cls?.state ? livePlan.find((candidate) => candidate !== 'welcome') || 'done' : 'welcome')
    setDirection(1)
    setSchool(cls?.school || '')
    setTemplateFile(null)
    setTemplateUrl('')
    setBlankTemplateAttested(false)
    setTemplatePhase('upload')
    setTemplateAnalysis(null)
    setTemplateFindings([])
    setTemplateAnalysisStatus(null)
    setSelectingTemplateId(null)
    setState(cls?.state || '')
    setStateError(false)
    setSubject(cls?.subject || '')
    setGrade(gradeSelectValue(cls?.grade))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cls?.id])

  useFocusTrap(dialogRef, { active: open, trap: true, onEscape: onClose })

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
  const schoolHasMultipleTemplates = schoolTemplates.length > 1
  const schoolTemplateSelectionStep = chosenSchool && (schoolTemplatesLoading || schoolHasMultipleTemplates)

  /* Which steps this account actually has to sit through. The page variant is
   * the first-run setup, so it always includes a course confirmation even if
   * /welcome already supplied a starting value. That gives the teacher a
   * clear chance to choose the course that should drive standards and plan
   * language; the modal variant used from Settings still skips a completed
   * course choice and only shows genuinely unfinished setup.
   */
  /* Live, not stateful — computed fresh every render from the current
   * school/schoolNeedsTemplate/subject rather than committed via an effect.
   * `schools` is an async query, so schoolNeedsTemplate can flip from false
   * to true partway through a render — a version of this that stored the
   * plan in state and recomputed it from a useEffect lagged one render
   * behind that flip (effects commit after the render that triggered them),
   * which was how the welcome screen's old step-count copy briefly showed a
   * stale number before correcting itself. Computing it inline avoids that
   * lag entirely, independent of whether anything on screen still displays
   * a count. */
  const livePlan = useMemo(() => {
    const next = cls?.state ? [] : ['welcome']
    if (!chosenSchool) next.push('school')
    if (variant === 'page' || !subject) next.push('class')
    if (!chosenSchool || schoolNeedsTemplate || schoolTemplateSelectionStep) next.push('template')
    next.push('documents', 'tips', 'done')
    return next
  }, [chosenSchool, schoolNeedsTemplate, schoolTemplateSelectionStep, subject, cls?.state, variant])

  /* Frozen the moment the teacher leaves welcome — once they've started
   * moving through the flow, the shape must not shift under them even if
   * school/subject change later (e.g. the SchoolStep itself edits `school`). */
  const [frozenPlan, setFrozenPlan] = useState(null)
  useEffect(() => {
    if (!open) { setFrozenPlan(null); return }
    if (stepKey === 'welcome') { setFrozenPlan(null); return }
    setFrozenPlan((prev) => prev || livePlan)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, stepKey])
  const plan = frozenPlan || livePlan

  const goTo = (next) => {
    setDirection(plan.indexOf(next) > plan.indexOf(stepKey) ? 1 : -1)
    setStepKey(next)
  }
  const step = (offset) => {
    const i = plan.indexOf(stepKey)
    return plan[Math.min(Math.max(i + offset, 0), plan.length - 1)]
  }
  const goNext = () => goTo(step(1))
  const goBack = () => goTo(step(-1))

  const saveState = async () => {
    if (!state) {
      setStateError(true)
      return
    }
    setStateError(false)
    setSavingState(true)
    try {
      if (state !== (cls?.state || '')) {
        await api.updateClass(cls.id, { state })
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
  const progressSteps = plan.filter((key) => key !== 'done')

  const saveSchool = async () => {
    setSavingSchool(true)
    try {
      // Keep the account-level school in sync with the class selection. This
      // also authorizes the just-selected teacher to upload a personal
      // template for that school after choosing it in onboarding.
      if (school && school !== user?.school) {
        await api.updateMe({ school })
      }
      if (school !== (cls?.school || '')) {
        await api.updateClass(cls.id, { school })
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

  const saveClass = async () => {
    if (!subject) {
      setClassError(true)
      return
    }
    setClassError(false)
    setSavingClass(true)
    try {
      const patch = {}
      if (subject !== cls?.subject) patch.subject = subject
      if (grade !== gradeSelectValue(cls?.grade)) patch.grade = grade
      if (Object.keys(patch).length) {
        await api.updateClass(cls.id, patch)
        qc.invalidateQueries({ queryKey: qk.classes })
      }
      goNext()
    } catch (err) {
      toast.apiError('Could not save that', err)
    } finally {
      setSavingClass(false)
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
      onClose()
    }
  }

  if (!mounted || !cls) return null

  const railSteps = progressSteps.map((key) => ({ key, label: STEP_LABELS[key] || key }))

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
          <div className="onboarding-content" data-fill={stepKey === 'class' ? 'true' : undefined}>

            <AnimatePresence mode="wait" custom={direction} initial={false}>
              <motion.div
                key={stepKey}
                custom={direction}
                variants={STEP_VARIANTS}
                initial="enter"
                animate="center"
                exit="exit"
              >
            {stepKey === 'welcome' ? (
              <WelcomeStep
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
              />
            ) : stepKey === 'template' ? (
              <TemplateStep
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
            ) : stepKey === 'class' ? (
              <ClassStep
                subject={subject}
                /* Clears the error, and deliberately does NOT advance.
                   This used to be `onChange={(v) => { setSubject(v); if (error) onNext() }}`
                   inside ClassStep, where onNext is saveClass — which closes
                   over the CURRENT render's `subject`. So picking a course
                   while the error was showing called saveClass() with subject
                   still '' and simply re-set the same error, which read as the
                   click doing nothing at all. Auto-advancing on a click inside
                   a browse list is also hostile on its own: a teacher scanning
                   courses got teleported forward by a misclick. Same wrapper
                   shape as setState above. */
                setSubject={(value) => { setSubject(value); setClassError(false) }}
                grade={grade}
                setGrade={setGrade}
                frameworks={frameworks}
                saving={savingClass}
                error={classError}
                onBack={goBack}
                onNext={saveClass}
              />
            ) : stepKey === 'documents' ? (
              <DocumentsStep cls={cls} onBack={goBack} onNext={goNext} />
            ) : stepKey === 'tips' ? (
              <TipsStep
                stateLabel={US_STATES.find(([value]) => value === state)?.[1]}
                schoolName={selectedSchool?.name || school}
                courseName={frameworks.find((framework) => framework.id === subject)?.label || subject}
                gradeName={gradeLabel(grade)}
                formatName={schoolHasUsableTemplate || templatePhase === 'confirmed' ? 'School format' : 'Add later'}
                editableSteps={plan}
                onEdit={(target) => { if (plan.includes(target)) goTo(target) }}
                onBack={goBack}
                onNext={goNext}
              />
            ) : (
              <DoneStep
                finishing={finishing}
                onFinish={finish}
                stateLabel={US_STATES.find(([value]) => value === state)?.[1]}
                schoolName={selectedSchool?.name || school}
                courseName={frameworks.find((framework) => framework.id === subject)?.label || subject}
                gradeName={gradeLabel(grade)}
                formatName={schoolHasUsableTemplate || templatePhase === 'confirmed' ? 'School format' : 'Add later'}
              />
            )}
              </motion.div>
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
        <div className="onboarding-card glass-panel fa-rise-panel">{card}</div>
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
        className={`onboarding-card neo-panel${closing ? ' is-closing' : ''}`}
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

function WelcomeStep({ state, setState, stateError, saving, onNext }) {
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
}) {
  return (
    <div>
      <OnboardingQuestion
        question="Which school do you teach at?"
        body="Choose your school, then continue to its format and calendar."
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
      {school && schools.find(s => s.id === school)?.has_pending_calendar ? (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mt-6">
          <h3 className="text-sm font-medium text-ink mb-2">Look at that! A colleague already did the heavy lifting and set up the calendar. Look right to you?</h3>
          <PendingCalendarReview schoolId={school} />
        </motion.div>
      ) : school && schools.find(s => s.id === school)?.has_calendar ? (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mt-6">
          <h3 className="text-sm font-medium text-ink mb-2">School Calendar</h3>
          <ConfirmedCalendarReview schoolId={school} />
        </motion.div>
      ) : null}
<OnboardingActions onNext={onNext} busy={saving} onBack={onBack} />
    </div>
  )
}

function TemplateStep({
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
        body={body}
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
function ClassStep({ subject, setSubject, grade, setGrade, frameworks, saving, error, onBack, onNext }) {
  return (
    <div className="onboarding-class-step">
      <OnboardingQuestion
        className="onboarding-class-header"
        question="Which course are you teaching?"
      />
      <div className="onboarding-course-browser">
        <motion.div
          className="onboarding-course-picker"
          animate={error ? { x: [-5, 5, -5, 5, 0] } : {}}
          transition={{ duration: 0.4 }}
        >
          <FrameworkPicker
            frameworks={frameworks}
            value={subject}
            onChange={setSubject}
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
                  {GRADES.map((g) => (
                    <option key={g.value} value={g.value}>
                      {g.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          />
          {error && <p className="mt-1.5 text-xs text-mark font-medium px-1">Please select a course to continue</p>}
        </motion.div>
        <div className="onboarding-course-browser-actions">
          <OnboardingActions onNext={onNext} busy={saving} onBack={onBack} />
        </div>
      </div>
    </div>
  )
}
function DocumentsStep({ cls, onBack, onNext }) {
  return (
    <div>
      <OnboardingQuestion
        question="Add your teaching materials"
        body="Optional. Add the planning source FlexEd should use to organize new plans. You can add supporting materials later."
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

function TipsStep({ stateLabel, schoolName, courseName, gradeName, formatName, editableSteps = [], onEdit, onBack, onNext }) {
  const editButton = (target, label) => editableSteps.includes(target) ? (
    <button type="button" className="onboarding-setup-summary-edit" onClick={() => onEdit(target)}>{label || 'Edit'}</button>
  ) : null

  return (
    <div>
      <OnboardingQuestion
        question="You’re ready to start"
        body="Your workspace is ready. Here’s how to turn it into your next plan."
      />
      <div className="onboarding-launch-layout">
        <section className="onboarding-setup-summary" aria-label="Your setup summary">
          <div className="onboarding-setup-summary-heading">
            <span className="text-2xs font-semibold uppercase tracking-[0.16em] text-ink-faint">Workspace</span>
            <span className="onboarding-setup-summary-ready">Ready</span>
          </div>
          <p className="onboarding-setup-summary-copy">FlexEd will use these details as you build new plans.</p>
          <div className="onboarding-setup-summary-grid">
            <div className="onboarding-setup-summary-item"><span>State</span><strong>{stateLabel || 'Not set yet'}</strong>{editButton('welcome')}</div>
            <div className="onboarding-setup-summary-item"><span>School</span><strong>{schoolName || 'Not set yet'}</strong>{editButton('school')}</div>
            <div className="onboarding-setup-summary-item"><span>Course</span><strong>{courseName || 'Not set yet'}</strong>{editButton('class')}</div>
            <div className="onboarding-setup-summary-item"><span>Grade</span><strong>{gradeName || 'Not set yet'}</strong>{editButton('class')}</div>
            <div className="onboarding-setup-summary-item"><span>Format</span><strong>{formatName}</strong>{editButton('template')}</div>
          </div>
          <p className="onboarding-setup-summary-footer">You can edit any of this later in Settings.</p>
        </section>
        <div className="onboarding-launch-guide">
          <div className="onboarding-launch-guide-heading">
            <span className="text-2xs font-semibold uppercase tracking-[0.16em] text-ink-faint">Your next move</span>
            <span className="text-xs text-ink-muted">Three simple steps</span>
          </div>
          <motion.ul
            initial="hidden"
            animate="visible"
            variants={{ visible: { transition: { staggerChildren: 0.045 } } }}
            className="onboarding-next-steps"
          >
            {TIPS.map((tip) => (
              <motion.li
                key={tip.title}
                variants={{ hidden: { opacity: 0, y: 6 }, visible: { opacity: 1, y: 0 } }}
                transition={{ duration: 0.22 }}
                className={`onboarding-next-step${tip.step === '01' ? ' is-primary' : ''}`}
              >
                <div className="onboarding-next-step-number" aria-hidden="true">{tip.step}</div>
                <div className="onboarding-next-step-icon">
                  <tip.icon size={17} className="text-accent-text" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink">{tip.title}</p>
                  <p className="mt-1 text-sm leading-relaxed text-ink-muted">{tip.body}</p>
                </div>
              </motion.li>
            ))}
          </motion.ul>
          <div className="onboarding-next-note">
            <Sparkles size={15} aria-hidden="true" />
            <span><strong>Try this next:</strong> “Plan a week for my next unit using my course standards.”</span>
          </div>
        </div>
      </div>
      <OnboardingActions onNext={onNext} onBack={onBack} nextLabel="Finish setup" />
    </div>
  )
}

function DoneStep({ finishing, onFinish, stateLabel, schoolName, courseName, gradeName, formatName }) {
  const setupItems = [
    { key: 'school', label: 'Your school', value: schoolName || 'Not set yet' },
    { key: 'state', label: 'State', value: stateLabel || 'Not set yet' },
    { key: 'grade', label: 'Grade', value: gradeName || 'Not set yet' },
    { key: 'format', label: 'School format', value: formatName },
    { key: 'course', label: 'Course', value: courseName || 'Not set yet' },
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
            <dd>{item.value}</dd>
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

      <div className="onboarding-final-footer">
        <span>Your setup is saved. You can change anything later in Settings.</span>
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
