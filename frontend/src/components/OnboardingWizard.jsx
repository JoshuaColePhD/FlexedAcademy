import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  ArrowRight,
  Loader2,
  Mic,
  PartyPopper,
  School as SchoolIcon,
  Sparkles,
  X,
} from 'lucide-react'
import { api } from '../lib/api'
import { qk } from '../lib/queryKeys'
import { deferOnboarding } from '../lib/onboardingWizardBus'
import { hasChosenSchool } from '../lib/schools'
import { useAuth } from '../lib/authContext'
import { useToast } from '../lib/toastContext'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useExitTransition } from '../hooks/useExitTransition'
import { GRADES, gradeSelectValue } from '../lib/grades'
import { FrameworkPicker } from './FrameworkPicker'
import { SchoolSelect } from './SchoolSelect'
import { PendingCalendarReview } from './PendingCalendarReview'
import { CalendarPreview } from './CalendarPreview'
import { UploadDropzone } from './UploadDropzone'
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
    title: 'Just describe the week',
    body: 'Tell the composer what you’re teaching — a text, a skill, a standard — and it builds the whole week, grounded in your course of study, in your district’s exact template.',
  },
  {
    icon: Mic,
    title: 'Or just talk',
    body: 'Voice mode turns a spoken back-and-forth into a finished plan — useful for thinking out loud on a commute, or planning between classes without typing.',
  },
  {
    icon: SchoolIcon,
    title: 'Everything grounds to a source',
    body: 'Every standard cited is quoted straight from the Course of Study, never invented — click any citation to see exactly where it came from.',
  },
]

/* Animates the step slot's height between whatever each step's content
 * happens to be (a one-line welcome vs. the documents step's whole list) —
 * same technique and same bug-fix reasoning as VoiceModePanel's own
 * SmoothHeight: measuring in a layout effect, before paint, is what keeps a
 * step swap from rendering one frame at the new height before the animation
 * has even started. Copied rather than imported/shared — VoiceModePanel's
 * copy isn't exported, and this one is small enough that a shared-component
 * refactor isn't worth it for a single second caller. */
