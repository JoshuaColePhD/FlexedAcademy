import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AVATAR_OPTIONS, getInitials } from '../lib/avatars'
import { api } from '../lib/api'
import { qk } from '../lib/queryKeys'
import { useAuth } from '../lib/authContext'
import { useToast } from '../lib/toastContext'

/* The profile-icon grid, shared by Settings and by onboarding's first step.
 *
 * Extracted rather than reimplemented: the optimistic mutation below is the
 * interesting part and it already carried two hard-won decisions, both of
 * which a second copy would have lost.
 *
 * `size` is the only difference between the two callers. Onboarding gets the
 * larger grid because picking a face is the whole screen there, where in
 * Settings it is one control among many.
 *
 * `previewName` is for onboarding's profile step, where the name field sits
 * directly above this grid: the initials tile follows what is being TYPED
 * rather than what is saved, so the connection between the two controls is
 * visible instead of something the teacher has to take on trust until after
 * they press Continue. Settings omits it and reads the account.
 */
export function AvatarPicker({ size = 'md', previewName }) {
  /* Reads the account through useAuth (which IS the qk.me query now, see
     AuthProvider) rather than a second ['me'] useQuery of its own. That
     duplicate was the bug: this component refetched ITS copy while the
     sidebar's AccountMenu read AuthProvider's separate useState, so picking an
     avatar updated the picker and left the rail showing the old one until a
     full page reload. */
  const { user } = useAuth()
  const qc = useQueryClient()
  const toast = useToast()

  const chooseAvatar = useMutation({
    mutationFn: (avatarId) => api.updateAvatar(avatarId),
    /* Optimistic: the ring moves on click. Picking an avatar is a direct
       manipulation of something the teacher is looking at — a round trip
       before it moves reads as the app ignoring the click, which is exactly
       what "takes a while for it to show" was. Same shape as useRenameChat
       (hooks/useAppData.js), the pattern this app already uses for this. */
    onMutate: async (avatarId) => {
      await qc.cancelQueries({ queryKey: qk.me })
      const prev = qc.getQueryData(qk.me)
      qc.setQueryData(qk.me, (u) => (u ? { ...u, avatar: avatarId } : u))
      return { prev }
    },
    onError: (err, _avatarId, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(qk.me, ctx.prev)
      toast.apiError('Could not update avatar', err)
    },
    /* PUT /api/auth/avatar already returns the full public user
       (backend/routes/auth.py), so the authoritative answer replaces the
       optimistic guess with NO second round trip. This used to be an
       await refetch() — a whole extra GET /api/auth/me, one of the most
       expensive endpoints in the app, for data the response already had. */
    onSuccess: (updated) => qc.setQueryData(qk.me, updated),
  })

  /* No `saving` guard and no disabled state: the update is optimistic, so
     there is no window where a click could land on stale data, and freezing
     every picker button on every pick was most of what made this feel slow.
     No success toast either — the ring moving IS the confirmation. */
  const handleSelect = (avatarId) => {
    if (user?.avatar === avatarId) return
    chooseAvatar.mutate(avatarId)
  }

  const box = size === 'lg' ? 'h-14 w-14' : 'h-12 w-12'
  const glyph = size === 'lg' ? 'text-3xl' : 'text-2xl'

  return (
    <div className="flex flex-wrap gap-3">
      {/* "No avatar" is the teacher's initials, not an empty slot — the
          account menu falls back to them, so this is a real preview of what
          they get rather than an absence. */}
      <button
        type="button"
        onClick={() => handleSelect(null)}
        className={`flex ${box} items-center justify-center rounded-full border-2 text-xs font-bold tracking-wide transition-all hover:scale-110 active:scale-95 ${!user?.avatar ? 'border-[var(--accent)] bg-accent/15 text-accent-text shadow-md' : 'border-transparent bg-paper-inset text-ink-muted hover:bg-paper-sunken'}`}
        aria-pressed={!user?.avatar}
        aria-label="Your initials"
        title="Your initials"
      >
        {getInitials(previewName ?? user?.name)}
      </button>
      {AVATAR_OPTIONS.map((opt) => (
        <button
          key={opt.id}
          type="button"
          onClick={() => handleSelect(opt.id)}
          className={`flex ${box} items-center justify-center rounded-full border-2 transition-all hover:scale-110 active:scale-95 ${opt.bg} ${user?.avatar === opt.id ? 'border-[var(--accent)] shadow-[0_0_0_2px_var(--paper),0_0_0_4px_var(--accent)]' : 'border-transparent'}`}
          aria-pressed={user?.avatar === opt.id}
          aria-label={opt.label}
          title={opt.label}
        >
          <span className={`${glyph} leading-none`} aria-hidden="true">
            {opt.emoji}
          </span>
        </button>
      ))}
    </div>
  )
}
