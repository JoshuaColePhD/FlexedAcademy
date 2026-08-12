import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { VoiceContext } from '../lib/voiceContext'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'

const KEY = 'aplang.voice'

/* 100ms of real silent PCM (8kHz, 8-bit, mono) — just enough to have
   SOMETHING playable to unlock with, see toggle() below.

   The previous clip here had a ZERO-byte data chunk — silence in name only,
   not one actual sample. Chrome tolerates that and fires 'ended' right
   away; iOS Safari instead rejects play() outright with an AbortError,
   because there is genuinely nothing to play — which is exactly the
   "Couldn't enable spoken replies: The operation was aborted" a real iPhone
   hit. A real, if tiny, sample buffer is unconditionally decodable. */
const UNLOCK_WAV =
  'data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA=='

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

  /* ── the speech queue ──────────────────────────────────────────────────
     A reply is spoken in PIECES now, not as one clip once the model has
     finished writing the whole thing. ChatPage feeds each finished sentence
     here the moment it lands in the SSE stream (see useChatStream's
     onSentence), so the first sentence is usually already playing while the
     model is still writing the second — which is the single biggest reason
     the old turn-taking felt slow: it waited for generate → THEN synthesize
     the whole reply → THEN play, three full round trips of dead air before
     any sound at all.

     Each queued item's TTS fetch starts the instant it's enqueued, in
     parallel with whatever is currently playing, so by the time one clip
     ends the next is usually already decoded and there's no gap between
     them. */
  const queueRef = useRef([])
  const playingRef = useRef(false)
  /* Bumped by stop(). Every async step below captures the value it started
     with and bails if it no longer matches — without it, a TTS fetch that
     was already in flight when the teacher interrupted would still resolve
     a moment later and start talking over them, which is exactly the thing
     barge-in exists to prevent. */
  const genRef = useRef(0)
  // One failure toast per utterance, not one per sentence — a broken
  // OPENAI_API_KEY would otherwise fire a toast for every clause.
  const warnedRef = useRef(false)
  const playNextRef = useRef(null)
  // Keyed by the cleaned text, so a prefetch() fired ahead of time (the
  // opening greeting, warmed the moment an empty chat loads rather than
  // when voice mode is actually opened) and the real enqueue() later share
  // the same in-flight fetch instead of the second one starting from zero.
  const cacheRef = useRef(new Map())

  useEffect(() => {
    const el = new Audio()
    audioRef.current = el
    /* 'ended' only — deliberately NOT 'pause'. Advancing the queue is this
       listener's whole job, and 'pause' fires for reasons that are not "the
       clip finished": stop() pausing on purpose, and swapping .src between
       queued sentences. Driving the queue off 'pause' would advance it
       twice per clip and skip sentences. Everything that legitimately ends
       speech (stop(), a drained queue) sets `speaking` false explicitly. */
    const onEnded = () => playNextRef.current?.()
    const onError = () => playNextRef.current?.()
    el.addEventListener('ended', onEnded)
    el.addEventListener('error', onError)
    return () => {
      el.removeEventListener('ended', onEnded)
      el.removeEventListener('error', onError)
      el.pause()
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    }
  }, [])

  const stop = useCallback(() => {
    // Invalidate every in-flight fetch and queued clip before touching the
    // element, so nothing can resurrect itself a beat after the interrupt.
    genRef.current += 1
    queueRef.current = []
    playingRef.current = false
    warnedRef.current = false
    setSpeaking(false)
    const el = audioRef.current
    if (!el) return
    el.pause()
    el.currentTime = 0
  }, [])

  const playNext = useCallback(async () => {
    const el = audioRef.current
    const gen = genRef.current
    const item = queueRef.current.shift()
    if (!el || !item) {
      // Queue drained: this is the one place a natural end of speech is
      // decided, rather than any single clip's 'ended'.
      playingRef.current = false
      setSpeaking(false)
      return
    }
    playingRef.current = true
    let blob = null
    try {
      blob = await item.blob
    } catch {
      blob = null
    }
    // Interrupted while this clip's audio was still being fetched.
    if (gen !== genRef.current) return
    if (!blob) {
      // One bad sentence shouldn't end the reply — skip to the next.
      playNextRef.current?.()
      return
    }
    try {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
      const url = URL.createObjectURL(blob)
      urlRef.current = url
      el.src = url
      setSpeaking(true)
      await el.play()
    } catch (err) {
      if (!warnedRef.current) {
        warnedRef.current = true
        toast.error('Got the reply, but couldn’t play it', err?.message || String(err))
      }
      if (gen === genRef.current) playNextRef.current?.()
    }
  }, [toast])
  playNextRef.current = playNext

  /* Append to whatever is already being said, rather than replacing it —
     this is what makes a multi-sentence reply play as one continuous piece
     of speech instead of each new sentence cutting off the last. */
  const enqueue = useCallback(
    (text) => {
      const clean = stripMarkdown(text)
      if (!clean) return
      const gen = genRef.current
      // Reuse a prefetch() already in flight for this exact text instead of
      // starting a second identical fetch — see prefetch() below.
      let fetched = cacheRef.current.get(clean)
      if (!fetched) {
        fetched = api.synthesizeSpeech(clean)
        cacheRef.current.set(clean, fetched)
      }
      const blob = fetched.catch((err) => {
        cacheRef.current.delete(clean)
        if (gen === genRef.current && !warnedRef.current) {
          warnedRef.current = true
          toast.error('Couldn’t speak that reply', err?.message || String(err))
        }
        return null
      })
      queueRef.current.push({ blob })
      // Optimistic, ahead of the audio actually starting: the fetch takes a
      // few hundred ms, and VoiceModePanel reads `speaking` to decide
      // whether an incoming utterance is a barge-in. Flipping it only once
      // sound came out would leave that window classified as "idle" and let
      // the reply and the teacher talk over each other.
      setSpeaking(true)
      if (!playingRef.current) playNext()
    },
    [playNext, toast]
  )

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
    //
    // EXCEPT AbortError: that's not the browser blocking anything, it's this
    // clip getting pre-empted a moment later by real speech starting on the
    // same click (openVoice calls unlock() then speak() in the same
    // gesture — speak()'s own stop() pauses this clip mid-flight). The
    // unlock clip already did its one job the instant play() was called
    // inside the gesture; being cut off after that is success, not failure.
    el.play().catch((err) => {
      if (err?.name === 'AbortError') return
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

  /* Starts the TTS fetch ahead of any actual speak() call, so the network
     round trip overlaps with whatever the teacher is doing before they
     actually open voice mode (reading the empty-chat screen, moving the
     mouse to the button) instead of only starting once they've clicked.
     Safe to call speculatively and never use — an unconsumed cache entry
     just sits there, there's no queue or playback side effect until
     enqueue()/speak() actually reads it. */
  const prefetch = useCallback((text) => {
    const clean = stripMarkdown(text)
    if (!clean || cacheRef.current.has(clean)) return
    const fetched = api.synthesizeSpeech(clean)
    cacheRef.current.set(clean, fetched)
    // A second listener, not the only one — enqueue() attaches its own
    // .catch (with the real user-facing toast) if/when it actually reads
    // this promise. Without this one, a prefetch that's never consumed
    // (voice mode never opened) would surface as an unhandled rejection.
    fetched.catch(() => cacheRef.current.delete(clean))
  }, [])

  /* Say this INSTEAD of whatever is currently queued or playing. The
     one-shot form, for text that replaces the conversation's current
     utterance rather than continuing it: the opening greeting, and the
     transcript's replay buttons. Streamed replies use enqueue() above. */
  const speak = useCallback(
    (text) => {
      stop()
      enqueue(text)
    },
    [stop, enqueue]
  )

  const value = useMemo(
    () => ({ enabled, toggle, speaking, speak, enqueue, stop, unlock, prefetch }),
    [enabled, toggle, speaking, speak, enqueue, stop, unlock, prefetch]
  )

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>
}