export function SmoothHeight({ children }) {
  const contentRef = useRef(null)
  const [height, setHeight] = useState(null)

  useLayoutEffect(() => {
    const el = contentRef.current
    if (!el) return undefined
    const measure = () => {
      const next = el.getBoundingClientRect().height
      setHeight((prev) => (prev !== null && Math.abs(prev - next) < 0.5 ? prev : next))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [children])

  return (
    <div
      style={{
        height: height === null ? 'auto' : `${height}px`,
        transition: 'height 260ms cubic-bezier(0.4, 0, 0.2, 1)',
        overflow: 'hidden',
        // The panel above this is a flex column with its own overflow-y-auto
        // and a shrinking max-height (calc(100vh-4rem)). Without this, a flex
        // child's explicit height is only a *basis* — the browser was free to
        // squeeze it below its set height to fit the panel on a short
        // viewport, clipping the bottom of whichever step (and its Continue
        // button) rather than letting the panel scroll to it.
        flexShrink: 0,
      }}
    >
      <div ref={contentRef}>{children}</div>
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
  const toast = useToast()
  const qc = useQueryClient()
  const { refresh } = useAuth()
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

  // School & template step
  const [school, setSchool] = useState(cls?.school || '')
  const [templateFile, setTemplateFile] = useState(null)
  const [templateUrl, setTemplateUrl] = useState('')
  const [savingSchool, setSavingSchool] = useState(false)

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

  // Reset to a clean first step every time this opens on a (possibly
  // different) class, rather than resuming wherever a previous open left off.
  useEffect(() => {
    if (!open) return
    setStepKey('welcome')
    setDirection(1)
    setSchool(cls?.school || '')
    setTemplateFile(null)
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
  const schoolNeedsTemplate = chosenSchool && selectedSchool && selectedSchool.template_status !== 'active'

  /* Which steps this account actually has to sit through.
   *
   * /welcome (pages/onboarding/WelcomePage.jsx) is what CREATES the first
   * class, and it collects the teacher's name, school, course and grade to do
   * it — then this wizard opened straight afterwards and asked for the school,
   * the course and the grade again. Two forms, thirty seconds apart, asking
   * the same three questions: the second one reads as "the first one didn't
   * save", which is the opposite of the reassurance a first run is for.
   *
   * So each step earns its place by having something left to ask. A teacher
   * who came through /welcome drops straight to the parts it did NOT cover —
   * their own materials, and the tips — and someone re-running this from
   * Settings sees only what is genuinely still blank.
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
    const next = ['welcome']
    if (!chosenSchool || schoolNeedsTemplate) next.push('school')
    if (!subject) next.push('class')
    next.push('documents', 'tips', 'done')
    return next
  }, [chosenSchool, schoolNeedsTemplate, subject])

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

  /* "Step 1 of 3" was hardcoded on three steps of a SIX-step flow, so a
   * teacher told there were three things left got two more screens after the
   * one labelled last. Counted from the plan instead — welcome and the
   * closing celebration aren't work, so they don't count. */
  const formSteps = plan.filter((s) => s !== 'welcome' && s !== 'done')
  const formIndex = formSteps.indexOf(stepKey)
  const eyebrow = formIndex >= 0 ? `Step ${formIndex + 1} of ${formSteps.length}` : null
  const currentStep = formIndex >= 0 ? formIndex + 1 : 0
  const totalSteps = formSteps.length

  const saveSchool = async () => {
    setSavingSchool(true)
    try {
      if (school !== (cls?.school || '')) {
        await api.updateClass(cls.id, { school })
        qc.invalidateQueries({ queryKey: qk.classes })
      }
      if ((templateFile || templateUrl.trim()) && school) {
        await api.uploadSchoolTemplate(school, { file: templateFile, sourceUrl: templateUrl.trim() || undefined })
        qc.invalidateQueries({ queryKey: qk.schools })
        toast.success('Template submitted', 'We’ll train the AI on your school’s format.')
      }
      goNext()
    } catch (err) {
      toast.apiError('Could not save that', err)
    } finally {
      setSavingSchool(false)
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
      deferOnboarding()
      toast.apiError("Couldn't save your setup progress", err)
    } finally {
      setFinishing(false)
      onClose()
    }
  }

  if (!mounted || !cls) return null

  const steps = (
    <>
      <button
        type="button"
        className="absolute right-4 top-4 p-1.5 text-ink-muted transition-colors hover:text-ink rounded-md"
        onClick={finish}
        aria-label="Close"
        title="Skip for now"
      >
        <X size={20} aria-hidden="true" />
      </button>

      {/* SmoothHeight was written in this file, exported from this file,
          and then only ever used by VoiceModePanel — so the one panel it
          was named for snapped between step heights while the panel that
          borrowed it animated. The steps differ by a lot (a two-line
          welcome vs. the documents list), and that snap is the single
          most visible rough edge in the flow. */}
      <SmoothHeight>
        <AnimatePresence mode="wait" custom={direction}>
          <motion.div key={stepKey} className="onboarding-step" style={{ '--onboarding-dir': direction }}>
            {stepKey === 'welcome' ? (
              <WelcomeStep onNext={goNext} />
            ) : stepKey === 'school' ? (
              <SchoolStep
                eyebrow={eyebrow} currentStep={currentStep} totalSteps={totalSteps}
                school={school}
                setSchool={setSchool}
                schools={schools}
                schoolNeedsTemplate={schoolNeedsTemplate}
                templateFile={templateFile}
                setTemplateFile={setTemplateFile}
                templateUrl={templateUrl}
                setTemplateUrl={setTemplateUrl}
                saving={savingSchool}
                onBack={goBack}
                onNext={saveSchool}
              />
            ) : stepKey === 'class' ? (
              <ClassStep
                eyebrow={eyebrow} currentStep={currentStep} totalSteps={totalSteps}
                cls={cls}
                subject={subject}
                setSubject={setSubject}
                grade={grade}
                setGrade={setGrade}
                frameworks={frameworks}
                saving={savingClass}
                error={classError}
                onBack={goBack}
                onNext={saveClass}
              />
            ) : stepKey === 'documents' ? (
              <DocumentsStep eyebrow={eyebrow} currentStep={currentStep} totalSteps={totalSteps} cls={cls} onBack={goBack} onNext={goNext} />
            ) : stepKey === 'tips' ? (
              <TipsStep eyebrow={eyebrow} currentStep={currentStep} totalSteps={totalSteps} onBack={goBack} onNext={goNext} />
            ) : (
              <DoneStep finishing={finishing} onFinish={finish} />
            )}
          </motion.div>
        </AnimatePresence>
      </SmoothHeight>

      {/* Where am I, and how much is left — the flow had no answer to
          either beyond a line of text that was counting wrong. */}
      {formSteps.length > 1 && formIndex >= 0 ? (
        <div className="onboarding-progress" aria-hidden="true">
          {formSteps.map((s, i) => (
            <span key={s} className={i <= formIndex ? 'is-done' : undefined} />
          ))}
        </div>
      ) : null}
    </>
  )

  if (variant === 'page') {
    /* No scrim, no dialog role: there is no app underneath to layer over yet
       (see the comment on `variant` above) and nothing here should read as
       dismissible-by-clicking-past, since there's nothing behind it to reach. */
    return (
      <div className="flex h-app w-full items-center justify-center bg-paper p-gutter">
        <div className="onboarding-blob" aria-hidden="true" />
        <div
          className="relative flex max-h-full w-full max-w-2xl flex-col overflow-y-auto rounded-3xl border border-edge bg-paper-raised p-10 shadow-2xl"
        >
          {steps}
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
      <div
        className={`relative overflow-hidden rounded-3xl shadow-2xl ${closing ? ' is-closing' : ''}`}
        style={{ width: '100%', maxWidth: '42rem' }} // max-w-2xl equivalent
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
      >
        <div className="onboarding-blob" aria-hidden="true" />
        <div
          className="relative flex max-h-[calc(100vh-4rem)] w-full flex-col overflow-y-auto border border-white/10 bg-paper/60 p-10 backdrop-blur-3xl"
        >
          {steps}
        </div>
      </div>
    </div>
  )
}

function StepHeader({ eyebrow, title, body }) {
  return (
    <div className="mb-8">
      {eyebrow ? (
        <p className="text-xs font-semibold uppercase tracking-widest text-accent-text">{eyebrow}</p>
      ) : null}
      <h2 id="onboarding-title" className="mt-2 flex items-center gap-2 text-3xl font-bold tracking-display text-ink">
        {title}
      </h2>
      {body ? <p className="mt-3 text-base text-ink-muted leading-relaxed">{body}</p> : null}
    </div>
  )
}

function WelcomeStep({ onNext }) {
  /* No counted body copy here anymore — it used to promise "N quick
     things", but N came from `plan`, which depends on the async `schools`
     query (schoolNeedsTemplate isn't known until that resolves). Even after
     prefetching that query earlier (see OnboardingSetupPage) so the count is
     right by the time this ever mounts, a slow connection or the "take the
     tour again" reopen (AppShell) could still show a placeholder before
     flipping to the real number — a visible correction on a screen whose
     only job is a first impression. Title alone says enough; the actual
     steps introduce themselves as the teacher reaches each one. */
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
      <StepHeader eyebrow="Welcome to FlexEd" title="Let’s make some magic" />
      <div className="dialog-actions mt-2">
        <motion.button 
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          type="button" 
          className="btn btn-primary ml-auto" 
          onClick={onNext}
        >
          Get started <ArrowRight size={14} className="ml-1.5" aria-hidden="true" />
        </motion.button>
      </div>
    </motion.div>
  )
}

function SchoolStep({
  eyebrow,
  currentStep,
  totalSteps,
  school,
  setSchool,
  schools,
  schoolNeedsTemplate,
  templateFile,
  setTemplateFile,
  templateUrl,
  setTemplateUrl,
  saving,
  onBack,
  onNext,
}) {
  return (
    <div>
      <StepHeader
        eyebrow={eyebrow} currentStep={currentStep} totalSteps={totalSteps}
        title="Where are we teaching?"
        body="Sets your school calendar — which weeks are teaching weeks and which days are closed."
      />
      <SchoolSelect
        ariaLabel="School"
        id="onboarding-school"
        schools={schools}
        value={school}
        onChange={setSchool}
        emptyOption={{ value: '', label: 'Choose a school' }}
        inputClassName="neo-select min-h-touch w-full rounded-lg border border-edge bg-paper py-2.5 pl-3.5 pr-8 text-sm text-ink outline-none focus:border-accent"
      />
      {school ? (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mt-4 rounded-lg border border-edge bg-paper-sunken p-4 text-sm text-ink-soft">
          {schoolNeedsTemplate ? (
            <p>
              <span className="font-medium text-ink">Got a rigid district lesson plan format?</span> Toss it here, and the AI will handle the formatting for you.
            </p>
          ) : (
            <p>
              <span className="font-medium text-ink">A standard lesson-plan template is already on file</span> for this
              school. You will automatically use this standard template, but you can upload your own below to override it for your classes.
            </p>
          )}
          <UploadDropzone
            label="Upload file"
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
          />
        </motion.div>
      ) : null}
      
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
<div className="dialog-actions mt-6">
        <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} type="button" className="btn" onClick={onBack}>
          <ArrowLeft size={14} className="mr-1.5" aria-hidden="true" /> Back
        </motion.button>
        <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} type="button" className="btn btn-primary ml-auto" onClick={onNext} disabled={saving}>
          {saving ? <Loader2 size={14} className="mr-1.5 animate-spin" aria-hidden="true" /> : null}
          {saving ? 'Saving…' : 'Continue'}
        </motion.button>
      </div>
    </div>
  )
}
function ClassStep({ eyebrow, currentStep, totalSteps, cls, subject, setSubject, grade, setGrade, frameworks, saving, error, onBack, onNext }) {
  return (
    <div>
      <StepHeader
        eyebrow={eyebrow} currentStep={currentStep} totalSteps={totalSteps}
        title={<span>Confirm {cls.name || 'your class'}</span>}
        body="The course decides which standards get retrieved. Change it any time from My Classes."
      />
      <div className="flex flex-col gap-2">
        <motion.div animate={error ? { x: [-5, 5, -5, 5, 0] } : {}} transition={{ duration: 0.4 }}>
          <FrameworkPicker frameworks={frameworks} value={subject} onChange={(v) => { setSubject(v); if (error) onNext(); }} id="onboarding-framework" />
          {error && <p className="mt-1.5 text-xs text-mark font-medium px-1">Please select a course to continue</p>}
        </motion.div>
        <div className="mt-2">
          <label htmlFor="onboarding-grade" className="mb-1.5 block text-sm font-medium text-ink">
            Grade level
          </label>
          <p className="mb-1.5 text-xs text-ink-muted">Used to pick grade-appropriate standards and language.</p>
          <select
            id="onboarding-grade"
            value={grade}
            onChange={(e) => setGrade(e.target.value)}
            className="neo-select min-h-touch w-full rounded-lg border border-edge bg-paper py-2.5 pl-3.5 pr-8 text-sm text-ink outline-none focus:border-accent"
          >
            {GRADES.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="dialog-actions mt-6">
        <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} type="button" className="btn" onClick={onBack}>
          <ArrowLeft size={14} className="mr-1.5" aria-hidden="true" /> Back
        </motion.button>
        <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} type="button" className="btn btn-primary ml-auto" onClick={onNext} disabled={saving}>
          {saving ? <Loader2 size={14} className="mr-1.5 animate-spin" aria-hidden="true" /> : null}
          {saving ? 'Saving…' : 'Continue'}
        </motion.button>
      </div>
    </div>
  )
}
function DocumentsStep({ eyebrow, currentStep, totalSteps, cls, onBack, onNext }) {
  return (
    <div>
      <StepHeader
        eyebrow={eyebrow} currentStep={currentStep} totalSteps={totalSteps}
        title="Ground it in your materials"
        body="A pacing guide, syllabus, or curriculum map lets plans follow YOUR sequence and units, not a generic one. Optional — add these anytime from My Classes."
      />
      <Suspense fallback={<p className="text-xs text-ink-muted">Loading documents…</p>}>
        <ClassDocuments cls={cls} />
      </Suspense>
      <div className="dialog-actions mt-6">
        <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} type="button" className="btn" onClick={onBack}>
          <ArrowLeft size={14} className="mr-1.5" aria-hidden="true" /> Back
        </motion.button>
        <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} type="button" className="btn btn-primary ml-auto" onClick={onNext}>
          Continue <ArrowRight size={14} className="ml-1.5" aria-hidden="true" />
        </motion.button>
      </div>
    </div>
  )
}

