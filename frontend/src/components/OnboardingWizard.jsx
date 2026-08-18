import { useEffect, useRef, useState } from 'react'
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

  // School & template step
  const [school, setSchool] = useState(cls?.school || '')
  const [templateFile, setTemplateFile] = useState(null)
  const templateFileRef = useRef(null)
  const [savingSchool, setSavingSchool] = useState(false)

  // Confirm-class step
  const [subject, setSubject] = useState(cls?.subject || '')
  const [grade, setGrade] = useState(cls?.grade || '11')
  const [savingClass, setSavingClass] = useState(false)

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
      if (templateFile && school) {
        await api.uploadSchoolTemplate(school, templateFile)
        qc.invalidateQueries({ queryKey: qk.schools })
        toast.success('Template submitted', 'We’ll train the AI on your school’s format.')
      }
      setStep((s) => s + 1)
    } catch (err) {
      toast.apiError('Could not save that', err)
    } finally {
      setSavingSchool(false)
    }
  }

  const saveClass = async () => {
    if (!subject) {
      toast.error('Pick a course first', 'It decides which standards your plans are grounded in.')
      return
    }
    setSavingClass(true)
    try {
      if (subject !== cls?.subject || grade !== cls?.grade) {
        await api.updateClass(cls.id, { subject, grade })
        qc.invalidateQueries({ queryKey: qk.classes })
      }
      setStep((s) => s + 1)
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
      onMouseDown={(e) => e.target === e.currentTarget && finish()}
    >
      {/* Same floating multi-hue wash as .app-blob (AppShell's own background),
          scoped to this dialog instead of the whole pane — the wizard is meant
          to feel like the same "place" as the hero/center panel, not a flatter
          system dialog dropped on top of it. */}
      <div
        className="relative overflow-hidden rounded-2xl"
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        style={{ width: 'min(560px, calc(100vw - 2rem))', maxHeight: 'calc(100vh - 4rem)' }}
      >
        <div className="onboarding-blob" aria-hidden="true" />
        <div
          // bg-paper-raised/30 (PlansPage's own glass recipe) read fine over a
          // quiet page; stacked with .dialog-scrim's own translucency, the
          // real page underneath showed straight through the gaps between
          // .onboarding-blob's own circles (see that rule's own comment) —
          // not something raising this element's own opacity alone could
          // ever fully fix, since the leak was behind it, not in it. Now
          // that .onboarding-blob has a solid base fill of its own, /65 here
          // is a real middle ground: still translucent enough to show the
          // blob's colour through the glass, opaque enough that nothing
          // behind ever has a legibility fight with the text in front of it.
          className={`dialog neo-panel relative flex max-h-[calc(100vh-4rem)] w-full flex-col overflow-y-auto rounded-2xl border border-white/10 bg-paper-raised/65 p-8 shadow-lg backdrop-blur-3xl saturate-[1.2]${closing ? ' is-closing' : ''}`}
        >
          <button
            type="button"
            className="btn-icon absolute right-4 top-4"
            onClick={finish}
            aria-label="Close"
            title="Skip for now"
          >
            <X size={16} aria-hidden="true" />
          </button>

          {step === 0 ? (
            <WelcomeStep onNext={() => setStep(1)} />
          ) : step === 1 ? (
            <SchoolStep
              school={school}
              setSchool={setSchool}
              schools={schools}
              schoolNeedsTemplate={schoolNeedsTemplate}
              templateFile={templateFile}
              setTemplateFile={setTemplateFile}
              templateFileRef={templateFileRef}
              saving={savingSchool}
              onBack={() => setStep(0)}
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
              onBack={() => setStep(1)}
              onNext={saveClass}
            />
          ) : step === 3 ? (
            <DocumentsStep cls={cls} onBack={() => setStep(2)} onNext={() => setStep(4)} />
          ) : step === 4 ? (
            <TipsStep onBack={() => setStep(3)} onNext={() => setStep(5)} />
          ) : (
            <DoneStep finishing={finishing} onFinish={finish} />
          )}
        </div>
      </div>
    </div>
  )
}

function StepHeader({ eyebrow, title, body }) {
  return (
    <div className="mb-6">
      {eyebrow ? (
        <p className="text-2xs font-medium uppercase tracking-wide text-accent-text">{eyebrow}</p>
      ) : null}
      <h2 id="onboarding-title" className="mt-1 text-xl font-semibold tracking-display text-ink">
        {title}
      </h2>
      {body ? <p className="mt-1.5 text-sm text-ink-muted">{body}</p> : null}
    </div>
  )
}

