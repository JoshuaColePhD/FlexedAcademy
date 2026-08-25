import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate, Link, NavLink } from 'react-router-dom'
import { ArrowLeft, CreditCard, Download, FileText, HardDrive, Loader2, Settings, Sparkles, Upload } from 'lucide-react'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'
import { useConfirm } from '../lib/confirmContext'
import { useAuth } from '../lib/authContext'
import { useBilling } from '../lib/billingContext'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { qk } from '../lib/queryKeys'
import { errorParts } from '../lib/apiError'
import { useTheme } from '../hooks/useTheme'
import { useDesignSkin } from '../hooks/useDesignSkin'
import { PendingCalendarReview } from '../components/PendingCalendarReview'
import { SchoolSelect } from '../components/SchoolSelect'
import { Tooltip } from '../components/Tooltip'
import { AccountMenu } from '../components/AccountMenu'
import { openOnboardingWizard } from '../lib/onboardingWizardBus'

/* Account-level settings — split out of ClassPage (which used to be "Classes &
 * settings", one page for two different things). Everything here is about the
 * teacher's account: name, school default, custom instructions, password,
 * billing, and account safety. Per-class management (the list itself, a
 * class's own framework/grade/documents) stays on ClassPage — that page is
 * "My classes" now, this one is "Settings," matching the two separate links
 * in the account menu (AccountMenu.jsx) instead of both landing on the same
 * long scroll.
 */

const CUSTOM_INSTRUCTIONS_MAX = 2000

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'preferences', label: 'Preferences' },
  { id: 'account', label: 'Account & Security' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'billing', label: 'Billing' },
  { id: 'advanced', label: 'Advanced' },
]

/* The neomorphic/skeuomorphic toggle (useDesignSkin.js) — added after the
 * sign-in form's own contrast problems traced back to neomorphism's core
 * mechanic (a soft dual light+dark shadow, which only reads clearly when
 * foreground and background sit close in value). Rather than just
 * replacing one skin with the other everywhere, this makes it a real
 * setting so it can actually be compared side by side instead of taken on
 * faith. Two buttons, not a single toggle switch — a switch implies an
 * on/off state ("neomorphism enabled: yes/no"), and this is a choice
 * between two distinct looks, not a binary flag. */
function DesignSkinSection() {
  const { skin, setSkin } = useDesignSkin()
  const OPTIONS = [
    { value: 'neo', label: 'Neomorphic', hint: 'Soft embossed shadows, cream & rose' },
    { value: 'skeu', label: 'Skeuomorphic', hint: 'Real shadows, crisp white & slate' },
  ]
  return (
    <div className="mt-5">
      <h2 className="text-sm font-semibold text-ink">Appearance</h2>
      <p className="mt-1 text-xs text-ink-muted">
        How raised surfaces and panels look throughout the app — try both, keep whichever reads
        better to you.
      </p>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setSkin(opt.value)}
            aria-pressed={skin === opt.value}
            className={`neo-raised flex flex-col items-start gap-0.5 rounded-xl px-3.5 py-3 text-left transition-colors focus-visible:ring-2 focus-visible:ring-accent outline-none ${
              skin === opt.value ? 'neo-inset text-accent-text' : 'text-ink-soft'
            }`}
          >
            <span className="text-sm font-medium">{opt.label}</span>
            <Tooltip content={opt.hint}>
              <span className="text-2xs text-ink-muted flex items-center gap-1 cursor-help underline decoration-dotted">{opt.hint.split(',')[0]}</span>
            </Tooltip>
          </button>
        ))}
      </div>
    </div>
  )
}


