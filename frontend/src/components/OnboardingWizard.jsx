import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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
  Upload,
  Link,
  X,
} from 'lucide-react'
import { api } from '../lib/api'
import { qk } from '../lib/queryKeys'
import { useAuth } from '../lib/authContext'
import { useToast } from '../lib/toastContext'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useExitTransition } from '../hooks/useExitTransition'
import { FrameworkPicker } from './FrameworkPicker'
import { SchoolSelect } from './SchoolSelect'
import { ClassDocuments } from '../pages/ClassPage'

// Same value/label shape as WelcomePage's own GRADES — each page that needs
// this list keeps its own copy already (ClassPage's AddClass has a third,
// numeric-only version), so this follows the existing convention rather than
// introducing a new shared-constants file for one small static array.
const GRADES = [
  { value: '0', label: 'K' },
  { value: '1', label: '1st' },
  { value: '2', label: '2nd' },
  { value: '3', label: '3rd' },
  { value: '4', label: '4th' },
  { value: '5', label: '5th' },
  { value: '6', label: '6th' },
  { value: '7', label: '7th' },
  { value: '8', label: '8th' },
  { value: '9', label: '9th' },
  { value: '10', label: '10th' },
  { value: '11', label: '11th' },
  { value: '12', label: '12th' },
]

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
function SmoothHeight({ children }) {
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
 * Gating (who sees this, and when) lives in the caller (AppShell.jsx) — this
 * component only renders what `open` and `cls` say to. `cls` is the account's
 * current/first class; there is nothing to confirm or upload against without
 * one, so AppShell never opens this before a class exists.
 */
export function OnboardingWizard({ open, onClose, cls }) {
  const toast = useToast()
  const qc = useQueryClient()
  const { refresh } = useAuth()
  const { mounted, closing } = useExitTransition(open, 220)
  const dialogRef = useRef(null)

  const [step, setStep] = useState(0)
  // +1/-1, read by the step's own enter animation (onboarding-step-enter,
  // base.css) to decide which side it slides in from — forward feels like
  // moving on, back feels like undoing, and a single direction for both
  // would read as the same motion regardless of which key the teacher
  // just pressed.
  const [direction, setDirection] = useState(1)
  const goTo = (next) => {
    setDirection(next > step ? 1 : -1)
    setStep(next)
  }

  // School & template step
  const [school, setSchool] = useState(cls?.school || '')
  const [templateFile, setTemplateFile] = useState(null)
  const [templateUrl, setTemplateUrl] = useState('')
  const templateFileRef = useRef(null)
  const [savingSchool, setSavingSchool] = useState(false)

  // Confirm-class step
  const [subject, setSubject] = useState(cls?.subject || '')
  const [grade, setGrade] = useState(cls?.grade || '11')
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
    setStep(0)
    setDirection(1)
    setSchool(cls?.school || '')
    setTemplateFile(null)
    setSubject(cls?.subject || '')
    setGrade(cls?.grade || '11')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cls?.id])

  useFocusTrap(dialogRef, { active: open, trap: true, onEscape: onClose })

  const selectedSchool = schools.find((s) => s.id === school)
  const schoolNeedsTemplate = school && selectedSchool && selectedSchool.template_status !== 'active'

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
      goTo(step + 1)
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
      if (subject !== cls?.subject || grade !== cls?.grade) {
        await api.updateClass(cls.id, { subject, grade })
        qc.invalidateQueries({ queryKey: qk.classes })
      }
      goTo(step + 1)
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
      // useAuth's `user` is plain component state (AuthProvider.jsx), not a
      // react-query cache entry — invalidating qk.me wouldn't touch it.
      // refresh() re-fetches /api/auth/me and updates it directly, which is
      // what AppShell's auto-open check (`!user.onboarding_seen_at`) reads.
      await refresh()
    } catch {
      // Non-fatal: worst case the wizard offers itself again next login.
    } finally {
      setFinishing(false)
      onClose()
    }
  }

  if (!mounted || !cls) return null

  return (
    <div
      className={`dialog-scrim${closing ? ' is-closing' : ''}`}
      style={{ position: 'absolute' }}
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
        <button
          type="button"
            className="absolute right-4 top-4 p-1.5 text-ink-muted transition-colors hover:text-ink rounded-md"
            onClick={finish}
            aria-label="Close"
            title="Skip for now"
          >
            <X size={20} aria-hidden="true" />
          </button>
          
          <AnimatePresence mode="wait" custom={direction}>
            <motion.div key={step} className="onboarding-step" style={{ '--onboarding-dir': direction }}>
              {step === 0 ? (
                <WelcomeStep onNext={() => goTo(1)} />
              ) : step === 1 ? (
                <SchoolStep
                  school={school}
                  setSchool={setSchool}
                  schools={schools}
                  schoolNeedsTemplate={schoolNeedsTemplate}
                  templateFile={templateFile}
                  setTemplateFile={setTemplateFile}
                  templateUrl={templateUrl}
                  setTemplateUrl={setTemplateUrl}
                  templateFileRef={templateFileRef}
                  saving={savingSchool}
                  onBack={() => goTo(0)}
                  onNext={saveSchool}
                />
              ) : step === 2 ? (
                <ClassStep
                  cls={cls}
                  subject={subject}
                  setSubject={setSubject}
                  grade={grade}
                  setGrade={setGrade}
                  frameworks={frameworks}
                  saving={savingClass}
                  error={classError}
                  onBack={() => goTo(1)}
                  onNext={saveClass}
                />
              ) : step === 3 ? (
                <DocumentsStep cls={cls} onBack={() => goTo(2)} onNext={() => goTo(4)} />
              ) : step === 4 ? (
                <TipsStep onBack={() => goTo(3)} onNext={() => goTo(5)} />
              ) : (
                <DoneStep finishing={finishing} onFinish={finish} />
              )}
            </motion.div>
          </AnimatePresence>
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
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
      <StepHeader
        eyebrow="Welcome to FlexEd"
        title="Let’s make some magic"
        body="Three quick things — your school's template, your class, and any documents that help ground your plans — then a couple pro tips. Skippable at every step."
      />
      <div className="dialog-actions mt-2">
        <motion.button 
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          type="button" 
          className="bg-white text-slate-900 shadow-lg hover:bg-slate-50 ml-auto inline-flex items-center gap-1.5 rounded-lg px-5 py-2.5 text-sm font-semibold transition-colors" 
          onClick={onNext}
        >
          Get started <ArrowRight size={14} className="ml-1.5" aria-hidden="true" />
        </motion.button>
      </div>
    </motion.div>
  )
}