function WelcomeStep({ onNext }) {
  return (
    <div>
      <StepHeader
        eyebrow="Welcome"
        title="Let’s get your class set up"
        body="Three quick things — your school's template, your class, and any documents that help ground your plans — then a couple tips. Skippable at every step."
      />
      <div className="dialog-actions mt-2">
        <button type="button" className="btn btn-primary fa-press ml-auto" onClick={onNext}>
          Get started <ArrowRight size={14} className="ml-1.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

function SchoolStep({
  school,
  setSchool,
  schools,
  schoolNeedsTemplate,
  templateFile,
  setTemplateFile,
  templateFileRef,
  saving,
  onBack,
  onNext,
}) {
  return (
    <div>
      <StepHeader
        eyebrow="Step 1 of 3"
        title="Your school"
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
            onChange={(e) => setTemplateFile(e.target.files?.[0] || null)}
          />
          <button
            type="button"
            onClick={() => templateFileRef.current?.click()}
            className="neo-raised mt-3 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:text-ink"
          >
            <Upload size={13} aria-hidden="true" />
            {templateFile ? templateFile.name : 'Choose a template'}
          </button>
        </div>
      ) : null}
      <div className="dialog-actions mt-6">
        <button type="button" className="btn" onClick={onBack}>
          <ArrowLeft size={14} className="mr-1.5" aria-hidden="true" /> Back
        </button>
        <button type="button" className="btn btn-primary fa-press" onClick={onNext} disabled={saving}>
          {saving ? <Loader2 size={14} className="mr-1.5 animate-spin" aria-hidden="true" /> : null}
          {saving ? 'Saving…' : 'Continue'}
        </button>
      </div>
    </div>
  )
}

function ClassStep({ cls, subject, setSubject, grade, setGrade, frameworks, saving, onBack, onNext }) {
  return (
    <div>
      <StepHeader
        eyebrow="Step 2 of 3"
        title={`Confirm ${cls.name || 'your class'}`}
        body="The course decides which standards get retrieved. Change it any time from My Classes."
      />
      <div className="flex flex-col gap-2">
        <FrameworkPicker frameworks={frameworks} value={subject} onChange={setSubject} id="onboarding-framework" />
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
        <button type="button" className="btn" onClick={onBack}>
          <ArrowLeft size={14} className="mr-1.5" aria-hidden="true" /> Back
        </button>
        <button type="button" className="btn btn-primary fa-press" onClick={onNext} disabled={saving}>
          {saving ? <Loader2 size={14} className="mr-1.5 animate-spin" aria-hidden="true" /> : null}
          {saving ? 'Saving…' : 'Continue'}
        </button>
      </div>
    </div>
  )
}

function DocumentsStep({ cls, onBack, onNext }) {
  return (
    <div>
      <StepHeader
        eyebrow="Step 3 of 3"
        title="Ground it in your own materials"
        body="A pacing guide, syllabus, or curriculum map lets plans follow YOUR sequence and units, not a generic one. Optional — add these anytime from My Classes."
      />
      <ClassDocuments cls={cls} />
      <div className="dialog-actions mt-6">
        <button type="button" className="btn" onClick={onBack}>
          <ArrowLeft size={14} className="mr-1.5" aria-hidden="true" /> Back
        </button>
        <button type="button" className="btn btn-primary fa-press ml-auto" onClick={onNext}>
          Continue <ArrowRight size={14} className="ml-1.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

function TipsStep({ onBack, onNext }) {
  return (
    <div>
      <StepHeader eyebrow="A few things worth knowing" title="Getting the most out of FlexEd" />
      <ul className="flex flex-col gap-3">
        {TIPS.map((tip) => (
          <li key={tip.title} className="flex gap-3 rounded-lg border border-edge bg-paper-sunken p-3">
            <tip.icon size={18} className="mt-0.5 shrink-0 text-accent-text" aria-hidden="true" />
            <div>
              <p className="text-sm font-medium text-ink">{tip.title}</p>
              <p className="mt-0.5 text-xs text-ink-muted">{tip.body}</p>
            </div>
          </li>
        ))}
      </ul>
      <div className="dialog-actions mt-6">
        <button type="button" className="btn" onClick={onBack}>
          <ArrowLeft size={14} className="mr-1.5" aria-hidden="true" /> Back
        </button>
        <button type="button" className="btn btn-primary fa-press ml-auto" onClick={onNext}>
          Continue <ArrowRight size={14} className="ml-1.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

function DoneStep({ finishing, onFinish }) {
  return (
    <div className="flex flex-col items-center py-4 text-center">
      <PartyPopper size={28} className="text-accent-text" aria-hidden="true" />
      <h2 id="onboarding-title" className="mt-3 text-xl font-semibold tracking-display text-ink">
        You’re all set
      </h2>
      <p className="mt-1.5 max-w-sm text-sm text-ink-muted">
        Everything here can be changed later from My Classes or Settings. Say what you need for the
        week, and let’s build it.
      </p>
      <button
        type="button"
        className="btn btn-primary fa-press mt-6 w-full justify-center"
        onClick={onFinish}
        disabled={finishing}
      >
        {finishing ? <Loader2 size={14} className="mr-1.5 animate-spin" aria-hidden="true" /> : null}
        Start planning
      </button>
    </div>
  )
}
