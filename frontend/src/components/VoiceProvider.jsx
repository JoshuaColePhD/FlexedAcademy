import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { VoiceContext } from '../lib/voiceContext'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'

const KEY = 'aplang.voice'

/* How long the assistant's voice takes to fade to nothing when it's cut off.
   Not zero: pausing playback mid-waveform is a hard amplitude discontinuity,
   which is a click — and a click is what made barge-in feel violent rather
   than responsive. 25ms is short enough to stay well inside the ~60ms budget
   a barge-in has to stop within before it reads as being ignored, and long
   enough that there's no transient left to hear. */
const FADE_S = 0.025

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

/* Safari wants webkitAudioContext, and has since before this app existed. */
function AudioCtor() {
  return typeof window === 'undefined' ? null : window.AudioContext || window.webkitAudioContext
}

/* decodeAudioData is promise-based everywhere current, but Safari carried the
   callback-only signature for years and this app's own screenshots keep coming
   from iOS. The promise form returns undefined on those builds rather than
   throwing, so feature-detect on the return value instead of the version. */
function decode(ctx, bytes) {
  return new Promise((resolve, reject) => {
    const maybe = ctx.decodeAudioData(bytes, resolve, reject)
    if (maybe && typeof maybe.then === 'function') maybe.then(resolve, reject)
  })
}

/* Speech OUT, the other half of the mic button already on the composer
 * (which is speech IN — dictation into the text field, nothing more).
 *
 * Playback runs on the Web Audio graph now, not an <audio> element whose .src
 * got swapped per sentence. That swap was the single loudest thing wrong with
 * voice mode: assigning .src starts a fresh load → decode → play cycle for
 * every clip, so a four-sentence reply had three audible seams in it even when
 * the network was instant, and the MP3 the backend used to send added LAME's
 * 576 samples of padding at each end of every clip on top of that. Neither is
 * a tuning problem; both are structural to the primitive.
 *
 * AudioBufferSourceNodes scheduled against one long-lived AudioContext's own
 * clock fix it outright: source.start(t) takes a time in the context's
 * coordinate system and is sample-accurate, so consecutive sentences butt up
 * against each other exactly. It also survives render pressure — the audio
 * clock runs on its own thread, where a JS timer or an 'ended' listener is at
 * the mercy of whatever React is doing on the main one.
 *
 * Opt-in (default off, persisted once chosen): audio that starts talking on
 * its own the moment a plan finishes is the kind of surprise that's fine
 * alone at a desk and not fine in a workroom with colleagues around, so this
 * has to be a choice, not a default.
 */
