import { useEffect, useState } from 'react'
import { CreditCard, Download, Sparkles } from 'lucide-react'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'
import { useConfirm } from '../lib/confirmContext'
import { useAuth } from '../lib/authContext'
import { useBilling } from '../lib/billingContext'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { qk } from '../lib/queryKeys'
import { errorParts } from '../lib/apiError'

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
    try {
      await api.updateMe({ customInstructions: text })
      setSaved(text)
      toast.success('Saved')
      onSaved?.()
    } catch (err) {
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
        className="neo-inset mt-2 w-full resize-y rounded-lg bg-paper-raised px-3 py-2 text-sm text-ink outline-none focus:ring-1 focus:ring-accent"
      />
      <div className="mt-1 flex items-center justify-between">
        <span className="text-2xs text-ink-muted">
          {text.length} / {CUSTOM_INSTRUCTIONS_MAX}
        </span>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className="neo-raised rounded-lg bg-accent px-3 py-2 text-sm font-medium text-ink-inverse hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
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
      <select
        value={value || ''}
        disabled={saving || !schools.length}
        onChange={(e) => commit(e.target.value)}
        className="neo-select neo-inset mt-2 w-full max-w-xs rounded-lg bg-paper-raised py-2 pl-3 pr-8 text-sm text-ink disabled:opacity-60"
      >
        {schools.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
            {s.has_calendar === false ? ' — no calendar yet' : ''}
          </option>
        ))}
      </select>
      {/* A school's row and its calendar are added in different places on
          purpose (see GET /api/schools) — so one can exist with no year
          behind it, and choosing it silently empties the week board, the
          composer's week dropdown and the week the model is told about.
          Said out loud here, after the fact, because the row is still a
          legitimate choice: it just can't schedule anything yet. */}
      {selected && selected.has_calendar === false ? (
        /* A tinted banner rather than plain small red text — this is a
           genuine "come do something" state (no calendar means every plan
           for this class builds worse until one is added), which is what
           --mark-tint/--mark already exist to carry as a status colour, not
           just a flag on prose. */
        <p className="mt-2 max-w-xs rounded-lg bg-mark-tint px-2.5 py-2 text-xs text-mark">
          No calendar is on file for {selected.name} yet, so weeks can’t be scheduled — plans
          will build without a week or a closure to work from until one is added.
        </p>
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
          className="neo-inset w-full rounded-lg bg-paper-raised px-2.5 py-1.5 text-sm text-ink outline-none focus:ring-1 focus:ring-accent"
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
          className="neo-inset w-full rounded-lg bg-paper-raised px-2.5 py-1.5 text-sm text-ink outline-none focus:ring-1 focus:ring-accent"
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
          className="neo-inset w-full rounded-lg bg-paper-raised px-2.5 py-1.5 text-sm text-ink outline-none focus:ring-1 focus:ring-accent"
        />
      </div>
      <button
        type="submit"
        disabled={saving || !current || !next}
        className="neo-raised rounded-lg bg-accent px-3 py-2 text-sm font-medium text-ink-inverse hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
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
    <div className="mt-5">
      <h2 className="text-sm font-semibold text-ink">Billing</h2>
      <div className="neo-panel mt-2 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-paper-raised p-3">
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
          className="neo-raised inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-ink-inverse hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {entitlement.subscribed ? (
            <CreditCard size={14} aria-hidden="true" />
          ) : (
            <Sparkles size={14} aria-hidden="true" />
          )}
          {busy ? 'Opening…' : entitlement.subscribed ? 'Manage subscription' : 'Subscribe'}
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
      <div className="neo-panel mt-2 divide-y divide-edge rounded-xl bg-paper-raised">
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
            className="neo-raised inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent-tint"
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
                    className="neo-inset w-full rounded-lg bg-paper-raised px-2.5 py-1.5 text-sm text-ink outline-none focus:ring-1 focus:ring-accent"
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
    <details className="neo-panel mt-2 overflow-hidden rounded-xl bg-paper-raised">
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

export function SettingsPage() {
  const qc = useQueryClient()
  const toast = useToast()
  const meState = useQuery({ queryKey: qk.me, queryFn: () => api.me() })

  const [teacher, setTeacher] = useState('')
  const [savedName, setSavedName] = useState('')

  // users.name is where the teacher's name lives now.
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

  return (
    <div className="column">
      <header className="flex h-14 shrink-0 items-center px-gutter">
        <h1 className="text-sm font-semibold text-ink">Settings</h1>
      </header>

      <div className="page scroll-y">
        <div className="mx-auto w-full max-w-measure-form">
          {/* ── your name, once ─────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <label htmlFor="teacher" className="text-sm text-ink-muted">
              Plans are signed
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
              className="min-w-0 flex-1 rounded-md bg-transparent px-1.5 py-1 text-sm font-medium text-ink outline-none transition-colors placeholder:text-ink-faint hover:bg-paper-sunken focus:bg-paper-sunken"
            />
          </div>

          {/* ── school ───────────────────────────────────────────────────── */}
          <SchoolPicker
            value={meState.data?.school}
            onSaved={() => qc.invalidateQueries({ queryKey: qk.me })}
          />

          {/* ── custom instructions ─────────────────────────────────────── */}
          <CustomInstructions
            value={meState.data?.custom_instructions}
            onSaved={() => qc.invalidateQueries({ queryKey: qk.me })}
          />

          {/* ── password ─────────────────────────────────────────────────── */}
          {meState.data && meState.data.has_password ? (
            <div className="mt-5">
              <h2 className="text-sm font-semibold text-ink">Password</h2>
              <ChangePassword />
            </div>
          ) : meState.data ? (
            <p className="mt-5 text-xs text-ink-muted">
              This account signs in with Google — there’s no password to change here.
            </p>
          ) : null}

          {/* ── billing ──────────────────────────────────────────────────── */}
          <BillingSection />

          <AccountSafety />

          <Diagnostics />
        </div>
      </div>
    </div>
  )
}