function TipsStep({ eyebrow, currentStep, totalSteps, onBack, onNext }) {
  return (
    <div>
      <StepHeader eyebrow={eyebrow} currentStep={currentStep} totalSteps={totalSteps} title="Getting the most out of FlexEd" />
      {/* 0.1s per item over three items ran ~400ms with the last item still
          invisible — and SmoothHeight (which now wraps the steps) sizes the
          panel to the FINAL height immediately, so that delay showed as a
          panel opened to full size around a mostly empty box. Tightened to a
          ripple that finishes inside the step's own 280ms entrance instead of
          trailing well past it. */}
      <motion.ul
        initial="hidden"
        animate="visible"
        variants={{ visible: { transition: { staggerChildren: 0.045 } } }}
        className="flex flex-col gap-3"
      >
        {TIPS.map((tip) => (
          <motion.li
            key={tip.title}
            variants={{ hidden: { opacity: 0, y: 6 }, visible: { opacity: 1, y: 0 } }}
            transition={{ duration: 0.22 }}
            className="flex gap-3 rounded-lg border border-edge bg-paper-sunken p-3"
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/10">
              <tip.icon size={16} className="text-accent-text" aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-medium text-ink">{tip.title}</p>
              <p className="mt-0.5 text-xs text-ink-muted">{tip.body}</p>
            </div>
          </motion.li>
        ))}
      </motion.ul>
      <div className="dialog-actions mt-6">
        <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} type="button" className="btn" onClick={onBack}>
          <ArrowLeft size={14} className="mr-1.5" aria-hidden="true" /> Back
        </motion.button>
        <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} type="button" className="btn btn-primary ml-auto" onClick={onNext}>
          Continue <ArrowRight size={14} className="ml-1.5" aria-hidden="true" />
        </motion.button>
      </div>
    </div>
  )
}

