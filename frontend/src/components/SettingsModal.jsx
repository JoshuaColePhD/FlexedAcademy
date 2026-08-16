import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { X } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'
import { qk } from '../lib/queryKeys'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useExitTransition } from '../hooks/useExitTransition'
import { SettingsBody } from '../pages/SettingsPage'

/* Settings overlaying the chat instead of replacing it — on request, the
 * same pop-up-over-the-current-screen pattern Claude's own desktop app uses
 * for its settings, but this app's own chrome (.dialog, same as the confirm
 * prompt and every other overlay here) rather than borrowed styling.
 *
 * SettingsPage.jsx still exists and still renders as a full page — a direct
 * or bookmarked visit to `/c/:id/settings` has no "chat underneath" to
 * overlay, so App.jsx's background-location routing only swaps in THIS
 * component when there's a real background location to show behind it (see
 * ClassRoutes). Both shells render the exact same <SettingsBody>; only the
 * frame around it differs.
 */
export function SettingsModal() {
  const navigate = useNavigate()
  const toast = useToast()
  const qc = useQueryClient()
  const meState = useQuery({ queryKey: qk.me, queryFn: () => api.me() })

  const [teacher, setTeacher] = useState('')
  const [savedName, setSavedName] = useState('')

  useEffect(() => {
    const n = meState.data?.name || ''
    setTeacher(n)
    setSavedName(n)
  }, [meState.data])

  const close = () => navigate(-1)

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

  const { mounted, closing } = useExitTransition(true, 200)
  const dialogRef = useRef(null)
  useFocusTrap(dialogRef, { active: true, trap: true, onEscape: close })

  if (!mounted) return null

  return (
    <div
      className={`dialog-scrim${closing ? ' is-closing' : ''}`}
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        className={`dialog dialog-wide${closing ? ' is-closing' : ''}`}
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-hairline px-5 py-3">
          <h1 id="settings-modal-title" className="text-sm font-semibold text-ink">
            Settings
          </h1>
          <button
            type="button"
            onClick={close}
            aria-label="Close settings"
            className="grid h-8 w-8 place-items-center rounded-md text-ink-muted transition-colors hover:bg-paper-sunken hover:text-ink"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <SettingsBody
            teacher={teacher}
            setTeacher={setTeacher}
            savedName={savedName}
            commitTeacher={commitTeacher}
            meState={meState}
            qc={qc}
          />
        </div>
      </div>
    </div>
  )
}
