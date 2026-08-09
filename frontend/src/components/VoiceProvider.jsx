import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { VoiceContext } from '../lib/voiceContext'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'

const KEY = 'aplang.voice'

/* A few milliseconds of silence, just to have SOMETHING playable to unlock
   with — see toggle() below. */
const UNLOCK_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='

function readEnabled() {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

/* Markdown syntax read literally by a TTS model is worse than no formatting
   at all — "asterisk asterisk Monday asterisk asterisk" instead of "Monday".
   Not exhaustive (this app's assistant replies are short, plain sentences by
   construction — see ChatPage's "Built {week}. Tell me what to change…" —
   so this only has to survive the occasional bold word or list the
   conversational routing model adds on its own, not a whole document). */
function stripMarkdown(text) {
  return String(text)
    .replace(/[*_`#]+/g, '')
    .replace(/^-\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim()
}

/* Speech OUT, the other half of the mic button already on the composer
 * (which is speech IN — dictation into the text field, nothing more). One
 * shared <audio> element rather than one per message: a second reply
 * arriving mid-playback should cut the first off and speak instead of
 * layering two voices, and a single element makes that "stop, then play"
 * instead of "manage a pool."
 *
 * Opt-in (default off, persisted once chosen): audio that starts talking on
 * its own the moment a plan finishes is the kind of surprise that's fine
 * alone at a desk and not fine in a workroom with colleagues around, so this
 * has to be a choice, not a default.
 */
export function VoiceProvider({ children }) {
  const toast = useToast()
  const [enabled, setEnabled] = useState(readEnabled)
  const [speaking, setSpeaking] = useState(false)
  const audioRef = useRef(null)
  const urlRef = useRef(null)
  // Once per page load, not once per toggle-on: `enabled` persists across a
  // reload (localStorage), but the <audio> element is recreated fresh every
  // mount and has never had a play() call land inside a real user gesture
  // THIS load — only toggling it off and back on this same session did that.
  // Every other load, autoplay silently blocked every reply, forever, with
  // the toggle already showing "on" the whole time.
  const unlockedRef = useRef(false)

  useEffect(() => {
    const el = new Audio()
    audioRef.current = el
    const onPlay = () => setSpeaking(true)
    const onEnd = () => setSpeaking(false)
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onEnd)
    el.addEventListener('ended', onEnd)
    return () => {
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onEnd)
      el.removeEventListener('ended', onEnd)
      el.pause()
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    }
  }, [])

  const stop = useCallback(() => {
    const el = audioRef.current
    if (!el) return
    el.pause()
    el.currentTime = 0
  }, [])

  /* Mobile Safari (and Chrome on Android) only starts audio when .play() is
     the DIRECT, SYNCHRONOUS result of a user gesture — a reply arriving
     seconds later inside speak()'s async fetch doesn't count, and the
     browser blocks it with no error surfaced (speak()'s own catch used to
     swallow exactly that). Playing a near-silent clip HERE, inside a real
     click, unlocks the shared <audio> element for the rest of the page's
     life — later async .play() calls on the SAME element are then allowed.

     Called from toggle() (turning it on) AND from the composer's Send button
     on every submit — toggling on is a real gesture but only happens on the
     ONE load where you flip the switch; every reload after that, `enabled`
     is already true from localStorage and nothing calls this at all unless
     something else also tries. Idempotent via unlockedRef, so spamming Send
     doesn't replay silence on every message once it's already unlocked. */
  const unlock = useCallback(() => {
    if (unlockedRef.current) return
    const el = audioRef.current
    if (!el) return
    unlockedRef.current = true
    el.src = UNLOCK_WAV
    // Reported, not swallowed: if the browser blocks even THIS — the one
    // play() call that's supposed to be bulletproof, since it's synchronous
    // inside the tap that requested it — every later reply is guaranteed
    // silent too, and that's worth knowing immediately instead of guessing
    // from "it never talks back." Un-set the flag on failure so the next
    // gesture gets another attempt rather than giving up for the session.
    el.play().catch((err) => {
      unlockedRef.current = false
      toast.error('Couldn’t enable spoken replies', err?.message || String(err))
    })
  }, [toast])

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev
      try {
        localStorage.setItem(KEY, next ? '1' : '0')
      } catch {
        /* not persisted */
      }
      if (next) unlock()
      else stop()
      return next
    })
  }, [stop, unlock])

  const speak = useCallback(
    async (text) => {
      const clean = stripMarkdown(text)
      if (!clean) return
      const el = audioRef.current
      if (!el) return
      let blob
      try {
        blob = await api.synthesizeSpeech(clean)
      } catch (err) {
        // The /api/tts request itself failed — network, auth, or the
        // backend's own OPENAI_API_KEY/TTS config. This used to be silent on
        // purpose (a missed reply is a smaller loss than a toast interrupting
        // the conversation, and the text is already on screen either way) —
        // but "silent" and "the feature has never once worked for anyone" are
        // indistinguishable without this, so it's reported until proven
        // reliable.
        toast.error('Couldn’t speak that reply', err?.message || String(err))
        return
      }
      try {
        // Stop and release the PREVIOUS clip only after the new one is ready —
        // swapping src earlier leaves a silent gap where the old audio had
        // already been torn down.
        el.pause()
        if (urlRef.current) URL.revokeObjectURL(urlRef.current)
        const url = URL.createObjectURL(blob)
        urlRef.current = url
        el.src = url
        await el.play()
      } catch (err) {
        // The fetch worked; playback itself was blocked or failed. Distinct
        // from the network case above because the fix is different — this
        // means the autoplay-unlock in toggle() didn't hold, not that the
        // server is misconfigured.
        toast.error('Got the reply, but couldn’t play it', err?.message || String(err))
      }
    },
    [toast]
  )

  const value = useMemo(
    () => ({ enabled, toggle, speaking, speak, stop, unlock }),
    [enabled, toggle, speaking, speak, stop, unlock]
  )

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>
}