function SchoolStep({
  school,
  setSchool,
  schools,
  schoolNeedsTemplate,
  templateFile,
  setTemplateFile,
  templateUrl,
  setTemplateUrl,
  templateFileRef,
  saving,
  onBack,
  onNext,
}) {
  return (
    <div>
      <StepHeader
        eyebrow="Step 1 of 3"
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
      {schoolNeedsTemplate ? (
        <div className="mt-4 rounded-lg border border-edge bg-paper-sunken p-4 text-sm text-ink-soft">
          <p>
            <span className="font-medium text-ink">No lesson-plan template on file yet</span> for this
            school. If you have a blank one (a Word doc or PDF), upload it and we’ll train the AI to
            export in your district’s exact format.
          </p>
          <input
            ref={templateFileRef}
            type="file"
            accept=".docx,.pdf"
            hidden
            onChange={(e) => {
              setTemplateFile(e.target.files?.[0] || null)
              if (e.target.files?.[0]) setTemplateUrl('')
            }}
          />
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={() => templateFileRef.current?.click()}
              className="neo-raised inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-ink-soft transition-colors hover:text-ink"
            >
              <Upload size={14} aria-hidden="true" />
              {templateFile ? templateFile.name : 'Upload file'}
            </button>
            <span className="text-xs text-ink-soft font-medium text-center sm:text-left">OR</span>
            <div className="relative flex-1">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-2.5">
                <Link size={13} className="text-ink-subtle" aria-hidden="true" />
              </div>
              <input
                type="url"
                placeholder="Paste Google Doc link"
                value={templateUrl}
                onChange={(e) => {
                  setTemplateUrl(e.target.value)
                  if (e.target.value) setTemplateFile(null)
                }}
                className="w-full rounded-lg border border-edge bg-paper py-2 pl-7 pr-3 text-sm text-ink outline-none transition-colors focus:border-accent placeholder:text-ink-subtle"
              />
            </div>
          </div>
        </div>
      ) : null}
      <div className="dialog-actions mt-6">
        <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} type="button" className="btn" onClick={onBack}>
          <ArrowLeft size={14} className="mr-1.5" aria-hidden="true" /> Back
        </motion.button>
        <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} type="button" className="bg-white text-slate-900 shadow-lg hover:bg-slate-50 inline-flex items-center gap-1.5 rounded-lg px-5 py-2.5 text-sm font-semibold transition-colors ml-auto" onClick={onNext} disabled={saving}>
          {saving ? <Loader2 size={14} className="mr-1.5 animate-spin" aria-hidden="true" /> : null}
          {saving ? 'Saving…' : 'Continue'}
        </motion.button>
      </div>
    </div>
  )
}