function DoneStep({ finishing, onFinish }) {
  return (
    <motion.div 
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.4, type: "spring", bounce: 0.4 }}
      className="flex flex-col items-center py-4 text-center"
    >
      <motion.div 
        animate={{ rotate: [0, -10, 10, -10, 10, 0] }} 
        transition={{ duration: 0.6, delay: 0.2 }}
        className="text-accent-text"
      >
        <PartyPopper size={36} aria-hidden="true" />
      </motion.div>
      <h2 id="onboarding-title" className="mt-4 text-2xl font-bold tracking-display text-ink">
        You’re all set!
      </h2>
      <p className="mt-2 max-w-sm text-sm text-ink-muted">
        Everything here can be changed later from My Classes or Settings. Say what you need for the week, and let’s build it.
      </p>
      <motion.button
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        type="button"
        disabled={finishing}
        className="btn btn-primary mt-8 px-8 py-3 text-base"
        onClick={onFinish}
      >
        {finishing ? <Loader2 size={16} className="mr-2 animate-spin" aria-hidden="true" /> : null}
        {finishing ? 'Taking you there...' : 'Start planning 🚀'}
      </motion.button>
    </motion.div>
  )
}

export function ConfirmedCalendarReview({ schoolId }) {
  const { data: submission, isLoading } = useQuery({
    queryKey: ['schoolCalendarConfirmed', schoolId],
    queryFn: () => api.getConfirmedSchoolCalendar(schoolId),
    enabled: !!schoolId,
    retry: false,
  })

  if (isLoading) return <p className="mt-2 text-xs text-ink-muted">Loading calendar...</p>
  if (!submission || !submission.weeks) return null

  return (
    <div className="mt-2 max-w-sm rounded-lg bg-ok/10 p-3 text-xs">
      <p className="font-medium text-ok mb-2">Confirmed by your colleagues</p>
      <CalendarPreview weeks={submission.weeks} />
    </div>
  )
}
