import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
// Upload is used by the drag-and-drop overlay below and was missing from this
// list — the overlay only renders while a file is actually being dragged over
// the composer, so the ReferenceError sat there unnoticed by anything but a
// linter until someone dragged a file.
import { ArrowUp, AudioLines, FileText, Loader2, Mic, Paperclip, Square, Upload, X } from 'lucide-react'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'
import { useExitTransition } from '../hooks/useExitTransition'
import { suggestionCompletion } from '../lib/contextualSuggestions'

const MAX_H = 220
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
// The composer shell has an 8px bottom gutter for its action controls. Equal
// textarea padding therefore looks optically high: its text is centered in
// the textarea, but not in the composer as a whole. Keep the same total
// padding (and therefore the same autosized height), with four pixels moved
// from below the line to above it so the text's visual centre is the shell's.
const COMPOSER_TEXT_METRICS = 'px-0 pt-[1.1875rem] pb-[0.6875rem] text-[0.9375rem] leading-relaxed'

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
  // Offers each attachment chip a way to become a real, durable class
  // document instead of only ever riding into this one conversation. Kept
  // null (no offer shown) whenever there's no class in scope, or it already
  // has a pacing guide — see ChatPage's own gating.
  onSaveAttachmentAsDocument = null,
  onOpenVoice,
  suggestions = [],
  /* Kept for callers outside the main chat surface while they migrate to the
     shared suggestion model. It is converted into the same shape below. */
  suggestion = null,
  /* True while ChatPage's own voice-dock panel is open. That panel already
     has its own always-on mic listening for speech — letting the
     composer's separate dictate-into-text mic run at the same time meant
     two different "I'm listening" affordances competing for the same
     microphone and the same attention. Dictate disables outright; the
     "start a voice conversation" entry point (below) just hides, since the
     conversation it starts is already the one on screen. */
  voiceModeActive = false,
  voicePanel = null,
  // The text-mode twin of voicePanel — a clarification round docked above
  // the input instead of stuck mid-transcript (see ChatPage's
  // questionsExit/lastQuestions and LessonQuestions). Same slot shape, same
  // "the composer grows to make room for it" read; the two never show at
  // once, since voice mode surfaces its own questions through voicePanel.
  questionsPanel = null,
  focusOnMount = false,
  /* Composer is shared by the chat and (formerly) the plan surface, so the two
     strings that name the ACTION are props. Hardcoding "Build the lesson plan"
     meant a screen-reader user on the chat page was told the send button
     generates a document. */
  placeholder = 'What are you teaching? (Press ⌘K for actions)',
  sendLabel = 'Send',
}) {
  const toast = useToast()
  const textareaRef = useRef(null)
  const wrapperRef = useRef(null)
  const mediaRecorder = useRef(null)
  const audioChunks = useRef([])
  // Stamped onto each attachment as `_id` at attach-time — see Chip's own
  // key comment below for why filename+index wasn't a safe key.
  const attachmentIdRef = useRef(0)
  const [isRecording, setIsRecording] = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [isAttaching, setIsAttaching] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [shake, setShake] = useState(false)
  const [motionState, setMotionState] = useState('')
  const motionTimerRef = useRef(null)

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
  // text candidate — the composer itself never renders a suggestion as a
  // clickable card any more. The one thing that visually opens this box is
  // an actual clarifying-questions round (questionsPanel below); a mere
  // suggestion, however specific, is text you can Tab to accept and nothing
  // more, the same contract VS Code's own inline completion keeps.
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
  const completion = activeSuggestion && !isDismissed ? suggestionCompletion(value, activeSuggestion) : ''

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

  // Whether the box is already at MAX_H and scrolling instead of still
  // growing — the moment content FIRST crosses that line is the one point
  // in typing (or pasting) a long prompt that's worth a signal; every
  // keystroke after that is already scrolling and needs no repeat cue.
  const wasCappedRef = useRef(false)
  const autosize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const capped = el.scrollHeight > MAX_H
    el.style.height = `${Math.min(el.scrollHeight, MAX_H)}px`
    if (capped && !wasCappedRef.current) pulseMotion('capped', 450)
    wasCappedRef.current = capped
  }, [pulseMotion])

  useLayoutEffect(autosize, [value, autosize])

  /* Only when asked. The composer is the primary control on an empty screen, so
     focusing it there is right; doing it unconditionally would steal focus every
     time the panel re-renders. */
  useEffect(() => {
    if (focusOnMount) textareaRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-measure once webfonts land and whenever the width changes. Without this
  // the first measurement happens while the fallback font is still in use — the
  // placeholder wraps to far more lines, and the box gets stuck at max height
  // because `value` never changes to trigger another pass.
  useEffect(() => {
    document.fonts?.ready.then(autosize)
    // Observe the wrapper, not the textarea — autosize changes the textarea's own
    // height, which would re-trigger an observer watching it.
    const ro = new ResizeObserver(autosize)
    if (wrapperRef.current) ro.observe(wrapperRef.current)
    return () => ro.disconnect()
  }, [autosize])

  const startRecording = async () => {
    try {
      // Same constraints as VoiceModePanel's mic request — noise
      // suppression and auto gain help transcription quality generally,
      // not just the echo case live voice mode has to worry about.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      const recorder = new MediaRecorder(stream)
      mediaRecorder.current = recorder
      audioChunks.current = []
      recorder.ondataavailable = (e) => e.data.size > 0 && audioChunks.current.push(e.data)
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        // recorder.mimeType, not a hardcoded 'audio/webm' — MediaRecorder's
        // default container varies by browser (webm/opus on Chrome/Firefox,
        // mp4/aac on Safari/iOS), and api.transcribe() picks the upload
        // extension from this Blob's own `type`. Hardcoding it here meant
        // every Safari recording was uploaded mislabeled as .webm regardless
        // of what was actually recorded, and Whisper's decoder disagreed
        // with the real container.
        const blob = new Blob(audioChunks.current, { type: recorder.mimeType || 'audio/webm' })
        setIsTranscribing(true)
        try {
          const { text } = await api.transcribe(blob)
          onChange(value ? `${value.trim()} ${text}` : text)
        } catch (err) {
          toast.error('Could not transcribe that', err.hint || err.message)
        } finally {
          setIsTranscribing(false)
        }
      }
      recorder.start()
      setIsRecording(true)
    } catch {
      toast.error('No microphone access', 'Allow microphone access in your browser settings.')
    }
  }

  const stopRecording = () => {
    mediaRecorder.current?.stop()
    setIsRecording(false)
  }

  /* The tracks are stopped inside recorder.onstop, which never runs if the
     component goes away first — so starting to dictate and then clicking
     another chat left the recorder orphaned and the browser's red recording
     dot lit on the tab indefinitely. */
  useEffect(
    () => () => {
      const rec = mediaRecorder.current
      if (rec && rec.state !== 'inactive') rec.stop()
      rec?.stream?.getTracks?.().forEach((t) => t.stop())
    },
    []
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
    [toast, triggerShake]
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
    onSubmit()
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

  // rounded-full is a single-line pill — right for the default composer,
  // wrong the instant questionsPanel/voicePanel grows this shell to several
  // lines tall: a 9999px radius on a tall box reads as two huge semicircle
  // caps top and bottom, and overflow-hidden then clips the square-cornered
  // content inside those caps (the first few characters of the top row of
  // LessonQuestions' own card, in practice). Both docks used to share this
  // shell's radius unconditionally; this is the same "the composer visibly
  // grows to make room" moment .questions-dock's own comment describes,
  // so the shell's shape has to grow with it, not stay pill-shaped.
  const isExpanded = Boolean(questionsPanel) || voiceModeActive
  return (
    <div className="relative w-full">
      <div
        className={`composer-shell relative flex w-full flex-col overflow-hidden border border-edge bg-paper transition-all focus-within:scale-[1.01] focus-within:ring-1 focus-within:ring-accent/50 ${
          isExpanded ? 'rounded-[28px]' : 'rounded-full shadow-sm'
        } ${isDragging ? 'ring-2 ring-accent' : ''} ${isRecording ? 'ring-2 ring-mark/50 shadow-[0_0_15px_rgba(var(--mark-rgb),0.3)]' : ''} ${shake ? 'animate-error-shake' : ''} ${motionState === 'accept' ? 'fa-composer-accept' : ''}`}
        ref={wrapperRef}
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
        {voicePanel}
        {/* The one thing that visually opens the composer — an actual
            clarifying-questions round (LessonQuestions, docked here by
            ChatPage). A plain suggestion, however specific, never grows the
            box any more; it's ghost text only (see `completion` below),
            the same VS Code inline-completion contract: Tab to accept,
            keep typing to ignore, nothing to click. */}
        {questionsPanel}

        {attachments.length > 0 ? (
          <div className="flex flex-wrap gap-2 px-3 pt-2.5">
            {attachments.map((f) => (
              <Chip
                // Was `${f.filename}-${i}` — a removed chip only leaves the
                // array once its own 150ms exit animation finishes
                // (useExitTransition below), so removing two chips within
                // that window reindexes everything after the first one to
                // finish. That changed a still-animating chip's key mid-exit,
                // which React reads as an entirely new element: it remounted
                // fresh (mounted: true, closing: false) and visibly snapped
                // back to fully opaque instead of finishing its fade. `_id`
                // is stamped once at attach time and never depends on
                // position, so a sibling's removal can't touch it.
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
          className={`relative flex min-h-[60px] items-end px-2 pb-2 transition-colors ${isRecording ? 'bg-mark-tint' : ''}`}
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
          <label
            className="fa-press tap-target relative mb-1.5 flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-paper-sunken hover:text-ink md:mb-2 md:h-9 md:w-9"
            htmlFor="composer-file"
          >
            {/* Same stacked-icon cross-fade the send button uses (below) —
                was a hard swap straight to the spinner, the one task-state
                change in this bar with no motion of its own. */}
            <Paperclip
              size={19}
              className={`absolute transition-all duration-300 md:size-[18px] ${
                isAttaching ? 'scale-50 -rotate-90 opacity-0' : 'scale-100 rotate-0 opacity-100'
              }`}
              aria-hidden="true"
            />
            <Loader2
              size={19}
              className={`absolute animate-spin transition-all duration-300 md:size-[18px] ${
                isAttaching ? 'scale-100 opacity-100' : 'scale-50 opacity-0'
              }`}
              aria-hidden="true"
            />
            <span className="sr-only">Attach a PDF or text file</span>
          </label>
          <input
            id="composer-file"
            className="sr-only"
            aria-label="Attach a PDF or text file"
            type="file"
            accept=".pdf,.txt,.md,.csv"
            multiple
            onChange={handleFile}
            disabled={isAttaching}
          />

          <div
            className={`relative min-w-0 flex-1 rounded-md ${
              motionState === 'accept' || motionState === 'capped' ? 'fa-input-flash' : ''
            }`}
          >
            <span className="sr-only" role="status" aria-live="polite">
              {suggestionAnnouncement}
            </span>
            {completion ? (
              <div
                key={activeSuggestion?.id || 'none'}
                aria-hidden="true"
                // whitespace-nowrap, not pre-wrap: this overlay is pinned to
                // top-0/bottom-0 to match the (empty, one-line-tall)
                // textarea behind it, with overflow-hidden on top of that —
                // on a phone-width composer, a full untyped suggestion
                // ("Let's review this plan.") routinely needs 2 lines,
                // and the second one was getting silently clipped by the
                // rounded pill's own bottom curve, right where "Tab ⇥"
                // lives. A ghost preview is meant to be glanced at and
                // accepted or ignored, not fully read multi-line — clip
                // at the visible edge on one line (matching how VS Code's
                // own inline completions behave) instead of wrapping into
                // a line nothing can actually see.
                className={`pointer-events-none absolute inset-x-2 top-0 bottom-0 overflow-hidden whitespace-nowrap ${COMPOSER_TEXT_METRICS}`}
              >
                <span className="text-ink">{value}</span>
                <span className="composer-ghost animate-slide-in-right text-ink-faint">
                  {completion}
                  <span className="ml-2 inline-flex items-center gap-1 rounded bg-paper-sunken px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-ink-muted ring-1 ring-inset ring-edge">
                    Tab ⇥
                  </span>
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
              /* COMPOSER_TEXT_METRICS (module scope, top of file), not each
                 side hardcoding its own copy — that's what let the real
                 textarea (py-2.5/text-sm) and the ghost-completion overlay
                 above it (py-[0.9375rem]/text-[0.9375rem]) drift apart in
                 the first place: a suggested prompt sat at a different
                 size and vertical position than the real text that
                 replaces it the instant you start typing (Josh's own "the
                 text is not centered when you type," 2026-08-27). One
                 constant now, so there's no second copy left to diverge.
                 On a phone this also fixed a second thing:
                 .composer-input's own min-height: 54px (base.css, the iOS
                 zoom fix) was taller than one line's worth of the old
                 10px/10px padding + line-height, so the leftover space
                 collected entirely below the text instead of splitting
                 evenly — confirmed live (10px padding, 26px line-height,
                 inside a forced 54px box, textarea content doesn't
                 self-center). COMPOSER_TEXT_METRICS provides 30px total
                 vertical padding (past the 54px floor with the line height)
                 and biases 4px toward the top to account for the shell's
                 bottom action gutter, so the text is centered in the
                 visible composer rather than merely its textarea. */
              className={`composer-input max-h-[220px] w-full resize-none overflow-y-auto border-none bg-transparent ${COMPOSER_TEXT_METRICS} outline-none placeholder:font-normal placeholder:text-ink-faint transition-[height,color] duration-200 ease-out ${completion ? 'text-transparent caret-ink' : 'text-ink'}`}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={isRecording || isTranscribing}
            />
          </div>

          {/* gap-1.5, not gap-1 — at 44px buttons the tighter gap read as
              the icons overlapping their own tap targets. md:gap-1 restores
              the denser desktop spacing these were tuned for.
              Always a row, never stacked — this used to be flex-col below
              sm, on the theory that stacking left the Send button less
              crowded. In practice it made the whole composer noticeably
              taller on a phone (two 44px buttons stacked is a ~94px column)
              for a bar that reads as a single-line input everywhere else in
              the app, and stacking the dictate mic above the voice-mode
              button read as two disconnected controls rather than one
              cluster. A row keeps the bar's height constant regardless of
              which button is showing. */}
          <div className="flex flex-row shrink-0 items-center gap-1.5 mb-1.5 md:mb-2 md:gap-1">
            {/* One persistent button now, not three swapped in and out —
                a swapped-out button unmounts outright, so nothing about a
                plain CSS transition could ever animate THAT change; only an
                icon morphing in place on the same element can. Same stacked
                cross-fade as the send button below, across all three of
                this control's states instead of just two. */}
            <button
              type="button"
              className={`tap-target relative flex h-11 w-11 items-center justify-center rounded-lg transition-colors md:h-9 md:w-9 ${
                isRecording
                  ? /* fa-listening: the tinted background already says
                       "recording is on," a fact — this ring says the mic is
                       live RIGHT NOW, an ongoing one, the way a hardware
                       recording light doesn't just switch on but keeps
                       pulsing for as long as it's true. */
                    'fa-listening text-mark hover:bg-mark-tint'
                  : 'text-ink-muted hover:bg-paper-sunken hover:text-ink disabled:opacity-50'
              }`}
              onClick={isTranscribing ? undefined : isRecording ? stopRecording : startRecording}
              disabled={isTranscribing || (!isRecording && (isStreaming || voiceModeActive))}
              aria-label={
                isTranscribing
                  ? 'Transcribing'
                  : isRecording
                    ? 'Stop recording'
                    : voiceModeActive
                      ? 'Dictate (already listening in voice mode)'
                      : 'Dictate'
              }
              title={
                !isRecording && !isTranscribing && voiceModeActive
                  ? "Already listening — it's transcribing straight into the chat"
                  : undefined
              }
            >
              <Mic
                size={19}
                className={`absolute transition-all duration-300 md:size-[18px] ${
                  !isRecording && !isTranscribing ? 'scale-100 rotate-0 opacity-100' : 'scale-50 -rotate-90 opacity-0'
                }`}
                aria-hidden="true"
              />
              <Square
                size={17}
                className={`absolute transition-all duration-300 md:size-4 ${
                  isRecording ? 'scale-100 rotate-0 opacity-100' : 'scale-50 rotate-90 opacity-0'
                }`}
                fill="currentColor"
                aria-hidden="true"
              />
              <Loader2
                size={19}
                className={`absolute animate-spin transition-all duration-300 md:size-[18px] ${
                  isTranscribing ? 'scale-100 opacity-100' : 'scale-50 opacity-0'
                }`}
                aria-hidden="true"
              />
            </button>

            {!hasContent && onOpenVoice && !voiceModeActive && !isStreaming ? (
              <button
                type="button"
                className="fa-press tap-target relative flex h-11 w-11 items-center justify-center rounded-full text-ink transition-colors hover:bg-paper-sunken md:h-9 md:w-9"
                onClick={() => {
                  // The dock this opens animates in on its own slow
                  // (--t-slow) grid transition — by the time it's visibly
                  // moving, this button is already gone (voiceModeActive
                  // stops rendering this branch). Without its own brief
                  // acknowledgment the tap itself was the one moment in this
                  // whole bar with zero feedback between "pressed" and "the
                  // dock is now open."
                  pulseMotion('voice', 260)
                  onOpenVoice()
                }}
                aria-label="Start a voice conversation (beta)"
                title="Talk instead of type — beta"
              >
                <AudioLines
                  size={19}
                  className={`absolute transition-all duration-300 md:size-[18px] ${
                    motionState === 'voice' ? 'scale-50 rotate-90 opacity-0' : 'scale-100 rotate-0 opacity-100'
                  }`}
                  aria-hidden="true"
                />
                <Loader2
                  size={19}
                  className={`absolute animate-spin transition-all duration-300 md:size-[18px] ${
                    motionState === 'voice' ? 'scale-100 opacity-100' : 'scale-50 opacity-0'
                  }`}
                  aria-hidden="true"
                />
              </button>
            ) : (
              <button
                type="button"
                className={`fa-press tap-target relative flex h-11 w-11 items-center justify-center rounded-full transition-all duration-300 md:h-8 md:w-8 ${
                  isStreaming && onStop ? 'bg-mark-tint text-mark hover:shadow-sm'
                  : isStreaming ? 'bg-transparent text-ink-muted'
                  : canSend ? 'bg-ink text-ink-inverse hover:opacity-90'
                  : 'cursor-not-allowed bg-paper-inset text-ink-faint'
                } ${motionState === 'submit' ? 'fa-settle' : motionState === 'ready' ? 'fa-ready-pop' : ''}`}
                onClick={isStreaming && onStop ? onStop : isStreaming ? undefined : submit}
                disabled={(!canSend && !isStreaming) || (isStreaming && !onStop)}
                aria-label={isStreaming && onStop ? "Stop generating" : sendLabel}
              >
                <ArrowUp size={19} className={`absolute transition-all duration-300 md:size-[18px] ${isStreaming ? 'scale-50 opacity-0 rotate-90' : 'scale-100 opacity-100 rotate-0'}`} strokeWidth={3} aria-hidden="true" />
                <Loader2 size={20} className={`absolute animate-spin transition-all duration-300 md:size-[18px] ${isStreaming && !onStop ? 'scale-100 opacity-100' : 'scale-50 opacity-0'}`} aria-hidden="true" />
                <Square size={15} className={`absolute transition-all duration-300 md:size-3.5 ${isStreaming && onStop ? 'scale-100 opacity-100' : 'scale-50 opacity-0'}`} fill="currentColor" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </div>

    </div>
  )
}