function ClassStep({ cls, subject, setSubject, grade, setGrade, frameworks, saving, error, onBack, onNext }) {
  return (
    <div>
      <StepHeader
        eyebrow="Step 2 of 3"
        title={<span>Confirm {cls.name || 'your class'}</span>}
        body="The course decides which standards get retrieved. Change it any time from My Classes."
      />
      <div className="flex flex-col gap-2">
        <motion.div animate={error ? { x: [-5, 5, -5, 5, 0] } : {}} transition={{ duration: 0.4 }}>
          <FrameworkPicker frameworks={frameworks} value={subject} onChange={(v) => { setSubject(v); if (error) onNext(); }} id="onboarding-framework" />
          {error && <p className="mt-1.5 text-xs text-mark font-medium px-1">Please select a course to continue</p>}
        </motion.div>
        <select
          aria-label="Grade"
          value={grade}
          onChange={(e) => setGrade(e.target.value)}
          className="neo-select min-h-touch w-full rounded-lg border border-edge bg-paper py-2.5 pl-2.5 pr-8 text-sm text-ink outline-none focus:border-accent"
        >
          {GRADES.map((g) => (
            <option key={g.value} value={g.value}>
              {g.label}
            </option>
          ))}
        </select>
      </div>
      <div className="dialog-actions mt-6">
        <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} type="button" className="btn" onClick={onBack}>
          <ArrowLeft size={14} className="mr-1.5" aria-hidden="true" /> Back
        </motion.button>
        <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} type="button" className="bg-white text-slate-900 shadow-lg hover:bg-slate-50 inline-flex items-center gap-1.5 rounded-lg px-5 py-2.5 text-sm font-semibold transition-colors ml-auto" onClick={onNext} disabled={saving}>
          {saving ? <Loader2 size={14} className="mr-1.5 animate-spin" aria-hidden="true" /> : null}
          {saving ? 'Saving…' : 'Continue'}
        </motion.button>
      </div>
    </div>
  )
}

function DocumentsStep({ cls, onBack, onNext }) {
  return (
    <div>
      <StepHeader
        eyebrow="Step 3 of 3"
        title="Ground it in your materials"
        body="A pacing guide, syllabus, or curriculum map lets plans follow YOUR sequence and units, not a generic one. Optional — add these anytime from My Classes."
      />
      <ClassDocuments cls={cls} />
      <div className="dialog-actions mt-6">
        <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} type="button" className="btn" onClick={onBack}>
          <ArrowLeft size={14} className="mr-1.5" aria-hidden="true" /> Back
        </motion.button>
        <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} type="button" className="bg-white text-slate-900 shadow-lg hover:bg-slate-50 inline-flex items-center gap-1.5 rounded-lg px-5 py-2.5 text-sm font-semibold transition-colors ml-auto" onClick={onNext}>
          Continue <ArrowRight size={14} className="ml-1.5" aria-hidden="true" />
        </motion.button>
      </div>
    </div>
  )
}

function TipsStep({ onBack, onNext }) {
  return (
    <div>
      <StepHeader eyebrow="A few things worth knowing" title="Getting the most out of FlexEd" />
      <motion.ul 
        initial="hidden" 
        animate="visible" 
        variants={{ visible: { transition: { staggerChildren: 0.1 } } }} 
        className="flex flex-col gap-3"
      >
        {TIPS.map((tip) => (
          <motion.li 
            key={tip.title} 
            variants={{ hidden: { opacity: 0, x: -10 }, visible: { opacity: 1, x: 0 } }}
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
        <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} type="button" className="bg-white text-slate-900 shadow-lg hover:bg-slate-50 inline-flex items-center gap-1.5 rounded-lg px-5 py-2.5 text-sm font-semibold transition-colors ml-auto" onClick={onNext}>
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
        className="mt-8 bg-white text-slate-900 shadow-xl hover:bg-slate-50 inline-flex items-center gap-2 rounded-xl px-8 py-3 text-base font-semibold transition-colors disabled:opacity-50"
        onClick={onFinish}
      >
        {finishing ? <Loader2 size={16} className="mr-2 animate-spin" aria-hidden="true" /> : null}
        {finishing ? 'Taking you there...' : 'Start planning 🚀'}
      </motion.button>
    </motion.div>
  )
}
