import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { VoiceContext } from '../lib/voiceContext'
import { api } from '../lib/api'

const KEY = 'aplang.voice'

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
  const [enabled, setEnabled] = useState(readEnabled)
  const [speaking, setSpeaking] = useState(false)
  const audioRef = useRef(null)
  const urlRef = useRef(null)

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

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev
      try {
        localStorage.setItem(KEY, next ? '1' : '0')
      } catch {
        /* not persisted */
      }
      if (!next) stop()
      return next
    })
  }, [stop])

  const speak = useCallback(
    async (text) => {
      const clean = stripMarkdown(text)
      if (!clean) return
      const el = audioRef.current
      if (!el) return
      try {
        const blob = await api.synthesizeSpeech(clean)
        // Stop and release the PREVIOUS clip only after the new one is ready —
        // swapping src earlier leaves a silent gap (or nothing at all, if the
        // fetch fails) where the old audio had already been torn down.
        el.pause()
        if (urlRef.current) URL.revokeObjectURL(urlRef.current)
        const url = URL.createObjectURL(blob)
        urlRef.current = url
        el.src = url
        await el.play()
      } catch {
        // A missed reply is a smaller loss than a toast interrupting the
        // conversation to announce that the conversation didn't happen —
        // the text version is already on screen either way.
      }
    },
    []
  )

  const value = useMemo(() => ({ enabled, toggle, speaking, speak, stop }), [enabled, toggle, speaking, speak, stop])

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>
}