export function VoiceProvider({ children }) {
  const toast = useToast()
  const [enabled, setEnabled] = useState(() => {
    try {
      return localStorage.getItem(KEY) === '1'
    } catch {
      return false
    }
  })
  const [speaking, setSpeaking] = useState(false)
  /* The sentence being spoken RIGHT NOW — the panel's caption reads this.
     It lives here, rather than being pushed in from ChatPage, because this is
     the only place that knows when a given clip's audio actually begins: the
     AudioContext time it was scheduled at (see schedule()).

     The panel used to reveal a caption character by character at 42ms/char —
     about 24 chars/second, or 260wpm, against natural TTS speech of roughly
     14 chars/second. So the text consistently finished well before the voice
     did and then sat frozen, which is the specific thing that made the panel
     feel out of step with itself. Transcript and audio are two independent
     untimed streams; there is no fixing that by re-tuning the interval. Timing
     the caption off the audio clock instead makes the question go away. */
  const [caption, setCaption] = useState('')
  const captionTimersRef = useRef(new Set())

  const ctxRef = useRef(null)
  const gainRef = useRef(null)
  // Every source currently scheduled or playing, so stop() can silence all of
  // them at once. A Set rather than a single ref because scheduling runs one
  // clip ahead of playback by design — there is normally more than one live.
  const activeRef = useRef(new Set())
  // The context-clock time the next clip should begin at. This accumulator IS
  // the gaplessness: each clip starts exactly where the previous one ended,
  // rather than whenever its own fetch happened to resolve.
  const nextStartRef = useRef(0)
  const fadedRef = useRef(false)

  const queueRef = useRef([])
  const drainingRef = useRef(false)
  const pendingRef = useRef(0)
  /* Bumped by stop(). Every async step below captures the value it started
     with and bails if it no longer matches — without it, a TTS fetch that
     was already in flight when the teacher interrupted would still resolve
     a moment later and start talking over them, which is exactly the thing
     barge-in exists to prevent. */
  const genRef = useRef(0)
  // One failure toast per utterance, not one per sentence — a broken
  // OPENAI_API_KEY would otherwise fire a toast for every clause.
  const warnedRef = useRef(false)
  // Keyed by the cleaned text, so a prefetch() fired ahead of time (the
  // opening greeting, warmed the moment an empty chat loads rather than
  // when voice mode is actually opened) and the real enqueue() later share
  // the same in-flight fetch instead of the second one starting from zero.
  const cacheRef = useRef(new Map())

  /* What the assistant has actually STARTED SAYING OUT LOUD this turn.
     ChatPage reads this when a barge-in cuts a reply off, so the sentences
     that were already spoken can be written into the transcript — see
     getSpoken() below and ChatPage's onInterrupt for the bug this exists to
     fix. Only sentences from the live stream count toward it (enqueue's
     `track` option); app-authored interjections like "Building your week"
     are spoken but aren't part of the model's reply. */
  const spokenRef = useRef('')

  // Once per page load, not once per toggle-on: `enabled` persists across a
  // reload (localStorage), but an AudioContext constructed outside a real
  // gesture starts suspended, and a suspended context plays nothing while
  // reporting no error at all. Every load, autoplay silently produced silence
  // with the toggle already showing "on" the whole time.
  const unlockedRef = useRef(false)

  /* The one AudioContext for the page's whole life. Created lazily rather than
     on mount, because constructing one before any user gesture is what leaves
     it suspended in the first place; every caller here either runs inside a
     gesture (unlock) or after one has already happened. */
  const ensureCtx = useCallback(() => {
    if (ctxRef.current) return ctxRef.current
    const Ctor = AudioCtor()
    if (!Ctor) return null
    const ctx = new Ctor()
    const gain = ctx.createGain()
    gain.gain.value = 1
    gain.connect(ctx.destination)
    ctxRef.current = ctx
    gainRef.current = gain
    nextStartRef.current = ctx.currentTime
    return ctx
  }, [])

  /* iOS Safari suspends an AudioContext outright when the tab is backgrounded
     (app-switched away from, screen locked) and does not resume it on return —
     which reads as the assistant having gone permanently mute. Same handler
     VoiceModePanel already needs for its own analyser context, for the same
     reason. */
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && ctxRef.current?.state === 'suspended') {
        ctxRef.current.resume().catch(() => {})
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    const timers = captionTimersRef.current
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      timers.forEach(clearTimeout)
      timers.clear()
      activeRef.current.forEach((s) => {
        try {
          s.stop()
        } catch {
          /* already ended */
        }
      })
      activeRef.current.clear()
      ctxRef.current?.close().catch(() => {})
    }
  }, [])

  const stop = useCallback(() => {
    // Invalidate every in-flight fetch and queued clip before touching the
    // graph, so nothing can resurrect itself a beat after the interrupt.
    genRef.current += 1
    queueRef.current = []
    pendingRef.current = 0
    warnedRef.current = false
    setSpeaking(false)
    captionTimersRef.current.forEach(clearTimeout)
    captionTimersRef.current.clear()
    setCaption('')

    const ctx = ctxRef.current
    const gain = gainRef.current
    if (!ctx || !gain) return

    /* Ramp down, then stop — not stop outright. See FADE_S. The sources are
       told to stop AT the end of the ramp rather than now, so the fade
       actually gets to play out; scheduling a stop in the future is free,
       since nothing else is queued behind it by this point. */
    const now = ctx.currentTime
    try {
      gain.gain.cancelScheduledValues(now)
      gain.gain.setValueAtTime(gain.gain.value, now)
      // Not 0: an exponential ramp can't reach zero, and linear ramps to
      // exactly 0 have historically been the buggier path in Safari.
      gain.gain.linearRampToValueAtTime(0.0001, now + FADE_S)
    } catch {
      /* a context that's already closed — nothing left to fade */
    }
    fadedRef.current = true
    activeRef.current.forEach((s) => {
      try {
        s.stop(now + FADE_S)
      } catch {
        /* already ended */
      }
    })
    activeRef.current.clear()
    // Abandon the old timeline outright. Without this, the next utterance
    // would be scheduled after however much silenced audio was still notion-
    // ally queued, and the assistant would sit mute for exactly as long as
    // the reply it just got cut off would have taken.
    nextStartRef.current = now
  }, [])

  /* Puts one decoded clip on the context's timeline, immediately after
     whatever is already scheduled. */
  const schedule = useCallback((buffer, item) => {
    const ctx = ctxRef.current
    const gain = gainRef.current
    if (!ctx || !gain) return

    // First clip after a fade-out: bring the gain back up. Done here rather
    // than in stop() so the ramp is never cut short by a restore racing it.
    if (fadedRef.current) {
      fadedRef.current = false
      try {
        gain.gain.cancelScheduledValues(ctx.currentTime)
        gain.gain.setValueAtTime(1, ctx.currentTime)
      } catch {
        /* closed context */
      }
    }

    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(gain)
    /* A 20ms floor ahead of "now" so a clip whose decode finished late still
       starts cleanly rather than being scheduled in the past (which browsers
       handle by playing it immediately, mid-buffer, and it is audible). */
    const at = Math.max(ctx.currentTime + 0.02, nextStartRef.current)
    src.start(at)
    nextStartRef.current = at + buffer.duration

    activeRef.current.add(src)
    pendingRef.current += 1
    src.onended = () => {
      activeRef.current.delete(src)
      pendingRef.current = Math.max(0, pendingRef.current - 1)
      // The one place a natural end of speech is decided: nothing left
      // playing AND nothing left waiting to be scheduled.
      if (pendingRef.current === 0 && queueRef.current.length === 0) {
        setSpeaking(false)
        setCaption('')
      }
    }

    /* Everything that has to happen the moment this clip is AUDIBLE, rather
       than the moment it was scheduled — scheduling runs about a sentence
       ahead of playback, so the two are not the same instant.

       `at` is in the context's clock, so the delay to it is exact. Two things
       hang off it: the caption (which is why it now tracks the voice instead
       of racing it), and the running record of what the assistant has actually
       said out loud. That second one is what makes an interrupted turn
       recoverable — a sentence whose timer has fired was heard, one whose
       timer hasn't wasn't, and ChatPage writes exactly the former into the
       transcript on barge-in. */
    const gen = genRef.current
    const delayMs = Math.max(0, (at - ctx.currentTime) * 1000)
    const timer = setTimeout(() => {
      captionTimersRef.current.delete(timer)
      if (gen !== genRef.current) return
      setCaption(item?.text || '')
      if (item?.track && item.text) {
        spokenRef.current = spokenRef.current ? `${spokenRef.current} ${item.text}` : item.text
      }
    }, delayMs)
    captionTimersRef.current.add(timer)
  }, [])

  /* Pulls queued sentences through fetch → decode → schedule, strictly in
     order. Serial on purpose: the fetches themselves already run in parallel
     (enqueue starts each one the moment it's queued), so what's left to
     serialise is only the scheduling, and that has to happen in order or the
     reply comes out shuffled. */
  const drain = useCallback(async () => {
    if (drainingRef.current) return
    drainingRef.current = true
    const gen = genRef.current
    try {
      while (queueRef.current.length) {
        if (gen !== genRef.current) return
        const item = queueRef.current.shift()
        let buffer = null
        try {
          const bytes = await item.bytes
          if (gen !== genRef.current) return
          const ctx = ensureCtx()
          if (!ctx || !bytes) throw new Error('No audio came back.')
          if (ctx.state === 'suspended') await ctx.resume().catch(() => {})
          /* slice(0), not the buffer itself: decodeAudioData DETACHES the
             ArrayBuffer it's given. The cache hands the same bytes to a
             replay or to a prefetch-then-enqueue pair, and the second read
             of a detached buffer throws. Copying is cheap next to a network
             round trip. */
          buffer = await decode(ctx, bytes.slice(0))
        } catch (err) {
          // One bad sentence shouldn't kill the rest of the reply.
          if (gen === genRef.current && !warnedRef.current) {
            warnedRef.current = true
            toast.error('Couldn’t speak that reply', err?.message || String(err))
          }
          continue
        }
        if (gen !== genRef.current) return
        schedule(buffer, item)
      }
    } finally {
      drainingRef.current = false
      // Queue emptied without anything actually being scheduled (every clip
      // failed) — nothing will fire onended, so settle the state here.
      if (pendingRef.current === 0 && queueRef.current.length === 0) setSpeaking(false)
    }
  }, [ensureCtx, schedule, toast])

  /* Append to whatever is already being said, rather than replacing it —
     this is what makes a multi-sentence reply play as one continuous piece
     of speech instead of each new sentence cutting off the last. */
  const enqueue = useCallback(
    (text, { track = false } = {}) => {
      const clean = stripMarkdown(text)
      if (!clean) return
      // Reuse a prefetch() already in flight for this exact text instead of
      // starting a second identical fetch — see prefetch() below.
      let fetched = cacheRef.current.get(clean)
      if (!fetched) {
        fetched = api.synthesizeSpeech(clean)
        cacheRef.current.set(clean, fetched)
      }
      const bytes = fetched.catch(() => {
        cacheRef.current.delete(clean)
        return null
      })
      queueRef.current.push({ bytes, text: clean, track })
      // Optimistic, ahead of the audio actually starting: the fetch takes a
      // few hundred ms, and VoiceModePanel reads `speaking` to decide
      // whether an incoming utterance is a barge-in. Flipping it only once
      // sound came out would leave that window classified as "idle" and let
      // the reply and the teacher talk over each other.
      setSpeaking(true)
      drain()
    },
    [drain]
  )

  /* Mobile Safari (and Chrome on Android) only lets audio start when it's the
     DIRECT, SYNCHRONOUS result of a user gesture — a reply arriving seconds
     later inside a fetch doesn't count, and the browser blocks it with no
     error surfaced anywhere. Resuming the shared AudioContext HERE, inside a
     real click, is what makes every later scheduled clip allowed.

     Called from toggle() (turning it on) AND from the composer's Send button
     on every submit — toggling on is a real gesture but only happens on the
     ONE load where you flip the switch; every reload after that, `enabled`
     is already true from localStorage and nothing would call this at all.
     Idempotent via unlockedRef, so spamming Send doesn't re-resume on every
     message once it's already running. */
  const unlock = useCallback(() => {
    if (unlockedRef.current) return
    const ctx = ensureCtx()
    if (!ctx) return
    unlockedRef.current = true
    // Reported, not swallowed: if the browser blocks even THIS — the one call
    // that's supposed to be bulletproof, since it's synchronous inside the tap
    // that requested it — every later reply is guaranteed silent too, and
    // that's worth knowing immediately instead of guessing from "it never
    // talks back." Un-set the flag on failure so the next gesture gets another
    // attempt rather than giving up for the session.
    //
    // The silent-WAV trick the <audio> element needed is gone with it: an
    // AudioContext is unlocked by resume(), not by having played something,
    // so there is nothing to synthesize and nothing that can be pre-empted
    // mid-flight the way that clip could.
    ctx.resume().catch((err) => {
      unlockedRef.current = false
      toast.error('Couldn’t enable spoken replies', err?.message || String(err))
    })
  }, [ensureCtx, toast])

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

  /* What's been spoken aloud so far this turn, and the reset that starts a
     new one. See spokenRef, and ChatPage's onInterrupt/submit. */
  const getSpoken = useCallback(() => spokenRef.current.trim(), [])
  const resetSpoken = useCallback(() => {
    spokenRef.current = ''
  }, [])

  const value = useMemo(
    () => ({
      enabled,
      toggle,
      speaking,
      caption,
      speak,
      enqueue,
      stop,
      unlock,
      prefetch,
      getSpoken,
      resetSpoken,
    }),
    [
      enabled,
      toggle,
      speaking,
      caption,
      speak,
      enqueue,
      stop,
      unlock,
      prefetch,
      getSpoken,
      resetSpoken,
    ]
  )

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>
}
