import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
// Upload is used by the drag-and-drop overlay below and was missing from this
// list — the overlay only renders while a file is actually being dragged over
// the composer, so the ReferenceError sat there unnoticed by anything but a
// linter until someone dragged a file.
import { ArrowUp, BookOpen, Check, FileText, Loader2, Mic, Paperclip, Pause, Play, Plus, RotateCcw, Square, Trash2, Upload, X } from 'lucide-react'
import { api } from '../lib/api'
import { haptic } from '../lib/haptics'
import { useToast } from '../lib/toastContext'
import { useExitTransition } from '../hooks/useExitTransition'
import { suggestionCompletion } from '../lib/contextualSuggestions'

// A guardrail, not a technical ceiling — bounds how many extractText calls
// one drop/pick can fire at once. See attachFiles' own comment for why the
// overflow gets its own toast instead of just being quietly ignored.
const MAX_ATTACH_BATCH = 5
// The ghost-completion overlay and the real textarea underneath it render
// the SAME text at two different moments (an unaccepted suggestion, then
// whatever replaces it the instant a key is pressed) — they used to each
// hardcode their own copy of this (py-2.5/text-sm on the textarea,
// py-[0.9375rem]/text-[0.9375rem] on the overlay), and drifted apart:
// real typed text sat at a visibly different size and vertical position
// than the suggestion it replaced (Josh's own "the text is not centered
// when you type," 2026-08-27). One shared string both className templates
// below pull from, so there's no second copy left to silently diverge.
// Keep the textarea's line box aligned with the shell's centered control row.
// A small optical nudge in the padding puts the text baseline on the same
// visual center as the geometric center of the plus button. The total vertical
// padding stays 24px, so the one-line field keeps the same measured height.
const COMPOSER_TEXT_METRICS = 'px-0 pt-[0.9375rem] pb-[0.5625rem] text-[0.9375rem] leading-6'
const COMPOSER_GHOST_METRICS = 'text-[0.9375rem] leading-6'
const VOICE_DEVICE_STORAGE_KEY = 'flexedacademy.voice.inputDevice'

// Keep cleanup deterministic and local. The review step lets a teacher fix
// anything unusual, while these common spoken controls make dictation useful
// for lesson-plan prose without another model call or another billed request.
const VOICE_GLOSSARY = [
  [/\bflex\s*ed\b/gi, 'FlexEd'],
  [/\bap\s+language\b/gi, 'AP Language'],
  [/\brhetorical\s+devices\b/gi, 'rhetorical devices'],
  [/\bgoogle\s+drive\b/gi, 'Google Drive'],
]

function cleanDictation(text, glossary = []) {
  let cleaned = `${text || ''}`.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim()
  if (!cleaned) return ''

  cleaned = cleaned
    .replace(/\bnew paragraph\b/gi, '\n\n')
    .replace(/\bnew line\b/gi, '\n')
    .replace(/\b(?:make|start) (?:a )?list\b/gi, '\n')

  // Only treat ordinals as list commands when there are at least two of them;
  // that avoids turning an ordinary phrase such as “first, consider…” into a
  // bullet by accident.
  const ordinal = /\b(?:first|second|third|fourth|fifth|sixth|one|two|three|four|five|six)\b/gi
  const ordinalMatches = cleaned.match(ordinal) || []
  if (ordinalMatches.length >= 2) {
    cleaned = cleaned.replace(ordinal, '\n• ')
  }

  cleaned = cleaned
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+([,.;!?])/g, '$1')
  for (const [pattern, replacement] of VOICE_GLOSSARY) cleaned = cleaned.replace(pattern, replacement)
  for (const term of glossary) {
    const canonical = `${term || ''}`.trim()
    if (!canonical) continue
    const escaped = canonical.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    cleaned = cleaned.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), canonical)
  }

  // Capitalize the beginning of each paragraph/sentence without changing
  // intentional all-caps standards codes or the teacher's reviewed wording.
  cleaned = cleaned.replace(/(^|[.!?]\s+|\n+)(•\s*)?([a-z])/g, (_match, lead, bullet = '', letter) => `${lead}${bullet || ''}${letter.toUpperCase()}`)
  return cleaned.trim()
}

/* An attachment chip's own mount lifecycle — entrance was already implicit
 * (a plain array render, no fade), removal was a hard splice. This is
 * local-only state (setAttachments is a plain filter, no network round
 * trip like the list-row deletions elsewhere in this pass), so unlike
 * those the removal itself can be delayed to match the animation exactly,
 * not just flagged and left to a fill-mode keyframe. Identified by object
 * reference, not index — several chips can be mid-removal at once, and an
 * index captured at render time would go stale the moment an earlier one
 * actually leaves the array. */
function Chip({ file, onRemove, onSaveAsDocument }) {
  const [removing, setRemoving] = useState(false)
  const [saving, setSaving] = useState(false)
  const { mounted, closing } = useExitTransition(!removing, 150)

  useEffect(() => {
    if (!mounted) onRemove()
  }, [mounted, onRemove])

  if (!mounted) return null

  const save = async () => {
    if (saving) return
    setSaving(true)
    try {
      await onSaveAsDocument()
    } finally {
      setSaving(false)
    }
  }

  return (
    <span
      className={`fa-rise neo-inset flex items-center gap-1.5 rounded-full bg-paper-sunken px-2.5 py-1 text-xs font-medium text-ink${closing ? ' fa-chip-exit' : ''}`}
    >
      <FileText size={14} className="text-ink-muted" aria-hidden="true" />
      <span className="max-w-[120px] truncate">{file.filename}</span>
      {/* Only offered when the class has no pacing guide yet (see Composer's
          own onSaveAttachmentAsDocument prop) — a file dropped into chat
          used to ride into that one conversation only, truncated, and never
          become the durable document AddDocumentDialog's upload flow
          produces. This is the bridge between the two. */}
      {onSaveAsDocument ? (
        <button
          type="button"
          className="fa-press ml-1 rounded-sm p-0.5 text-ink-muted transition-colors hover:bg-paper-inset hover:text-ink disabled:opacity-50"
          aria-label={`Save ${file.filename} as this class's pacing guide`}
          title="Save as this class's pacing guide"
          onClick={save}
          disabled={saving}
        >
          {saving ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Upload size={12} aria-hidden="true" />}
        </button>
      ) : null}
      <button
        type="button"
        className="fa-press ml-1 rounded-sm p-0.5 text-ink-muted transition-colors hover:bg-paper-inset hover:text-ink"
        aria-label={`Remove ${file.filename}`}
        onClick={() => setRemoving(true)}
      >
        <X size={12} aria-hidden="true" />
      </button>
    </span>
  )
}