function AiGenerationPreferences({ value, onSaved }) {
  const toast = useToast()
  const [saving, setSaving] = useState(false)

  const getLevel = (tag, defaultLevel) => {
    const regex = new RegExp(`\[${tag}: (.*?)\]`, 'i')
    const match = (value || '').match(regex)
    return match ? match[1] : defaultLevel
  }
  
  const getProfile = () => {
    const match = (value || '').match(/\[Classroom Profile: (.*?)\]/is)
    return match ? match[1].trim() : ''
  }

  const length = getLevel('Response Length', 'Medium')
  const detail = getLevel('Level of Detail', 'Standard')
  const examples = getLevel('Specific Examples', 'Some')
  const differentiation = getLevel('Differentiation', 'None')
  const [profileText, setProfileText] = useState(getProfile())

  const handleSelect = async (tag, level, customProfileText = null) => {
    setSaving(true)
    
    let baseInstructions = (value || '')
      .replace(/\[Response Length: .*?\].*?\n?/g, '')
      .replace(/\[Level of Detail: .*?\].*?\n?/g, '')
      .replace(/\[Specific Examples: .*?\].*?\n?/g, '')
      .replace(/\[Differentiation: .*?\].*?\n?/g, '')
      .replace(/\[Classroom Profile: .*?\].*?\n?/gs, '')
      .replace(/\[NOTE: These preferences only apply to the narrative.*?\].*?\n?/g, '')
      .trim()
      
    const activeTags = []
    
    const newLength = tag === 'Response Length' ? level : length
    const newDetail = tag === 'Level of Detail' ? level : detail
    const newExamples = tag === 'Specific Examples' ? level : examples
    const newDiff = tag === 'Differentiation' ? level : differentiation
    const newProfile = tag === 'Classroom Profile' ? customProfileText : profileText

    if (newLength !== 'Medium') {
      activeTags.push(`[Response Length: ${newLength}] ${newLength === 'Short' ? 'Keep responses brief and to the point.' : 'Provide extended, comprehensive answers.'}`)
    }
    if (newDetail !== 'Standard') {
      activeTags.push(`[Level of Detail: ${newDetail}] ${newDetail === 'Concise' ? 'Focus strictly on the main points without extra fluff.' : 'Break down concepts thoroughly and exhaustively.'}`)
    }
    if (newExamples !== 'Some') {
      activeTags.push(`[Specific Examples: ${newExamples}] ${newExamples === 'Few' ? 'Use examples only when strictly necessary.' : 'Use abundant, specific, real-world examples.'}`)
    }
    if (newDiff !== 'None') {
      activeTags.push(`[Differentiation: ${newDiff}] ${newDiff === 'Light' ? 'Provide brief scaffolding tips in the margins for the specified classroom profile.' : 'Actively generate alternative/modified versions of the assignments and assessments for the specified classroom profile.'}`)
    }
    if (newProfile) {
      activeTags.push(`[Classroom Profile: ${newProfile}]`)
    }
    
    if (activeTags.length > 0) {
      activeTags.push(`[NOTE: These preferences only apply to the narrative lesson plan and activities. Do NOT alter or abbreviate the text of the academic standards themselves.]`)
      baseInstructions += (baseInstructions ? '\n\n' : '') + activeTags.join('\n')
    }

    try {
      await api.updateMe({ customInstructions: baseInstructions })
      if (tag !== 'Classroom Profile') toast.success(`Updated ${tag}`)
      else toast.success('Saved Classroom Profile')
      onSaved?.()
    } catch (err) {
      toast.apiError('Could not save preference', err)
    } finally {
      setSaving(false)
    }
  }

  const Slider = ({ title, description, tag, options, currentValue }) => (
    <div className="mt-5">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <p className="mt-1 text-xs text-ink-muted">{description}</p>
      <div className="mt-2 flex gap-2">
        {options.map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => handleSelect(tag, opt)}
            disabled={saving}
            aria-pressed={currentValue === opt}
            className={`neo-raised flex-1 py-2 text-center text-sm font-medium rounded-lg transition-colors focus-visible:ring-2 focus-visible:ring-accent outline-none ${
              currentValue === opt ? 'neo-inset text-accent-text' : 'text-ink-soft hover:bg-paper-sunken'
            }`}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  )

  return (
    <div className="mt-6 border-t border-edge pt-4">
      <h2 className="text-sm font-semibold text-ink">AI Generation Criteria</h2>
      <p className="mt-1 text-xs text-ink-muted">Control the length, detail, and tone of the AI's outputs.</p>
      
      <Slider 
        title="Response Length" 
        description="How long the AI's generated narratives and plans should be."
        tag="Response Length"
        options={['Short', 'Medium', 'Long']}
        currentValue={length}
      />
      <Slider 
        title="Level of Detail" 
        description="How thoroughly concepts and activities are broken down."
        tag="Level of Detail"
        options={['Concise', 'Standard', 'Exhaustive']}
        currentValue={detail}
      />
      <Slider 
        title="Specific Examples" 
        description="How often the AI should invent specific, real-world examples."
        tag="Specific Examples"
        options={['Few', 'Some', 'Many']}
        currentValue={examples}
      />
      
      <div className="mt-8 border-t border-edge pt-4">
        <h2 className="text-sm font-semibold text-ink">Differentiation & IEPs</h2>
        <p className="mt-1 text-xs text-ink-muted">Tailor the AI's lesson plans to specific student needs in your classroom.</p>
        
        <div className="mt-4">
          <label className="text-xs font-semibold text-ink">Classroom Profile</label>
          <textarea
            value={profileText}
            onChange={(e) => setProfileText(e.target.value)}
            rows={2}
            placeholder="e.g. 3 students with ADHD, 2 ELL students, 1 visually impaired"
            className="neo-inset mt-1 w-full resize-y rounded-lg bg-paper-raised/60 backdrop-blur-2xl px-3 py-2 text-sm text-ink outline-none focus:ring-1 focus:ring-accent"
          />
          <div className="mt-1 flex justify-end">
             <button
              type="button"
              onClick={() => handleSelect('Classroom Profile', null, profileText)}
              disabled={saving}
              className="fa-press neo-raised rounded-lg bg-paper-raised px-3 py-1.5 text-xs font-medium text-ink hover:bg-paper-sunken focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-edge outline-none disabled:cursor-not-allowed disabled:opacity-40"
            >
              Save Profile
            </button>
          </div>
        </div>

        <Slider 
          title="Differentiation Level" 
          description="How aggressively the AI should adapt the lesson for your Classroom Profile."
          tag="Differentiation"
          options={['None', 'Light', 'Heavy']}
          currentValue={differentiation}
        />
      </div>
    </div>
  )
}