export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  isStreaming,
  attachments,
  setAttachments,
  selectedStandard = null,
  selectedStandardStatus = 'selected',
  // Offers each attachment chip a way to become a real, durable class
  // document instead of only ever riding into this one conversation. Kept
  // null (no offer shown) whenever there's no class in scope, or it already
  // has a pacing guide — see ChatPage's own gating.
  onSaveAttachmentAsDocument = null,
  suggestions = [],
  /* Kept for callers outside the main chat surface while they migrate to the
     shared suggestion model. It is converted into the same shape below. */
  suggestion = null,
  /* True while ChatPage's own voice-dock panel is open. That panel already
     has its own always-on mic listening for speech — letting the
     composer's separate dictate-into-text mic run at the same time meant
     two different "I'm listening" affordances competing for the same
     microphone and the same attention. Dictate disables outright; voice
     conversation controls stay in the dedicated voice panel. */
  voiceModeActive = false,
  voicePanel = null,
  // The text-mode twin of voicePanel — a clarification round docked above
  // the input instead of stuck mid-transcript (see ChatPage's
  // questionsExit/lastQuestions and LessonQuestions). It lives above the
  // persistent input shell; the two never show at once, since voice mode
  // surfaces its own questions through voicePanel.
  questionsPanel = null,
  mode = 'brainstorm',
  onModeChange,
  focusOnMount = false,
  placeholder = 'What are you teaching? (Press ⌘K for actions)',
  sendLabel = 'Send',
  // Optional teacher/course vocabulary supplied by the caller. Common terms
  // remain deterministic above; this lets a class add names, standards, or
  // school-specific phrases without another model call.
  voiceGlossary = [],
}) {
  const toast = useToast()
  const textareaRef = useRef(null)
  const mediaRecorder = useRef(null)
  const audioChunks = useRef([])
  // Stamped onto each attachment as `_id` at attach-time — see Chip's own
  // key comment below for why filename+index wasn't a safe key.
  const attachmentIdRef = useRef(0)
  const [isRecording, setIsRecording] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const [recordingPreview, setRecordingPreview] = useState(null)
  const [reviewText, setReviewText] = useState('')
  const [inputDevices, setInputDevices] = useState([])
  const [selectedDeviceId, setSelectedDeviceId] = useState(() => {
    try { return window.localStorage.getItem(VOICE_DEVICE_STORAGE_KEY) || '' } catch { return '' }
  })
  const [isAttaching, setIsAttaching] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [textareaHeight, setTextareaHeight] = useState(48)
  const toolsMenuRef = useRef(null)
  const toolsTriggerRef = useRef(null)
  const fileInputRef = useRef(null)
  useEffect(() => {
    if (!toolsOpen) return undefined
    const frame = requestAnimationFrame(() => toolsMenuRef.current?.querySelector('[role="menuitem"]:not(:disabled)')?.focus())
    const dismiss = (event) => {
      if (!toolsMenuRef.current?.contains(event.target)) setToolsOpen(false)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setToolsOpen(false)
        toolsTriggerRef.current?.focus()
      }
      if (!toolsMenuRef.current?.contains(event.target) || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      const items = Array.from(toolsMenuRef.current.querySelectorAll('[role^="menuitem"]:not(:disabled), select'))
      if (!items.length) return
      event.preventDefault()
      const current = items.indexOf(document.activeElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[next].focus()
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', onKey)
    }
  }, [toolsOpen])
  const [shake, setShake] = useState(false)
  const [motionState, setMotionState] = useState('')
  const motionTimerRef = useRef(null)
  const recordingTimerRef = useRef(null)
  const recordingDiscardedRef = useRef(false)
  const recordingCursorRef = useRef({ start: 0, end: 0, value: '' })
  const visualizerBarsRef = useRef([])
  const visualizerFrameRef = useRef(null)
  const visualizerContextRef = useRef(null)
  const visualizerAnalyserRef = useRef(null)
  const visualizerSamplesRef = useRef(null)
  const visualizerPausedRef = useRef(false)

  const triggerShake = useCallback(() => {
    setShake(true)
    setTimeout(() => setShake(false), 400)
  }, [])

  const pulseMotion = useCallback((state, duration = 360) => {
    setMotionState(state)
    window.clearTimeout(motionTimerRef.current)
    motionTimerRef.current = window.setTimeout(() => setMotionState(''), duration)
  }, [])

  useEffect(() => () => window.clearTimeout(motionTimerRef.current), [])

  /* The old recording bars used recordingSeconds as their animation clock,
     which meant they only got a new height once per second. Drive the bars
     from the live stream instead, but update the DOM imperatively so a 60fps
     visualizer does not rerender the whole composer on every audio frame. */
  const stopMicVisualizer = useCallback(() => {
    window.cancelAnimationFrame(visualizerFrameRef.current)
    visualizerFrameRef.current = null
    visualizerAnalyserRef.current = null
    visualizerSamplesRef.current = null
    const context = visualizerContextRef.current
    visualizerContextRef.current = null
    if (context) void context.close().catch(() => {})
    visualizerBarsRef.current.forEach((bar) => {
      if (bar) bar.style.height = '8px'
    })
  }, [])

  const startMicVisualizer = useCallback((stream) => {
    stopMicVisualizer()
    const AudioContextClass = window.AudioContext || window.webkitAudioContext
    if (!AudioContextClass) return

    try {
      const context = new AudioContextClass()
      const analyser = context.createAnalyser()
      const silentGain = context.createGain()
      analyser.fftSize = 64
      analyser.smoothingTimeConstant = 0.84
      silentGain.gain.value = 0
      context.createMediaStreamSource(stream).connect(analyser)
      // Keep the analyser in the active audio graph without feeding the
      // microphone back into the speakers.
      analyser.connect(silentGain)
      silentGain.connect(context.destination)
      visualizerContextRef.current = context
      visualizerAnalyserRef.current = analyser
      visualizerSamplesRef.current = new Uint8Array(analyser.fftSize)
      visualizerPausedRef.current = false
      void context.resume?.()

      const tick = () => {
        const activeAnalyser = visualizerAnalyserRef.current
        const samples = visualizerSamplesRef.current
        if (!activeAnalyser || !samples) return
        if (!visualizerPausedRef.current) {
          activeAnalyser.getByteTimeDomainData(samples)
          let energy = 0
          for (const sample of samples) {
            const normalized = (sample - 128) / 128
            energy += normalized * normalized
          }
          const rms = Math.sqrt(energy / samples.length)
          const level = Math.min(1, Math.max(0, (rms - 0.012) * 5.5))
          const now = performance.now()
          visualizerBarsRef.current.forEach((bar, index) => {
            if (!bar) return
            const drift = Math.sin(now / (170 + index * 22) + index * 0.8) * 1.5
            const height = Math.max(8, Math.round(8 + level * (12 + index * 2.2) + drift))
            bar.style.height = `${height}px`
          })
        }
        visualizerFrameRef.current = window.requestAnimationFrame(tick)
      }
      visualizerFrameRef.current = window.requestAnimationFrame(tick)
    } catch {
      // Recording should never fail just because the browser cannot expose a
      // Web Audio analyser; the CSS fallback still shows a live state.
      stopMicVisualizer()
    }
  }, [stopMicVisualizer])

  // Device labels are only exposed after the browser grants microphone
  // permission. Refreshing after permission and on device changes means the
  // selector reflects the computer's actual microphones, not the iPhone or a
  // stale Bluetooth device from an earlier session.
  useEffect(() => {
    let cancelled = false
    const refreshDevices = async () => {
      if (!navigator.mediaDevices?.enumerateDevices) return
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        if (cancelled) return
        setInputDevices(devices.filter((device) => device.kind === 'audioinput'))
      } catch { /* device enumeration is optional; recording still works */ }
    }
    void refreshDevices()
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices)
    return () => {
      cancelled = true
      navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices)
    }
  }, [])

  useEffect(() => {
    if (!isRecording || isPaused) {
      window.clearInterval(recordingTimerRef.current)
      return undefined
    }
    recordingTimerRef.current = window.setInterval(() => {
      setRecordingSeconds((seconds) => seconds + 1)
    }, 1000)
    return () => window.clearInterval(recordingTimerRef.current)
  }, [isPaused, isRecording])

  useEffect(() => {
    visualizerPausedRef.current = isPaused
  }, [isPaused])

  useEffect(() => () => window.clearInterval(recordingTimerRef.current), [])

  // Always 0 or 1 items — the composer has exactly one caller (ChatPage),
  // and contextualSuggestions.js's MAX_SUGGESTIONS caps `suggestions` at 1;
  // the legacy `suggestion` string fallback is a single item by construction
  // too. The `.slice(0, 1)` below enforces that invariant rather than just
  // happening to hold, now that nothing upstream produces more than one.
  const candidateSuggestions = useMemo(() => {
    const normalized = suggestions.length
      ? suggestions
      : suggestion
        ? [{ id: 'legacy-suggestion', label: suggestion, prompt: suggestion, reason: '', priority: 99 }]
        : []
    const query = value.trim().toLocaleLowerCase()
    if (!query) return normalized.slice(0, 1)
    return normalized
      .filter((item) => item.prompt?.toLocaleLowerCase().startsWith(query))
      .slice(0, 1)
  }, [suggestion, suggestions, value])

  // ChatPage never hands this an action: 'open-settings' suggestion
  // (add-pacing-guide, add-school-calendar) — those have no sentence to
  // type or send, so they're the Greeting's own inline hint instead (see
  // ChatPage's emptyStateHint). Whatever's here is always a real ghost-
  // text candidate for the composer.
  const textSuggestion = candidateSuggestions[0] || null
  // A stable identity for "which suggestion is this" that survives the
  // LLM-grounding call swapping in better wording later (see ChatPage's
  // aiSuggestion), but changes the moment the teacher moves to a different
  // week/class — see frozenRef below for what that buys.
  const suggestionKey = textSuggestion ? `${textSuggestion.id}:${textSuggestion.weekNumber ?? ''}` : null

  // The grounded wording can arrive ~400ms+ of network latency after the
  // instant deterministic suggestion is already showing as ghost text.
  // Without this, that swap happens while a teacher is mid-read, which reads
  // as the box glitching rather than "got smarter." Freezes the prompt text
  // the moment it's on screen; only refreshes to newer wording while nothing
  // is currently visible, or once the suggestion itself changes.
  const frozenRef = useRef({ key: null, prompt: '' })
  if (suggestionKey !== frozenRef.current.key) {
    frozenRef.current = { key: suggestionKey, prompt: textSuggestion?.prompt || '' }
  }
  const activeSuggestion = textSuggestion ? { ...textSuggestion, prompt: frozenRef.current.prompt } : null

  // Escape hides the ghost text without touching what's typed — the same
  // dismiss gesture VS Code's own inline completion uses. Keyed to the exact
  // (suggestion, typed text) pair so any edit un-dismisses it immediately,
  // rather than requiring a specific "prove it's stale" keystroke.
  const [dismissed, setDismissed] = useState(null)
  const isDismissed = dismissed && dismissed.key === suggestionKey && dismissed.value === value
  // Keep an empty field as a familiar message prompt. Suggestions become
  // useful once a teacher begins a matching thought, where Tab completion
  // reads as help rather than text that must be cleared before writing.
  const completion = value.trim() && activeSuggestion && !isDismissed
    ? suggestionCompletion(value, activeSuggestion)
    : ''

  // Safe to pick up newer wording now — nothing frozen is currently visible.
  if (!completion && textSuggestion && frozenRef.current.prompt !== textSuggestion.prompt) {
    frozenRef.current = { key: suggestionKey, prompt: textSuggestion.prompt }
  }

  // The ghost-text overlay below is aria-hidden — its whole point is to sit
  // behind the real text, not be read as a second copy of it — so without
  // this, a screen-reader user never learns Tab-completion exists at all.
  // Announces once per suggestion (keyed on suggestionKey + whether one is
  // currently showing), not on every keystroke that narrows `completion`
  // within the SAME suggestion — Boolean(completion) only flips at the
  // edges (appears/dismissed), so typing further into an already-announced
  // suggestion doesn't retrigger this.
  const [suggestionAnnouncement, setSuggestionAnnouncement] = useState('')
  useEffect(() => {
    setSuggestionAnnouncement(
      completion && activeSuggestion
        ? `Suggestion available: ${activeSuggestion.prompt}. Press Tab to accept, Escape to dismiss.`
        : ''
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestionKey, Boolean(completion)])

  /* Only when asked. The composer is the primary control on an empty screen, so
     focusing it there is right; doing it unconditionally would steal focus every
     time the panel re-renders. */
  useEffect(() => {
    if (focusOnMount) textareaRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Enter sends, but Shift+Enter promises a real new line. The previous
  // fixed-height textarea silently clipped those extra lines. Let a draft
  // grow to five lines; after that it scrolls inside the field.
  useEffect(() => {
    const input = textareaRef.current
    if (!input) return
    input.style.height = 'auto'
    const nextHeight = Math.min(144, Math.max(48, input.scrollHeight))
    input.style.height = `${nextHeight}px`
    setTextareaHeight(nextHeight)
  }, [value])

  const startRecording = async () => {
    if (isRecording || isTranscribing) return
    recordingDiscardedRef.current = false
    setRecordingPreview(null)
    setReviewText('')
    const input = textareaRef.current
    recordingCursorRef.current = {
      start: input?.selectionStart ?? value.length,
      end: input?.selectionEnd ?? value.length,
      value,
    }
    try {
      // A selected device is preferred, but a disconnected Bluetooth mic
      // should fall back to the system microphone instead of trapping the
      // teacher in an OverconstrainedError loop.
      const audio = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : {}),
      }
      let stream
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio })
      } catch (error) {
        if (!selectedDeviceId || error?.name !== 'OverconstrainedError') throw error
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      }
      const recorder = new MediaRecorder(stream)
      mediaRecorder.current = recorder
      audioChunks.current = []
      setRecordingSeconds(0)
      setIsPaused(false)
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunks.current.push(event.data)
      }
      recorder.onstop = async () => {
        stopMicVisualizer()
        stream.getTracks().forEach((track) => track.stop())
        mediaRecorder.current = null
        if (recordingDiscardedRef.current) {
          audioChunks.current = []
          return
        }
        // recorder.mimeType, not a hardcoded container — Safari records
        // mp4/aac while Chrome commonly records webm/opus.
        const blob = new Blob(audioChunks.current, { type: recorder.mimeType || 'audio/webm' })
        audioChunks.current = []
        if (blob.size === 0) return
        setIsTranscribing(true)
        try {
          const { text } = await api.transcribe(blob)
          const cleaned = cleanDictation(text, voiceGlossary)
          setReviewText(cleaned)
          // Keep only the text after transcription; retaining the audio Blob
          // in React state would unnecessarily pin a potentially large file
          // until the teacher accepts or dismisses the review.
          setRecordingPreview({ text: cleaned })
        } catch (err) {
          toast.error('Could not transcribe that', err.message || err.hint)
        } finally {
          setIsTranscribing(false)
        }
      }
      recorder.start(250)
      setIsRecording(true)
      startMicVisualizer(stream)
      const activeTrack = stream.getAudioTracks()[0]
      const deviceId = activeTrack?.getSettings?.().deviceId
      if (deviceId && deviceId !== selectedDeviceId) {
        setSelectedDeviceId(deviceId)
        try { window.localStorage.setItem(VOICE_DEVICE_STORAGE_KEY, deviceId) } catch { /* optional persistence */ }
      }
      // Permission has now been granted, so labels become available.
      try {
        const devices = await navigator.mediaDevices.enumerateDevices?.()
        if (devices) setInputDevices(devices.filter((device) => device.kind === 'audioinput'))
      } catch { /* labels are optional after recording has started */ }
    } catch (error) {
      toast.error(
        error?.name === 'NotAllowedError' ? 'Microphone permission needed' : 'No microphone access',
        error?.name === 'NotAllowedError' ? 'Allow microphone access for this computer, then try again.' : 'Choose a connected computer microphone and try again.'
      )
    }
  }

  const stopRecording = () => {
    const recorder = mediaRecorder.current
    if (!recorder || recorder.state === 'inactive') return
    recorder.stop()
    setIsRecording(false)
    setIsPaused(false)
  }

  const togglePauseRecording = () => {
    const recorder = mediaRecorder.current
    if (!recorder || !isRecording) return
    if (recorder.state === 'paused') {
      recorder.resume()
      setIsPaused(false)
    } else {
      recorder.pause()
      setIsPaused(true)
    }
  }

  const cancelRecording = () => {
    recordingDiscardedRef.current = true
    const recorder = mediaRecorder.current
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    else mediaRecorder.current?.stream?.getTracks?.().forEach((track) => track.stop())
    mediaRecorder.current = null
    audioChunks.current = []
    setIsRecording(false)
    setIsPaused(false)
    setRecordingSeconds(0)
  }

  const redoRecording = () => {
    setRecordingPreview(null)
    setReviewText('')
    void startRecording()
  }

  const insertRecording = () => {
    const text = cleanDictation(reviewText, voiceGlossary)
    if (!text) return
    const snapshot = recordingCursorRef.current
    const base = snapshot.value || value
    const before = base.slice(0, snapshot.start)
    const after = base.slice(snapshot.end)
    const leftSpace = before && !/[\s\n]$/.test(before) ? ' ' : ''
    const rightSpace = after && !/^[\s\n]/.test(after) ? ' ' : ''
    const nextValue = `${before}${leftSpace}${text}${rightSpace}${after}`
    onChange(nextValue)
    setRecordingPreview(null)
    setReviewText('')
    requestAnimationFrame(() => {
      const nextCursor = before.length + leftSpace.length + text.length
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor)
    })
  }

  /* The tracks are stopped inside recorder.onstop, which never runs if the
     component goes away first — so starting to dictate and then clicking
     another chat left the recorder orphaned and the browser's red recording
     dot lit on the tab indefinitely. */
  useEffect(
    () => () => {
      recordingDiscardedRef.current = true
      stopMicVisualizer()
      const rec = mediaRecorder.current
      if (rec && rec.state !== 'inactive') rec.stop()
      rec?.stream?.getTracks?.().forEach((t) => t.stop())
    },
    [stopMicVisualizer]
  )

  // Both the file-picker input and drag-and-drop used to take only
  // `files?.[0]` — the input had no `multiple`, and drop silently ignored
  // everything past the first file. Selecting or dropping 3 files attached
  // 1 and threw the other 2 away with no error, no toast, nothing. One
  // shared batch path for both now, capped rather than unbounded (a
  // teacher dropping a whole folder shouldn't fire 40 concurrent
  // extractText calls) — and the cap itself is reported, not silent,
  // since silent was exactly the bug.
  const attachFiles = useCallback(
    async (fileList) => {
      const files = Array.from(fileList ?? [])
      if (!files.length) return
      const toProcess = files.slice(0, MAX_ATTACH_BATCH)
      const skipped = files.length - toProcess.length

      setIsAttaching(true)
      try {
        const results = await Promise.allSettled(toProcess.map((file) => api.extractText(file)))
        const attached = []
        const failed = []
        results.forEach((r, i) => {
          if (r.status === 'fulfilled') attached.push({ ...r.value, file: toProcess[i], _id: attachmentIdRef.current++ })
          else failed.push({ file: toProcess[i], err: r.reason })
        })

        if (attached.length) {
          setAttachments((prev) => [...prev, ...attached])
          if (attached.length === 1) {
            toast.success(`Attached ${attached[0].filename}`, `${attached[0].chars.toLocaleString()} characters`)
          } else {
            toast.success(`Attached ${attached.length} files`, attached.map((a) => a.filename).join(', '))
          }
        }
        if (failed.length) {
          triggerShake()
          // One toast per failed file used to mean a bad multi-file drop
          // could stack 3-4 full-size error toasts at once, each one
          // showing `hint` — which for a read failure is raw parser
          // stderr (pdftotext's own "Syntax Warning: ... Syntax Error:
          // ..." dump), not something a teacher can act on. `message` is
          // always the clean, written-for-a-human line; prefer it, and
          // only fall back to `hint` when there's truly nothing else (the
          // still-useful case, e.g. "Install poppler: brew install
          // poppler", is a message-less AppError). Multiple failures
          // collapse into one toast, same as the success/skip paths
          // already do, rather than piling one on top of another.
          if (failed.length === 1) {
            const { file, err } = failed[0]
            toast.error(`Could not read ${file.name}`, err.message || err.hint)
          } else {
            toast.error(`Could not read ${failed.length} files`, failed.map(({ file }) => file.name).join(', '))
          }
        }
        if (skipped > 0) {
          toast.error(
            `Only attached the first ${MAX_ATTACH_BATCH} files`,
            `${skipped} more ${skipped === 1 ? 'was' : 'were'} skipped — attach ${skipped === 1 ? 'it' : 'them'} separately.`
          )
        }
      } finally {
        setIsAttaching(false)
      }
    },
    [toast, triggerShake, setAttachments]
  )

  const handleFile = (e) => {
    const files = e.target.files
    e.target.value = ''
    void attachFiles(files)
  }

  const handleGlobalDrop = useCallback(
    (e) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(false)
      void attachFiles(e.dataTransfer?.files)
    },
    [attachFiles]
  )

  useEffect(() => {
    const handleDragOver = (e) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(true)
    }
    const handleDragLeave = (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.relatedTarget === null || e.clientX === 0 || e.clientY === 0) {
        setIsDragging(false)
      }
    }
    window.addEventListener('dragover', handleDragOver)
    window.addEventListener('dragleave', handleDragLeave)
    window.addEventListener('drop', handleGlobalDrop)
    return () => {
      window.removeEventListener('dragover', handleDragOver)
      window.removeEventListener('dragleave', handleDragLeave)
      window.removeEventListener('drop', handleGlobalDrop)
    }
  }, [handleGlobalDrop])

  const hasContent = value.trim().length > 0 || attachments.length > 0
  // isStreaming no longer gates this: a teacher thinking of a follow-up
  // while the current reply is still generating can now type it and hit
  // Enter — ChatPage's onSubmit (queueOrSubmit) holds it and sends it the
  // moment this turn finishes, instead of Enter silently doing nothing.
  // The button slot below still shows Stop/a spinner while isStreaming
  // (aborting is a separate, still-available action), so this only changes
  // what Enter itself does — see onKeyDown below.
  const canSend = hasContent && !isRecording && !isTranscribing
  // The right-side action is one control: an empty composer starts dictation,
  // while a draft (or an attachment) sends. Keeping the decision here means
  // the icon, label, disabled state, and click handler cannot drift apart.
  const showSendAction = hasContent

  // canSend's own false→true edge — a scale-pop the instant the send
  // button actually becomes pressable, so "you can go now" isn't only a
  // color change easy to miss while still looking at what you're typing.
  const wasSendableRef = useRef(canSend)
  useEffect(() => {
    if (canSend && !wasSendableRef.current) pulseMotion('ready', 320)
    wasSendableRef.current = canSend
  }, [canSend, pulseMotion])

  const submit = () => {
    /* No voice.unlock() here any more.
     *
     * This line existed to satisfy the browser's "audio playback needs a user
     * gesture" rule: under the old architecture unlock() resumed an
     * AudioContext, and a keydown counts as a gesture where a timer does not.
     * Under WebRTC, unlock() means something entirely different — mint an
     * ephemeral key, open the microphone, and negotiate a realtime session.
     * Since `voice.enabled` is restored from localStorage, that turned every
     * typed message from anyone who had ever tried voice mode into a mic
     * permission prompt and a billed session. (Before the missing
     * api.createVoiceSession was added it was instead a red error toast on
     * every message, forever, which is the form the bug was first reported in.)
     *
     * The gesture requirement is satisfied where it belongs now: by the press
     * on the voice button itself, which is the only thing that opens a session. */
    pulseMotion('submit', 320)
    // Pass the current draft across the component boundary. Keeping the
    // draft lookup inside ChatPage made its submit callback depend on the
    // parent's `query` state, recreating transcript callbacks on every
    // keystroke. The composer owns the interaction, so send its snapshot.
    onSubmit(value)
  }

  const acceptSuggestion = (suggestionToAccept = activeSuggestion) => {
    if (!suggestionToAccept?.prompt) return
    // Tab only ever fills the box, for every suggestion including
    // review-plan — it used to send review-plan outright on the theory that
    // there was nothing left to edit, but that meant Tab did two very
    // different things depending on which suggestion happened to be
    // showing. One consistent contract: Tab accepts text, Enter sends it.
    const typedPrefixMatches = value && suggestionToAccept.prompt.toLocaleLowerCase().startsWith(value.toLocaleLowerCase())
    const remaining = typedPrefixMatches ? suggestionToAccept.prompt.slice(value.length) : ''
    if (value && !remaining) return
    const nextValue = value && remaining ? `${value}${remaining}` : suggestionToAccept.prompt
    // 450ms, matching fa-input-flash's own duration below — pulseMotion
    // clears the class at this timeout, so it has to outlast the CSS
    // animation it's driving or the flash gets cut off mid-fade instead of
    // completing it.
    pulseMotion('accept', 450)
    onChange(nextValue)
    requestAnimationFrame(() => {
      const input = textareaRef.current
      input?.focus()
      input?.setSelectionRange(nextValue.length, nextValue.length)
    })
  }

  const onKeyDown = (e) => {
    if (e.key === 'Tab' && completion) {
      e.preventDefault()
      acceptSuggestion()
      return
    }
    // Escape is the quickest way to stop an in-flight response when focus is
    // still in the composer. Keep it ahead of ghost-text dismissal so the
    // same key never merely hides the suggestion while a request continues.
    if (e.key === 'Escape' && isStreaming && onStop) {
      e.preventDefault()
      onStop()
      return
    }
    if (e.key === 'Escape' && completion) {
      e.preventDefault()
      setDismissed({ key: suggestionKey, value })
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (canSend) submit()
    }
  }

  // Accessories and file chips live above the input. The field itself gets a
  // little room for a multi-line thought, then scrolls internally.
  return (
    <div className="relative w-full">
      {voicePanel}
      {questionsPanel}

      {isRecording ? (
        <div className="mb-2 flex min-h-10 items-center gap-3 rounded-xl border border-mark/30 bg-mark-tint px-3 py-2 text-sm text-ink" role="status" aria-live="polite">
          <span className="composer-mic-level flex items-end gap-0.5 text-mark" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((bar) => (
              <span
                key={bar}
                ref={(node) => { visualizerBarsRef.current[bar] = node }}
                className="composer-mic-level-bar w-1 rounded-full bg-current"
              />
            ))}
          </span>
          <span className="font-semibold tabular-nums">{`${Math.floor(recordingSeconds / 60)}:${String(recordingSeconds % 60).padStart(2, '0')}`}</span>
          <span className="min-w-0 flex-1 truncate">{isPaused ? 'Recording paused' : 'Recording from this computer'}</span>
          {inputDevices.length > 1 ? (
            <select
              className="max-w-[11rem] rounded-md border border-mark/20 bg-paper-raised px-2 py-1 text-xs text-ink outline-none"
              value={selectedDeviceId}
              onChange={(event) => setSelectedDeviceId(event.target.value)}
              aria-label="Recording microphone"
              disabled={isRecording}
            >
              {inputDevices.map((device, index) => <option key={device.deviceId || `mic-${index}`} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}
            </select>
          ) : null}
          <button type="button" className="fa-press rounded-md p-1.5 text-ink-muted hover:bg-paper-raised hover:text-ink" onClick={togglePauseRecording} aria-label={isPaused ? 'Resume recording' : 'Pause recording'} title={isPaused ? 'Resume recording' : 'Pause recording'}>
            {isPaused ? <Play size={15} aria-hidden="true" /> : <Pause size={15} aria-hidden="true" />}
          </button>
          <button type="button" className="fa-press rounded-md p-1.5 text-ink-muted hover:bg-paper-raised hover:text-ink" onClick={cancelRecording} aria-label="Cancel recording" title="Cancel recording">
            <Trash2 size={15} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {isTranscribing ? (
        <div className="mb-2 flex min-h-10 items-center gap-2 rounded-xl border border-accent/20 bg-accent-tint px-3 py-2 text-sm text-ink" role="status" aria-live="polite">
          <Loader2 size={16} className="animate-spin text-accent" aria-hidden="true" />
          <span>Transcribing your note…</span>
        </div>
      ) : null}

      {recordingPreview ? (
        <div className="mb-2 rounded-xl border border-accent/25 bg-paper-raised p-3 shadow-sm" role="region" aria-label="Review dictated text">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-muted">Review dictation</span>
            <span className="text-xs text-ink-faint">Cleaned for punctuation and lists</span>
          </div>
          <textarea
            value={reviewText}
            onChange={(event) => setReviewText(event.target.value)}
            rows={3}
            className="w-full resize-y rounded-lg border border-edge bg-paper px-3 py-2 text-sm leading-6 text-ink outline-none focus:border-accent"
            aria-label="Dictated text to insert"
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <button type="button" className="fa-press inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold text-ink-muted hover:bg-paper-sunken hover:text-ink" onClick={redoRecording}>
              <RotateCcw size={14} aria-hidden="true" /> Redo
            </button>
            <button type="button" className="fa-press inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-accent-on hover:bg-accent-hover" onClick={insertRecording} disabled={!reviewText.trim()}>
              <Check size={14} aria-hidden="true" /> Insert at cursor
            </button>
          </div>
        </div>
      ) : null}

      {selectedStandard ? (
        <div className="mb-2 flex items-center gap-2 rounded-xl border border-accent/20 bg-accent-tint px-3 py-2 text-xs text-ink" role="status">
          <BookOpen size={14} className="shrink-0 text-accent" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">
            <span className="font-semibold">Using {selectedStandard.code}</span>
            <span className="ml-1.5 text-ink-muted">
              {selectedStandardStatus === 'applied' ? '· applied to this plan' : selectedStandardStatus === 'review' ? '· review the alignment' : '· selected for this plan'}
            </span>
          </span>
          {selectedStandardStatus === 'applied' ? <span className="shrink-0 rounded-full bg-ok-tint px-2 py-0.5 text-2xs font-semibold text-ok">Applied</span> : null}
        </div>
      ) : null}

      {attachments.length > 0 ? (
        <div className="composer-attachments flex flex-nowrap gap-2 overflow-x-auto px-3 pb-2" role="list" aria-label="Attached files">
          {attachments.map((f) => (
            <Chip
              // Was `${f.filename}-${i}` — a removed chip only leaves the
              // array once its own 150ms exit animation finishes, so stable
              // attach-time ids prevent sibling removals from remounting a
              // chip that is still animating out.
              key={f._id}
              file={f}
              onRemove={() => setAttachments((prev) => prev.filter((x) => x !== f))}
              onSaveAsDocument={
                onSaveAttachmentAsDocument && f.file ? () => onSaveAttachmentAsDocument(f) : undefined
              }
            />
          ))}
        </div>
      ) : null}

      <div
        className={`composer-shell relative flex min-h-14 w-full flex-col border border-edge bg-paper-raised ${textareaHeight > 48 ? 'is-expanded' : ''} ${isDragging ? 'ring-2 ring-accent' : ''} ${isRecording ? 'ring-2 ring-mark/50 shadow-[0_0_15px_rgba(var(--mark-rgb),0.3)]' : ''} ${shake ? 'animate-error-shake' : ''} ${motionState === 'accept' ? 'fa-composer-accept' : ''}`}
        style={{ height: `${Math.max(56, textareaHeight + 8)}px`, maxHeight: '152px' }}
      >
        {isDragging ? createPortal(
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-paper/60 backdrop-blur-md">
            <div className="flex flex-col items-center justify-center gap-4 rounded-[32px] bg-paper-raised px-16 py-12 shadow-[4px_4px_12px_rgba(var(--neo-dark-rgb),0.3),-4px_-4px_12px_rgba(var(--neo-light-rgb),0.6),inset_2px_2px_4px_rgba(var(--neo-light-rgb),0.4)] ring-1 ring-edge animate-pulse">
              <span className="neo-inset flex h-20 w-20 items-center justify-center rounded-full text-accent shadow-[inset_3px_3px_6px_rgba(var(--neo-dark-rgb),0.4),inset_-3px_-3px_6px_rgba(var(--neo-light-rgb),0.6)]">
                <Upload size={32} strokeWidth={2.5} />
              </span>
              <div className="flex flex-col items-center text-center">
                <h3 className="text-xl font-bold tracking-tight text-ink">Drop file to attach</h3>
                <p className="mt-1 text-sm font-medium text-ink-muted">PDF, TXT, MD, or CSV</p>
              </div>
            </div>
          </div>,
          document.body
        ) : null}
        <div
          className={`composer-control-row relative flex min-h-14 ${textareaHeight > 48 ? 'is-expanded items-end' : 'items-center'} px-3 py-1 transition-colors ${isRecording ? 'bg-mark-tint' : ''}`}
        >
          {/* Was hardcoded to "Describe the week you want to plan" — missed
              when `placeholder`/`sendLabel` below were made props specifically
              so a non-chat caller wasn't stuck with chat-specific wording (see
              that comment). A screen-reader user on any other surface still
              heard this exact chat-only sentence regardless of what
              `placeholder` actually said. */}
          <label className="sr-only" htmlFor="composer-input">
            {placeholder}
          </label>

          {/* h-11/w-11 (44px, Apple/Android's own touch-target minimum)
              below md, dropping to the desktop-density h-9 at md and up —
              .tap-target already padded an INVISIBLE hit area out to 44px
              at the smaller size, but a 36px glyph in a sea of empty
              composer space still reads as small and crowded on a phone;
              this makes the actual button that size instead of just its
              hit box. */}
          <div ref={toolsMenuRef} className="composer-accessories relative shrink-0" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setToolsOpen(false) }}>
            {!voiceModeActive ? (
              <button
                type="button"
                className={`fa-press tap-target relative flex h-11 w-11 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-paper-sunken hover:text-ink md:h-9 md:w-9 ${toolsOpen ? 'bg-paper-sunken text-ink' : ''}`}
                onClick={() => {
                  haptic('light')
                  setToolsOpen((open) => !open)
                }}
                aria-label={toolsOpen ? 'Close composer actions' : 'More composer actions'}
                title={toolsOpen ? 'Close composer actions' : 'More composer actions'}
                aria-expanded={toolsOpen}
                aria-haspopup="menu"
                ref={toolsTriggerRef}
              >
                <Plus size={19} className={`transition-transform duration-200 md:size-[18px] ${toolsOpen ? 'rotate-45' : ''}`} aria-hidden="true" />
              </button>
            ) : null}
            {toolsOpen ? (
              <div className="composer-tools-menu" role="menu" aria-label="Composer actions">
                <button type="button" role="menuitem" className="composer-tools-item fa-press" disabled={isAttaching} onClick={() => { haptic('light'); setToolsOpen(false); fileInputRef.current?.click() }}>
                  {isAttaching ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Paperclip size={16} aria-hidden="true" />}<span>Attach a file</span>
                </button>
                {onModeChange && !isStreaming ? (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={mode === 'brainstorm'}
                    className={`composer-tools-item fa-press ${mode === 'brainstorm' ? 'bg-paper-sunken text-ink' : ''}`}
                    onPointerDown={(event) => {
                      // Default chat is talking through this week's plan.
                      // Select on pointer-down so the menu closes before the
                      // accessories blur handler runs.
                      event.preventDefault()
                      haptic('selection')
                      onModeChange('brainstorm')
                      setToolsOpen(false)
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      haptic('selection')
                      onModeChange('brainstorm')
                      setToolsOpen(false)
                    }}
                    title="Talk through this week's lesson plan"
                  >
                    <span className="font-semibold">This week</span>
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          <input
            ref={fileInputRef}
            id="composer-file"
            tabIndex={-1}
            className="sr-only"
            aria-label="Attach a PDF or text file"
            type="file"
            accept=".pdf,.txt,.md,.csv"
            multiple
            onChange={handleFile}
            disabled={isAttaching}
          />

          <div
            className={`relative min-w-0 flex-1 rounded-md ${motionState === 'accept' ? 'fa-input-flash' : ''}`}
          >
            <span className="sr-only" role="status" aria-live="polite">
              {suggestionAnnouncement}
            </span>
            <span id="composer-keyboard-hint" className="sr-only">
              Press Enter to send. Press Shift+Enter for a new line.
            </span>
            {completion ? (
              <div
                key={activeSuggestion?.id || 'none'}
                aria-hidden="true"
                // Keep the preview in the same centered, single-line row as
                // the real input. Vertical padding here used to make the
                // overlay's line box taller than the fixed composer and clip
                // the bottom of long ghost text.
                className={`composer-ghost-overlay pointer-events-none absolute inset-0 overflow-hidden ${COMPOSER_GHOST_METRICS}`}
              >
                <span className="composer-ghost-prefix text-ink">{value}</span>
                <span className="composer-ghost min-w-0 animate-slide-in-right text-ink-faint">
                  {completion}
                </span>
              </div>
            ) : null}
            <textarea
              id="composer-input"
              ref={textareaRef}
              rows={1}
              value={value}
              /* Suppressed while the ghost-completion overlay above is showing a
               * suggested prompt — that overlay already fills this space with its
               * own text, and the native placeholder pseudo-element isn't covered
               * by the textarea's text-transparent, so both rendered stacked on
               * top of each other. */
              placeholder={completion ? '' : isRecording ? 'Listening…' : isTranscribing ? 'Transcribing…' : placeholder}
              title="Enter to send · Shift+Enter for a new line"
              aria-keyshortcuts="Tab, Escape, Enter"
              aria-describedby="composer-keyboard-hint"
              /* COMPOSER_TEXT_METRICS (module scope, top of file), not each
                 side hardcoding its own copy — that's what let the real
                 textarea (py-2.5/text-sm) and the ghost-completion overlay
                 above it (py-[0.9375rem]/text-[0.9375rem]) drift apart in
                 the first place: a suggested prompt sat at a different
                 size and vertical position than the real text that
                 replaces it the instant you start typing (Josh's own "the
                 text is not centered when you type," 2026-08-27). One
                 constant now, so there's no second copy left to diverge.
                 The input now remains one line tall and scrolls internally for
                 a multiline draft. The shared COMPOSER_TEXT_METRICS keeps the
                 ghost preview and real draft on the same line-height and
                 padding so they never jump when typing starts. */
              className={`composer-input min-h-12 max-h-36 w-full resize-none overflow-x-hidden overflow-y-auto border-none bg-transparent ${COMPOSER_TEXT_METRICS} outline-none placeholder:font-normal placeholder:text-ink-muted placeholder:whitespace-nowrap placeholder:overflow-hidden placeholder:text-ellipsis transition-[color] duration-200 ease-out ${completion ? 'text-transparent caret-ink' : 'text-ink'}`}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={isRecording || isTranscribing}
            />
          </div>

          {/* One right-side action keeps the composer quiet: an empty field
              offers dictation, and the moment a draft exists it morphs into
              send. Recording, transcription, and streaming still take over
              the same control without shifting the composer layout. */}
          <div className="composer-action-cluster relative flex shrink-0 flex-row items-center">
            <button
              type="button"
              className={`fa-press tap-target relative flex h-11 w-11 items-center justify-center rounded-full transition-all duration-300 md:h-9 md:w-9 ${
                isRecording
                  ? 'fa-listening bg-mark text-white hover:bg-mark/90'
                  : isStreaming && onStop
                    ? 'bg-paper-raised text-ink-soft hover:shadow-sm'
                    : isStreaming
                      ? 'bg-transparent text-ink-muted'
                      : showSendAction
                        ? 'bg-accent text-accent-on hover:bg-accent-hover'
                        : 'bg-mark text-white hover:bg-mark/90 disabled:opacity-50'
              } ${motionState === 'submit' ? 'fa-settle' : motionState === 'ready' ? 'fa-ready-pop' : ''}`}
              onClick={
                isStreaming && onStop
                  ? onStop
                  : isStreaming || isTranscribing
                    ? undefined
                    : isRecording
                      ? stopRecording
                      : showSendAction
                        ? submit
                      : startRecording
              }
              onPointerDown={() => {
                if (!isStreaming && !isTranscribing) haptic(isRecording || showSendAction ? 'medium' : 'light')
              }}
              disabled={
                isTranscribing
                || (isStreaming && !onStop)
                || (!isRecording && !showSendAction && voiceModeActive)
                || (!isStreaming && showSendAction && !canSend)
              }
              aria-label={
                isStreaming && onStop
                  ? 'Pause reply'
                  : isTranscribing
                    ? 'Transcribing'
                    : isRecording
                      ? 'Stop recording'
                      : showSendAction
                        ? sendLabel
                        : voiceModeActive
                          ? 'Dictate (already listening in voice mode)'
                          : 'Dictate'
              }
              title={!isRecording && !isTranscribing && !showSendAction && voiceModeActive ? "Already listening — it's transcribing straight into the chat" : undefined}
            >
              <Mic
                size={19}
                className={`absolute transition-all duration-300 md:size-[18px] ${
                  !isRecording && !isTranscribing && !isStreaming && !showSendAction ? 'scale-100 rotate-0 opacity-100' : 'scale-50 -rotate-90 opacity-0'
                }`}
                aria-hidden="true"
              />
              <ArrowUp
                size={19}
                className={`absolute transition-all duration-300 md:size-[18px] ${
                  !isRecording && !isTranscribing && !isStreaming && showSendAction ? 'scale-100 rotate-0 opacity-100' : 'scale-50 rotate-90 opacity-0'
                }`}
                strokeWidth={3}
                aria-hidden="true"
              />
              <Loader2
                size={20}
                className={`absolute animate-spin transition-all duration-300 md:size-[18px] ${
                  isTranscribing || (isStreaming && !onStop) ? 'scale-100 opacity-100' : 'scale-50 opacity-0'
                }`}
                aria-hidden="true"
              />
              <Pause
                size={16}
                className={`absolute transition-all duration-300 md:size-[15px] ${
                  isStreaming && onStop ? 'scale-100 rotate-0 opacity-100' : 'scale-50 -rotate-90 opacity-0'
                }`}
                aria-hidden="true"
              />
              <Square
                size={15}
                className={`absolute transition-all duration-300 md:size-3.5 ${
                  isRecording && !(isStreaming && onStop) ? 'scale-100 rotate-0 opacity-100' : 'scale-50 -rotate-90 opacity-0'
                }`}
                fill="currentColor"
                aria-hidden="true"
              />
            </button>
          </div>
        </div>
      </div>

    </div>
  )
}