function CustomInstructions({ value, onSaved }) {
  const toast = useToast()
  const [text, setText] = useState(value || '')
  const [saved, setSaved] = useState(value || '')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setText(value || '')
    setSaved(value || '')
  }, [value])

  const dirty = text !== saved

  const save = async () => {
    setSaving(true)
    const previousSaved = saved
    setSaved(text) // Optimistic update
    try {
      await api.updateMe({ customInstructions: text })
      toast.success('Saved')
      onSaved?.()
    } catch (err) {
      setSaved(previousSaved) // Rollback
      toast.apiError('Could not save your instructions', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-5">
      <h2 className="text-sm font-semibold text-ink">Custom instructions</h2>
      <p className="mt-1 text-xs text-ink-muted">
        Style and format preferences applied to every plan and chat — how you like activities
        phrased, a tone to avoid, a format quirk your district expects. Standards still come only
        from retrieval; this can’t add or change a code.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={CUSTOM_INSTRUCTIONS_MAX}
        rows={4}
        placeholder="e.g. Keep Do Now activities under 5 minutes. Avoid group work on Fridays."
        className="neo-inset mt-2 w-full resize-y rounded-lg bg-paper-raised/60 backdrop-blur-2xl px-3 py-2 text-sm text-ink outline-none focus:ring-1 focus:ring-accent"
      />
      <div className="mt-1 flex items-center justify-between">
        <span className="text-2xs text-ink-muted">
          {text.length} / {CUSTOM_INSTRUCTIONS_MAX}
        </span>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className="fa-press neo-raised rounded-lg bg-paper-raised px-3 py-2 text-sm font-medium text-ink hover:bg-paper-sunken focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-edge outline-none disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

/* ── school ─────────────────────────────────────────────────────────────────
   Which calendar a class's week board and generated plans are built against
   (backend/schoolcal.py, backend/prompts.py's calendar_context) — and,
   longer term, which district's lesson plan template a generated week
   downloads as (backend docx_build.py), once a second school actually has
   one of its own. Blur/select-to-save like the name field above, not an
   explicit Save button like custom instructions — there's nothing to lose
   to an accidental change here the way there is with half a retyped
   paragraph, it's a single choice from a list.

   Reads from the `schools` table (db.py migration 23) via GET /api/schools,
   the same curated, admin-added list onboarding's own picker uses — not a
   hardcoded dict, so a school added there just appears here too. */
function SchoolPicker({ value, onSaved }) {
  const toast = useToast()
  const schoolsState = useQuery({ queryKey: qk.schools, queryFn: () => api.listSchools() })
  const [saving, setSaving] = useState(false)
  const schools = schoolsState.data || []
  const selected = schools.find((s) => s.id === value) || null

  const commit = async (school) => {
    if (!school || school === value) return
    setSaving(true)
    // Optimistic update: onSaved isn't passed value, so we just optimistically fire it if it causes a refetch
    // Wait, onSaved isn't enough, we must actually call updateMe, and if it fails, maybe refetch or show error.
    try {
      await api.updateMe({ school })
      toast.success('Saved')
      onSaved?.()
    } catch (err) {
      toast.apiError('Could not save your school', err)
    } finally {
      setSaving(false)
    }
  }

  const fileRef = useRef(null)
  const [uploading, setUploading] = useState(false)

  const uploadCalendar = async (e) => {
    const file = e.target.files?.[0]
    if (!file || !selected) return
    setUploading(true)
    try {
      await api.uploadSchoolCalendar(selected.name, { file })
      toast.success('Calendar submitted', 'It is now applied to this school.')
      schoolsState.refetch()
    } catch (err) {
      toast.apiError('Could not upload the calendar', err)
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="mt-5">
      <h2 className="text-sm font-semibold text-ink">School</h2>
      {/* Was "Sets your school calendar" — true when school lived only on
          the account (migration 22). Now that a class can pin its own
          (migration 25), this only decides what a NEW class starts as; an
          existing one keeps whatever it already has regardless of this
          setting. Said plainly rather than left to be discovered the first
          time changing this here doesn't move an existing class's weeks. */}
      <p className="mt-1 text-xs text-ink-muted">
        The default calendar for a new class — which weeks are teaching weeks and which days
        are closed.
        {schools.length > 1 ? ' Change one class’s own school from its Edit panel below.' : ''}
      </p>
      <SchoolSelect
        ariaLabel="School"
        schools={schools}
        value={value || ''}
        disabled={saving}
        onChange={commit}
        className="mt-2 w-full max-w-xs"
        /* Always available, not gated behind schools.length — see
           WelcomePage.jsx's own comment on why this id works with no
           schools table row at all (backend/schoolcal.py's
           NO_CALENDAR_SCHOOL_ID special-cases it directly, synthesizing
           dateless weeks instead of reading a calendar file). */
      />
      {selected ? (
        <div className="mt-2 flex items-center gap-2">
          {selected.template_status === 'pending' ? (
            <span className="inline-flex items-center rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-600/20">
              Template Status: Training AI...
            </span>
          ) : selected.template_status === 'active' ? (
            <span className="inline-flex items-center rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-600/20">
              Template Status: Active
            </span>
          ) : null}
        </div>
      ) : null}
      {/* A school's row and its calendar are added in different places on
          purpose (see GET /api/schools) — so one can exist with no year
          behind it, and choosing it silently empties the week board, the
          composer's week dropdown and the week the model is told about.
          Said out loud here, after the fact, because the row is still a
          legitimate choice: it just can't schedule anything yet. */}
      {selected?.has_pending_calendar ? (
        <PendingCalendarReview schoolId={selected.id} onDecided={() => schoolsState.refetch()} />
      ) : selected && selected.has_calendar === false ? (
        /* A tinted banner rather than plain small red text — this is a
           genuine "come do something" state (no calendar means every plan
           for this class builds worse until one is added), which is what
           --mark-tint/--mark already exist to carry as a status colour, not
           just a flag on prose. */
        <div className="mt-2 max-w-sm rounded-lg border border-mark/20 bg-mark-tint p-3">
          <p className="text-xs text-mark">
            No calendar is on file for {selected.name} yet, so weeks can’t be scheduled — plans
            will build without a week or a closure to work from until one is added.
          </p>
          <div className="mt-3">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="neo-raised inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-paper-inset disabled:opacity-50"
            >
              {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
              {uploading ? 'Reading…' : 'Upload Calendar'}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.docx"
              className="hidden"
              onChange={uploadCalendar}
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}

/* ── change password ───────────────────────────────────────────────────────
   Hidden for a Google-only account (no password_hash — see /api/auth/me's
   has_password) rather than shown and left to fail on "current password":
   there's nothing correct to type into that field, and the real recovery
   path for those accounts is the Google button on /login, not this form. */
function ChangePassword() {
  const toast = useToast()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (next.length < 8) {
      toast.error('Use at least 8 characters for the new password.')
      return
    }
    if (next !== confirm) {
      toast.error('Those two don’t match.')
      return
    }
    setSaving(true)
    try {
      await api.changePassword(current, next)
      toast.success('Password changed')
      setCurrent('')
      setNext('')
      setConfirm('')
    } catch (err) {
      toast.apiError('Could not change your password', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="mt-2 flex flex-wrap items-end gap-2">
      <div className="min-w-0 flex-1 basis-40">
        <label className="mb-1 block text-xs text-ink-muted" htmlFor="current-password">
          Current password
        </label>
        <input
          id="current-password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          className="neo-inset w-full rounded-lg bg-paper-raised/60 backdrop-blur-2xl px-2.5 py-1.5 text-sm text-ink outline-none focus:ring-1 focus:ring-accent"
        />
      </div>
      <div className="min-w-0 flex-1 basis-40">
        <label className="mb-1 block text-xs text-ink-muted" htmlFor="new-password-settings">
          New password
        </label>
        <input
          id="new-password-settings"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          className="neo-inset w-full rounded-lg bg-paper-raised/60 backdrop-blur-2xl px-2.5 py-1.5 text-sm text-ink outline-none focus:ring-1 focus:ring-accent"
        />
      </div>
      <div className="min-w-0 flex-1 basis-40">
        <label className="mb-1 block text-xs text-ink-muted" htmlFor="confirm-password-settings">
          Confirm new password
        </label>
        <input
          id="confirm-password-settings"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="neo-inset w-full rounded-lg bg-paper-raised/60 backdrop-blur-2xl px-2.5 py-1.5 text-sm text-ink outline-none focus:ring-1 focus:ring-accent"
        />
      </div>
      <button
        type="submit"
        disabled={saving || !current || !next}
        className="fa-press neo-raised rounded-lg bg-paper-raised px-3 py-2 text-sm font-medium text-ink hover:bg-paper-sunken disabled:cursor-not-allowed disabled:opacity-40"
      >
        {saving ? 'Saving…' : 'Change password'}
      </button>
    </form>
  )
}

function formatRenewal(iso) {
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch {
    return null
  }
}

/* Subscription state and usage. Hidden entirely while billing is unconfigured,
 * same reasoning as AccountMenu's own version. */
function BillingSection() {
  const { entitlement, billingEnabled, openPaywall, manage, busy } = useBilling()

  if (!billingEnabled || !entitlement) return null

  // Usage (tokens_used/token_cap) moved to the admin accounts panel — one
  // place to see who's using what, not a number every teacher's own
  // settings page has to carry. The teacher's OWN usage now also shows in
  // the account menu popover (AccountMenu.jsx) — this section stays about
  // subscription status/renewal, not a second usage bar right below it.
  const renews = entitlement.subscribed && entitlement.period_end ? formatRenewal(entitlement.period_end) : null

  return (
    <div className="neo-panel flex flex-wrap items-center justify-between gap-2 rounded-xl bg-paper-raised/60 backdrop-blur-2xl p-3">
      <div>
        <p className="text-sm font-medium text-ink">
          {entitlement.subscribed ? 'Subscribed' : 'Free'}
        </p>
        {renews ? <p className="text-xs text-ink-muted">Renews {renews}</p> : null}
      </div>
      <button
        type="button"
        onClick={entitlement.subscribed ? manage : openPaywall}
        disabled={busy}
        className="fa-press neo-raised inline-flex items-center gap-1.5 rounded-lg bg-paper-raised px-3 py-2 text-sm font-medium text-ink hover:bg-paper-sunken disabled:cursor-not-allowed disabled:opacity-50"
      >
        {entitlement.subscribed ? (
          <CreditCard size={14} aria-hidden="true" />
        ) : (
          <Sparkles size={14} aria-hidden="true" />
        )}
        {busy ? 'Opening…' : entitlement.subscribed ? 'Manage subscription' : 'Subscribe'}
      </button>
    </div>
  )
}

/* Lets a teacher connect (or disconnect) Google Drive ahead of time, instead
 * of only discovering "Connect Google Drive" mid-export inside ShareDialog.
 * Same status/connect/disconnect calls ShareDialog already uses
 * (api.driveStatus/driveConnectUrl/driveDisconnect — backend/routes/drive.py)
 * — this is just a second, proactive entry point onto the same connection.
 * Hidden entirely when the account itself has no Drive integration
 * configured, same reasoning as BillingSection above. */
function GoogleDriveSection() {
  const { classId } = useParams()
  const toast = useToast()
  const confirm = useConfirm()
  const driveState = useQuery({ queryKey: qk.driveStatus, queryFn: () => api.driveStatus() })
  const [disconnecting, setDisconnecting] = useState(false)

  if (!driveState.data?.enabled) return null

  const connected = driveState.data.connected

  const connect = () => {
    // return_to has to be a real route — bare "/settings" isn't one
    // (Settings only ever exists nested under a class, /c/:classId/settings)
    // and Google redirecting back to it landed on this app's own 404
    // instead of back in Settings. There's no plan to strand the teacher
    // back at here (unlike ShareDialog's own connect()), just Settings
    // itself, so the class-scoped Settings path is the whole answer.
    window.location.assign(api.driveConnectUrl(`/c/${classId}/settings`))
  }

  const disconnect = async () => {
    const ok = await confirm({
      title: 'Disconnect Google Drive?',
      body: 'Plans already saved to Drive stay there — this just stops the app from creating or sharing new ones until you reconnect.',
      confirmLabel: 'Disconnect',
      tone: 'danger',
    })
    if (!ok) return
    setDisconnecting(true)
    try {
      await api.driveDisconnect()
      driveState.refetch()
      toast.success('Disconnected Google Drive')
    } catch (err) {
      toast.apiError('Could not disconnect Google Drive', err)
    } finally {
      setDisconnecting(false)
    }
  }

  return (
    <div className="mt-5">
      <h2 className="text-sm font-semibold text-ink">Google Drive</h2>
      <p className="mt-1 text-xs text-ink-muted">
        Connect once so exporting a plan or quiz can save a real, editable Google Doc straight to
        your Drive — and share it with a colleague's account, even one at a different school.
      </p>
      <div className="neo-panel mt-2 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-paper-raised/60 backdrop-blur-2xl p-3">
        <div className="flex items-center gap-2">
          <HardDrive size={16} className={connected ? 'text-ok' : 'text-ink-muted'} aria-hidden="true" />
          <p className="text-sm font-medium text-ink">{connected ? 'Connected' : 'Not connected'}</p>
        </div>
        <button
          type="button"
          onClick={connected ? disconnect : connect}
          disabled={disconnecting}
          className={
            connected
              ? 'neo-raised shrink-0 rounded-lg px-3 py-2 text-sm font-medium text-mark transition-colors hover:bg-mark-tint disabled:cursor-not-allowed disabled:opacity-50'
              : 'fa-press neo-raised inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-paper-raised px-3 py-2 text-sm font-medium text-ink hover:bg-paper-sunken disabled:cursor-not-allowed disabled:opacity-50'
          }
        >
          {connected ? (disconnecting ? 'Disconnecting…' : 'Disconnect') : 'Connect Google Drive'}
        </button>
      </div>
    </div>
  )
}

function AccountSafety() {
  const { user, signOutEverywhere, deleteAccount } = useAuth()
  const confirm = useConfirm()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deletePassword, setDeletePassword] = useState('')
  const [deleting, setDeleting] = useState(false)

  const doSignOutEverywhere = async () => {
    const ok = await confirm({
      title: 'Sign out of every device?',
      body: 'This ends every session on every device signed into this account — including this one. You’ll need to log in again here too.',
      confirmLabel: 'Sign out everywhere',
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      await signOutEverywhere()
    } catch (err) {
      toast.apiError('Could not sign out of your other devices', err)
      setBusy(false)
    }
    // On success there is no "finally" to reach — signOutEverywhere() flips
    // auth status to anon, which unmounts this whole page.
  }

  // An inline panel, not useConfirm() — this is the one confirm that needs a
  // form field (the re-entered password), which the generic yes/no dialog
  // has no room for. Same click-to-reveal shape as ClassRow's edit panel.
  const doDelete = async () => {
    setDeleting(true)
    try {
      await deleteAccount(deletePassword || undefined)
    } catch (err) {
      toast.apiError('Could not delete your account', err)
      setDeleting(false)
    }
    // On success: same as sign-out-everywhere, deleteAccount() itself flips
    // auth status to anon and this page unmounts.
  }

  return (
    <div className="mt-5">
      <h2 className="text-sm font-semibold text-ink">Account safety</h2>
      <div className="neo-panel mt-2 divide-y divide-edge rounded-xl bg-paper-raised/60 backdrop-blur-2xl">
        <div className="flex flex-wrap items-center justify-between gap-3 p-3">
          <div>
            <p className="text-sm font-medium text-ink">Download my data</p>
            <p className="text-xs text-ink-muted">
              Every plan, chat, class and pacing guide you’ve put in, as one JSON file.
            </p>
          </div>
          <a
            href={api.accountExportUrl()}
            download
            className="neo-raised inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-paper-sunken"
          >
            <Download size={14} aria-hidden="true" /> Download
          </a>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 p-3">
          <div>
            <p className="text-sm font-medium text-ink">Sign out of all devices</p>
            <p className="text-xs text-ink-muted">
              Forgot a shared computer, or think someone else has access? This ends every session at once.
            </p>
          </div>
          <button
            type="button"
            onClick={doSignOutEverywhere}
            disabled={busy}
            className="neo-raised shrink-0 rounded-lg px-3 py-2 text-sm font-medium text-mark transition-colors hover:bg-mark-tint disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Signing out…' : 'Sign out everywhere'}
          </button>
        </div>
        <div className="flex flex-col gap-3 p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-mark">Delete my account</p>
              <p className="text-xs text-ink-muted">
                Every plan, class, chat and document — gone for good. This can’t be undone.
              </p>
            </div>
            {deleteOpen ? null : (
              <button
                type="button"
                onClick={() => setDeleteOpen(true)}
                className="btn btn-danger shrink-0"
              >
                Delete my account
              </button>
            )}
          </div>
          {deleteOpen ? (
            <div className="flex flex-wrap items-end gap-2">
              {user?.has_password ? (
                <div className="min-w-0 flex-1 basis-40">
                  <label className="mb-1 block text-xs text-ink-muted" htmlFor="delete-account-password">
                    Current password
                  </label>
                  <input
                    id="delete-account-password"
                    type="password"
                    autoComplete="current-password"
                    value={deletePassword}
                    onChange={(e) => setDeletePassword(e.target.value)}
                    className="neo-inset w-full rounded-lg bg-paper-raised/60 backdrop-blur-2xl px-2.5 py-1.5 text-sm text-ink outline-none focus:ring-1 focus:ring-accent"
                  />
                </div>
              ) : (
                <p className="text-xs text-ink-muted">
                  This account signs in with Google — no password needed, just confirm below.
                </p>
              )}
              <button
                type="button"
                onClick={doDelete}
                disabled={deleting || (user?.has_password && !deletePassword)}
                className="btn btn-danger disabled:cursor-not-allowed disabled:opacity-40"
              >
                {deleting ? 'Deleting…' : 'Permanently delete'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setDeleteOpen(false)
                  setDeletePassword('')
                }}
                className="neo-raised rounded-lg px-3 py-2 text-sm font-medium text-ink-muted transition-colors hover:text-ink"
              >
                Cancel
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/* For whoever is debugging the app, not for a teacher planning a week — and it
   is a teacher who was being shown the model name, the plans directory, the
   builder's path on disk and whether the API key is set. "Shut by default" is
   not the same as "not there".

   Dev builds only. In production the same payload is one authenticated curl of
   /api/health, which is where a person debugging the app actually is; the
   unauthenticated answer is now liveness alone (see routes/misc.py). */
function Diagnostics() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => api.health(),
    retry: false,
    enabled: import.meta.env.DEV,
  })
  const h = health.data

  if (!import.meta.env.DEV) return null

  return (
    <details className="neo-panel mt-2 overflow-hidden rounded-xl bg-paper-raised/60 backdrop-blur-2xl">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-paper-sunken">
        Diagnostics
      </summary>
      <div className="border-t border-edge px-3 py-2">
        {health.isError ? (
          <p className="text-sm text-mark">{errorParts(health.error).message}</p>
        ) : !h ? (
          <p className="text-sm text-ink-muted">Checking…</p>
        ) : (
          <dl className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
            {[
              ['Model', h.model],
              ['Template', h.builder_template],
              ['Standards indexed', h.chunks],
              ['Relevance floor', h.retrieval_floor],
              ['Database', h.database],
              ['API key', h.api_key_set ? 'set' : 'missing'],
            ].map(([k, v]) => (
              <div className="flex items-center justify-between gap-3 py-1" key={k}>
                <dt className="text-xs text-ink-muted">{k}</dt>
                <dd className="truncate font-mono text-xs text-ink">{String(v)}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </details>
  )
}

function Toggle({ checked, onChange, label, description }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div>
        <p className="text-sm font-medium text-ink">{label}</p>
        {description && <p className="text-xs text-ink-muted">{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 ${
          checked ? 'bg-accent' : 'bg-edge-strong'
        }`}
      >
        <span
          aria-hidden="true"
          className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-paper shadow-md ring-0 transition duration-200 ease-in-out ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  )
}

function IntegrationPlaceholder({ name, description, icon }) {
  return (
    <div className="neo-panel mt-2 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-paper-raised/60 backdrop-blur-2xl p-3 opacity-60 grayscale-[0.5]">
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-paper-inset text-ink-muted">
          {icon}
        </div>
        <div>
          <p className="text-sm font-medium text-ink flex items-center gap-2">
            {name}
            <span className="inline-flex items-center rounded-md bg-paper-sunken px-1.5 py-0.5 text-[10px] font-medium text-ink uppercase tracking-wider">
              Upcoming
            </span>
          </p>
          <p className="text-xs text-ink-muted">{description}</p>
        </div>
      </div>
      <button
        type="button"
        disabled
        className="neo-raised inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-ink-muted transition-colors bg-paper-inset cursor-not-allowed"
      >
        Coming Soon
      </button>
    </div>
  )
}

export function SettingsPage() {
  const qc = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const { classId } = useParams()
  const classPath = classId ? `/c/${classId}` : ''
  const meState = useQuery({ queryKey: qk.me, queryFn: () => api.me() })

  const [teacher, setTeacher] = useState('')
  const [savedName, setSavedName] = useState('')
  const [activeTab, setActiveTab] = useState('general')

  // Placeholder states
  const [outputFormat, setOutputFormat] = useState('narrative')
  const [aiTone, setAiTone] = useState('encouraging')
  const [autoSave, setAutoSave] = useState(true)
  const [classifyPlan, setClassifyPlan] = useState(false)
  const { mode, setMode } = useTheme()
  const [fontSize, setFontSize] = useState('normal')
  const [highContrast, setHighContrast] = useState(false)
  const [betaFeatures, setBetaFeatures] = useState(false)

  const scrollContainerRef = useRef(null)

  useEffect(() => {
    const n = meState.data?.name || ''
    setTeacher(n)
    setSavedName(n)
  }, [meState.data])

  const commitTeacher = async () => {
    const next = teacher.trim()
    if (!next || next === savedName) return setTeacher(savedName)
    try {
      await api.updateMe({ name: next })
      setSavedName(next)
      toast.success('Saved')
      qc.invalidateQueries({ queryKey: qk.me })
    } catch (err) {
      toast.apiError('Could not save your name', err)
      setTeacher(savedName)
    }
  }

  // Intersection Observer for scroll spy
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        // Find the most visible section
        let maxRatio = 0
        let visibleId = null
        entries.forEach((entry) => {
          if (entry.isIntersecting && entry.intersectionRatio > maxRatio) {
            maxRatio = entry.intersectionRatio
            visibleId = entry.target.id
          }
        })
        if (visibleId) {
          setActiveTab(visibleId.replace('section-', ''))
        }
      },
      {
        root: scrollContainerRef.current,
        threshold: [0.1, 0.5, 0.9],
        rootMargin: '-10% 0px -40% 0px',
      }
    )

    TABS.forEach((tab) => {
      const el = document.getElementById(`section-${tab.id}`)
      if (el) observer.observe(el)
    })

    return () => observer.disconnect()
  }, [])

  const scrollToSection = (id) => {
    setActiveTab(id)
    const el = document.getElementById(`section-${id}`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' })
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-paper/30 backdrop-blur-3xl saturate-[1.2] border border-white/5 shadow-inner shadow-white/5">
      
      {/* Left Sidebar (Master) */}
      <div className="hidden md:flex w-64 shrink-0 flex-col border-r border-edge bg-paper-sunken">
        <header className="flex h-14 shrink-0 items-center gap-2 px-4">
          <button
            onClick={() => navigate(-1)}
            aria-label="Back"
            className="rounded-md p-1.5 text-ink-muted transition-colors hover:bg-paper-inset hover:text-ink"
          >
            <ArrowLeft size={16} aria-hidden="true" />
          </button>
          <div className="flex items-center gap-1.5">
            <Settings size={16} aria-hidden="true" className="text-ink-muted" />
            <h1 className="text-sm font-semibold text-ink">Settings</h1>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto py-2">
          <nav className="flex flex-col px-2 gap-0.5">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => scrollToSection(tab.id)}
                className={`flex items-center justify-between min-h-touch rounded-lg px-2 text-sm transition-colors ${
                  activeTab === tab.id
                    ? 'bg-paper shadow-sm ring-1 ring-black/5 font-medium text-ink'
                    : 'text-ink-soft hover:bg-paper-inset hover:text-ink'
                }`}
              >
                <span className="truncate">{tab.label}</span>
              </button>
            ))}
          </nav>
        </div>
        <div className="shrink-0 border-t border-edge">
          {/* Every plan this class has ever built, placed at the bottom near account settings. */}
          <NavLink
            to={`${classPath}/plans`}
            className={({ isActive }) =>
              `flex min-h-touch items-center gap-2.5 px-4 text-sm transition-colors ${
                isActive ? 'text-ink' : 'text-ink-soft hover:text-ink'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <FileText
                  size={15}
                  aria-hidden="true"
                  style={isActive ? { color: 'rgb(var(--rail-pop-rgb))' } : undefined}
                />
                Library
              </>
            )}
          </NavLink>
          <AccountMenu classPath={classPath} />
        </div>
      </div>

      {/* Right Content Area (Detail) */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="flex md:hidden h-14 shrink-0 items-center border-b border-edge bg-paper px-4 z-10 gap-3">
          <Link to="/" className="rounded-md p-1.5 text-ink-muted transition-colors hover:bg-paper-inset hover:text-ink"><ArrowLeft size={16}/></Link>
          <div className="text-sm font-semibold text-ink truncate">{TABS.find(t => t.id === activeTab)?.label}</div>
        </header>
        <header className="hidden md:flex h-14 shrink-0 items-center border-b border-edge bg-paper px-8 z-10">
          <div className="text-sm font-medium text-ink-muted">
            {TABS.find(t => t.id === activeTab)?.label}
          </div>
        </header>

        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-8 py-8 scroll-smooth">
          <div className="w-full max-w-3xl flex flex-col gap-16 pb-32">
            
            {/* General Section */}
            <div id="section-general" className="scroll-mt-8">
              <h2 className="text-xl font-bold text-ink mb-6">General</h2>
              
              <section className="mb-8">
                <CustomInstructions
                  value={meState.data?.custom_instructions}
                  onSaved={() => qc.invalidateQueries({ queryKey: qk.me })}
                />
                <AiGenerationPreferences
                  value={meState.data?.custom_instructions}
                  onSaved={() => qc.invalidateQueries({ queryKey: qk.me })}
                />
              </section>

              <section className="mb-8">
                <div className="border-b border-edge pb-2 mb-4">
                  <h3 className="text-sm font-semibold text-ink">Profile</h3>
                  <p className="text-xs text-ink-muted">How you are addressed in the app and on your plans.</p>
                </div>
                <div className="max-w-md">
                  <label htmlFor="teacher" className="mb-1 block text-xs text-ink-muted">
                    Your Name
                  </label>
                  <input
                    id="teacher"
                    value={teacher}
                    onChange={(e) => setTeacher(e.target.value)}
                    onBlur={commitTeacher}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur()
                      if (e.key === 'Escape') setTeacher(savedName)
                    }}
                    placeholder="Mr. Cole"
                    className="neo-inset w-full rounded-lg bg-paper-raised/60 backdrop-blur-2xl px-3 py-2 text-sm text-ink outline-none focus:ring-1 focus:ring-accent"
                  />
                </div>
              </section>
              
              <section className="mb-8">
                <SchoolPicker
                  value={meState.data?.school}
                  onSaved={() => qc.invalidateQueries({ queryKey: qk.me })}
                />
              </section>

              <section>
                <div className="border-b border-edge pb-2 mb-4">
                  <h3 className="text-sm font-semibold text-ink">AI Defaults</h3>
                  <p className="text-xs text-ink-muted">Default behaviors for plan generation.</p>
                </div>
                
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 max-w-xl mb-6">
                  <label className="block">
                    <span className="mb-1 block text-xs text-ink-muted">Default Output Format</span>
                    <select
                      value={outputFormat}
                      onChange={(e) => setOutputFormat(e.target.value)}
                      className="neo-select neo-inset w-full rounded-lg bg-paper-raised/60 backdrop-blur-2xl py-2.5 pl-2.5 pr-8 text-sm text-ink"
                    >
                      <option value="narrative">Narrative Text</option>
                      <option value="bullets">Bulleted Lists</option>
                      <option value="tables">Tables</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-ink-muted">AI Tone / Voice</span>
                    <select
                      value={aiTone}
                      onChange={(e) => setAiTone(e.target.value)}
                      className="neo-select neo-inset w-full rounded-lg bg-paper-raised/60 backdrop-blur-2xl py-2.5 pl-2.5 pr-8 text-sm text-ink"
                    >
                      <option value="formal">Formal</option>
                      <option value="encouraging">Encouraging</option>
                      <option value="direct">Direct</option>
                    </select>
                  </label>
                </div>

                <div className="max-w-xl border border-edge rounded-xl p-4">
                  <Toggle 
                    label="Auto-Save Drafts" 
                    description="Automatically save changes to your plans while editing."
                    checked={autoSave}
                    onChange={setAutoSave}
                  />
                  <div className="h-px w-full bg-edge my-2" />
                  <Toggle 
                    label="Classify Plan Status" 
                    description="Allow the AI to automatically label plans as Draft, Review, or Final."
                    checked={classifyPlan}
                    onChange={setClassifyPlan}
                  />
                </div>
              </section>
            </div>

            {/* Preferences Section */}
            <div id="section-preferences" className="scroll-mt-8">
              <h2 className="text-xl font-bold text-ink mb-6">Preferences</h2>
              
              <section className="mb-8">
                <DesignSkinSection />
              </section>
              
              <section className="mb-8">
                <div className="border-b border-edge pb-2 mb-4">
                  <h3 className="text-sm font-semibold text-ink">Interface Settings</h3>
                </div>
                
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 max-w-xl mb-6">
                  <label className="block">
                    <span className="mb-1 block text-xs text-ink-muted">Theme</span>
                    <select
                      value={mode}
                      onChange={(e) => setMode(e.target.value)}
                      className="neo-select neo-inset w-full rounded-lg bg-paper-raised/60 backdrop-blur-2xl py-2.5 pl-2.5 pr-8 text-sm text-ink"
                    >
                      <option value="system">System Default</option>
                      <option value="light">Light</option>
                      <option value="dark">Dark</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-ink-muted">Editor Font Size</span>
                    <select
                      value={fontSize}
                      onChange={(e) => setFontSize(e.target.value)}
                      className="neo-select neo-inset w-full rounded-lg bg-paper-raised/60 backdrop-blur-2xl py-2.5 pl-2.5 pr-8 text-sm text-ink"
                    >
                      <option value="small">Small</option>
                      <option value="normal">Normal</option>
                      <option value="large">Large</option>
                    </select>
                  </label>
                </div>

                <div className="max-w-xl border border-edge rounded-xl p-4">
                  <Toggle 
                    label="High Contrast Mode" 
                    description="Increases text contrast across the application for readability."
                    checked={highContrast}
                    onChange={setHighContrast}
                  />
                </div>
              </section>

              <section className="mb-8">
                <div className="border-b border-edge pb-2 mb-4">
                  <h3 className="text-sm font-semibold text-ink">Help</h3>
                </div>
                <button
                  type="button"
                  className="btn"
                  onClick={() => openOnboardingWizard()}
                >
                  <Sparkles size={14} className="mr-1.5" aria-hidden="true" /> Take the tour again
                </button>
              </section>
            </div>

            {/* Account Section */}
            <div id="section-account" className="scroll-mt-8">
              <h2 className="text-xl font-bold text-ink mb-6">Account & Security</h2>
              
              {meState.data && meState.data.has_password ? (
                <section className="mb-8">
                  <div className="border-b border-edge pb-2 mb-4">
                    <h3 className="text-sm font-semibold text-ink">Password</h3>
                  </div>
                  <ChangePassword />
                </section>
              ) : meState.data ? (
                <section className="mb-8">
                  <div className="border-b border-edge pb-2 mb-4">
                    <h3 className="text-sm font-semibold text-ink">Password</h3>
                  </div>
                  <p className="text-sm text-ink-muted">
                    This account signs in with Google — there’s no password to change here.
                  </p>
                </section>
              ) : null}
              <section>
                <AccountSafety />
              </section>
            </div>

            {/* Integrations Section */}
            <div id="section-integrations" className="scroll-mt-8">
              <h2 className="text-xl font-bold text-ink mb-6">Integrations</h2>
              
              <section>
                <GoogleDriveSection />
                
                <div className="mt-8">
                  <h2 className="text-sm font-semibold text-ink">Other Integrations</h2>
                  <p className="mt-1 text-xs text-ink-muted">
                    Connect your external accounts to push and pull assignments seamlessly.
                  </p>
                  
                  <IntegrationPlaceholder 
                    name="Canvas LMS" 
                    description="Export your plans directly to Canvas Modules."
                    icon={<span className="font-bold">C</span>}
                  />
                  
                  <IntegrationPlaceholder 
                    name="Microsoft OneDrive" 
                    description="Save and sync documents with OneDrive."
                    icon={<span className="font-bold">O</span>}
                  />
                </div>
              </section>
            </div>

            {/* Billing Section */}
            <div id="section-billing" className="scroll-mt-8">
              <h2 className="text-xl font-bold text-ink mb-6">Billing</h2>
              <section>
                <BillingSection />
              </section>
            </div>

            {/* Advanced Section */}
            <div id="section-advanced" className="scroll-mt-8">
              <h2 className="text-xl font-bold text-ink mb-6">Advanced</h2>
              <section>
                <div className="border-b border-edge pb-2 mb-4">
                  <h3 className="text-sm font-semibold text-ink">Experimental</h3>
                  <p className="text-xs text-ink-muted">Try out features before they are widely released.</p>
                </div>
                
                <div className="max-w-xl border border-edge rounded-xl p-4">
                  <Toggle 
                    label="Enable Beta Features" 
                    description="Opt-in to use experimental AI models and cutting-edge features."
                    checked={betaFeatures}
                    onChange={setBetaFeatures}
                  />
                </div>

                {import.meta.env.DEV && (
                  <div className="mt-8">
                    <Diagnostics />
                  </div>
                )}
              </section>
            </div>

          </div>
        </div>
      </div>

    </div>
  )
}
