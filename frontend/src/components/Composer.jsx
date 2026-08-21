import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
  // Whether this conversation has any turns yet — the empty composer's one
  // suggestion is a ghost-text completion (Tab, nothing else on screen);
  // once there's an actual back-and-forth, a text suggestion (continue-
  // draft, review-current-plan, ...) switches to a clickable card instead.
  // Showing both at once for the same suggestion read as the same thing
  // said twice.
  hasMessages = false,
  onOpenVoice,
  suggestions = [],
  contextLabel = '',
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
  const [isRecording, setIsRecording] = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [isAttaching, setIsAttaching] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [isFocused, setIsFocused] = useState(false)
  const [trayDismissed, setTrayDismissed] = useState(false)
  const [motionState, setMotionState] = useState('')
  const motionTimerRef = useRef(null)

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

  const contextSignature = useMemo(
    () => suggestions.map((item) => `${item.id}:${item.prompt}:${item.contextLabel || ''}`).join('|'),
    [suggestions]
  )
  const previousContextSignature = useRef(contextSignature)
  useEffect(() => {
    if (previousContextSignature.current && previousContextSignature.current !== contextSignature) {
      pulseMotion('context', 260)
    }
    previousContextSignature.current = contextSignature
  }, [contextSignature, pulseMotion])

  // ChatPage never hands this an action: 'open-settings' suggestion
  // (add-pacing-guide, add-school-calendar) — those have no sentence to
  // type or send, so they're the Greeting's own inline hint instead (see
  // ChatPage's emptyStateHint). Whatever's here is always a real ghost-
  // text/card candidate.
  const textSuggestion = candidateSuggestions[0] || null
  const activeSuggestion = textSuggestion
  const completion = useMemo(
    () => (hasMessages || !activeSuggestion ? '' : suggestionCompletion(value, activeSuggestion)),
    [hasMessages, activeSuggestion, value]
  )

  const trayOpen =
    isFocused &&
    !trayDismissed &&
    !voiceModeActive &&
    !isRecording &&
    !isTranscribing &&
    !isStreaming &&
    hasMessages &&
    Boolean(textSuggestion)

  const autosize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_H)}px`
  }, [])

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

  const handleFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    // Its own flag — the old code reused isGenerating, so parsing a PDF showed
    // the assistant's typing indicator.
    setIsAttaching(true)
    try {
      const data = await api.extractText(file)
      // The raw File alongside the extracted text — not read again, just
      // kept in case onSaveAttachmentAsDocument wants to upload the exact
      // same bytes as a real class document later.
      setAttachments((prev) => [...prev, { ...data, file }])
      toast.success(`Attached ${data.filename}`, `${data.chars.toLocaleString()} characters`)
    } catch (err) {
      toast.error(`Could not read ${file.name}`, err.hint || err.message)
    } finally {
      setIsAttaching(false)
    }
  }


  const handleDragOver = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  const handleDragLeave = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  const handleDrop = async (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    setIsAttaching(true)
    try {
      const data = await api.extractText(file)
      setAttachments((prev) => [...prev, { ...data, file }])
      toast.success(`Attached ${data.filename}`, `${data.chars.toLocaleString()} characters`)
    } catch (err) {
      toast.error(`Could not read ${file.name}`, err.hint || err.message)
    } finally {
      setIsAttaching(false)
    }
  }

  const hasContent = value.trim().length > 0 || attachments.length > 0

  const canSend = hasContent && !isStreaming && !isRecording && !isTranscribing

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
    // review-plan is the one card whose click already IS the decision — "yes,
    // review it" — unlike a card like continue-draft or prepare-next-week,
    // whose prompt is a starting point the teacher might still want to edit
    // before sending. Filling the box and making them also hit Enter/click
    // Send bought nothing over just typing the sentence themselves; sending
    // outright is the actual shortcut a click is supposed to be.
    if (suggestionToAccept.action === 'review-plan' && !value) {
      pulseMotion('submit', 320)
      onSubmit(suggestionToAccept.prompt)
      setTrayDismissed(false)
      return
    }
    const typedPrefixMatches = value && suggestionToAccept.prompt.toLocaleLowerCase().startsWith(value.toLocaleLowerCase())
    const remaining = typedPrefixMatches ? suggestionToAccept.prompt.slice(value.length) : ''
    if (value && !remaining) return
    const nextValue = value && remaining ? `${value}${remaining}` : suggestionToAccept.prompt
    pulseMotion('accept', 300)
    onChange(nextValue)
    setTrayDismissed(false)
    requestAnimationFrame(() => {
      const input = textareaRef.current
      input?.focus()
      input?.setSelectionRange(nextValue.length, nextValue.length)
    })
  }

  const onKeyDown = (e) => {
    if (e.key === 'Tab' && trayOpen && completion) {
      e.preventDefault()
      acceptSuggestion()
      return
    }
    if (e.key === 'Escape' && trayOpen) {
      e.preventDefault()
      setTrayDismissed(true)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (canSend) submit()
    }
  }

  return (
    <div className="relative w-full">
      <div
        className={`composer-shell relative flex w-full flex-col overflow-hidden border border-edge bg-paper-raised transition-all ${
          voiceModeActive ? 'rounded-3xl' : 'rounded-xl'
        } ${isDragging ? 'ring-2 ring-accent' : ''} ${motionState === 'accept' ? 'fa-composer-accept' : ''}`}
        ref={wrapperRef}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDragging && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-paper-raised/90 backdrop-blur-sm rounded-inherit">
            <p className="text-sm font-semibold text-accent-text flex items-center gap-2">
              <Upload size={16} /> Drop file to attach
            </p>
          </div>
        )}
        {voicePanel}
        {questionsPanel}

        <div
          id="composer-recommendations"
          className={`composer-recommendations${trayOpen ? ' is-open' : ''} ${motionState === 'context' ? 'fa-context-pop' : ''}`}
          aria-hidden={!trayOpen}
        >
          <div className="composer-recommendations-inner">
            {contextLabel ? (
              <div className="px-3 pt-3 text-[0.6875rem] font-medium uppercase tracking-[0.08em] text-ink-faint">
                {contextLabel}
              </div>
            ) : null}
            <div className="flex flex-col gap-1 p-2">
              {/* A click here is the only way to accept a card — no Tab;
                  see `completion` above, which is deliberately empty once
                  hasMessages is true. review-plan sends on click instead of
                  just filling the box (see acceptSuggestion) — its arrow
                  glyph marks that it's a one-click send, not a draft to edit
                  first, the way every other card's click behaves. */}
              {textSuggestion ? (
                <button
                  type="button"
                  tabIndex={trayOpen ? 0 : -1}
                  className="composer-recommendation neo-inset flex items-start gap-3 rounded-lg bg-paper-sunken px-3 py-2 text-left transition-colors"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => acceptSuggestion(textSuggestion)}
                >
                  {textSuggestion.action === 'review-plan' ? (
                    <ArrowUp size={14} className="mt-0.5 shrink-0 text-ink-muted" aria-hidden="true" />
                  ) : null}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-ink">{textSuggestion.label || textSuggestion.prompt}</span>
                    {textSuggestion.reason ? (
                      <span className="composer-recommendation-reason mt-0.5 block text-xs text-ink-muted">
                        {textSuggestion.reason}
                      </span>
                    ) : null}
                  </span>
                </button>
              ) : null}
            </div>
          </div>
        </div>

        {attachments.length > 0 ? (
          <div className="flex flex-wrap gap-2 px-3 pt-2.5">
            {attachments.map((f, i) => (
              <Chip
                key={`${f.filename}-${i}`}
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
          <label className="sr-only" htmlFor="composer-input">
            Describe the week you want to plan
          </label>

          {/* h-11/w-11 (44px, Apple/Android's own touch-target minimum)
              below md, dropping to the desktop-density h-9 at md and up —
              .tap-target already padded an INVISIBLE hit area out to 44px
              at the smaller size, but a 36px glyph in a sea of empty
              composer space still reads as small and crowded on a phone;
              this makes the actual button that size instead of just its
              hit box. */}
          <label
            className="fa-press tap-target mb-1.5 flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-paper-sunken hover:text-ink md:mb-2 md:h-9 md:w-9"
            htmlFor="composer-file"
          >
            {isAttaching ? (
              <Loader2 size={19} className="animate-spin md:size-[18px]" aria-hidden="true" />
            ) : (
              <Paperclip size={19} className="md:size-[18px]" aria-hidden="true" />
            )}
            <span className="sr-only">Attach a PDF or text file</span>
          </label>
          <input
            id="composer-file"
            className="sr-only"
            aria-label="Attach a PDF or text file"
            type="file"
            accept=".pdf,.txt,.md,.csv"
            onChange={handleFile}
            disabled={isAttaching}
          />

          <div className="relative min-w-0 flex-1">
            {completion ? (
              <div
                key={activeSuggestion?.id || 'none'}
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-2 top-0 bottom-0 overflow-hidden whitespace-pre-wrap break-words px-0 py-[0.9375rem] text-[0.9375rem] leading-relaxed"
              >
                <span className="text-ink">{value}</span><span className="composer-ghost text-ink-faint">{completion}</span>
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
              aria-expanded={trayOpen}
              aria-controls="composer-recommendations"
              className={`composer-input max-h-[220px] w-full resize-none overflow-y-auto border-none bg-transparent px-0 py-[0.9375rem] text-[0.9375rem] leading-relaxed outline-none placeholder:font-normal placeholder:text-ink-faint ${completion ? 'text-transparent caret-ink' : 'text-ink'}`}
              onChange={(e) => {
                setTrayDismissed(false)
                onChange(e.target.value)
              }}
              onFocus={() => {
                setIsFocused(true)
                setTrayDismissed(false)
              }}
              onBlur={(e) => {
                if (!wrapperRef.current?.contains(e.relatedTarget)) setIsFocused(false)
              }}
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
            {isTranscribing ? (
              <button
                type="button"
                className="tap-target flex h-11 w-11 items-center justify-center rounded-lg text-ink-muted md:h-9 md:w-9"
                disabled
                aria-label="Transcribing"
              >
                <Loader2 size={19} className="animate-spin md:size-[18px]" aria-hidden="true" />
              </button>
            ) : isRecording ? (
              <button
                type="button"
                /* fa-listening: the tinted background already says "recording
                   is on," a fact — this ring says the mic is live RIGHT NOW,
                   an ongoing one, the way a hardware recording light doesn't
                   just switch on but keeps pulsing for as long as it's true. */
                className="fa-listening tap-target flex h-11 w-11 items-center justify-center rounded-lg text-mark transition-colors hover:bg-mark-tint md:h-9 md:w-9"
                onClick={stopRecording}
                aria-label="Stop recording"
              >
                <Square size={17} className="md:size-4" fill="currentColor" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                className="tap-target flex h-11 w-11 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-paper-sunken hover:text-ink disabled:opacity-50 md:h-9 md:w-9"
                onClick={startRecording}
                disabled={isStreaming || voiceModeActive}
                aria-label={voiceModeActive ? 'Dictate (already listening in voice mode)' : 'Dictate'}
                title={voiceModeActive ? "Already listening — it's transcribing straight into the chat" : undefined}
              >
                <Mic size={19} className="md:size-[18px]" aria-hidden="true" />
              </button>
            )}

            {/* Stop only when there is something abortable. `isStreaming` is
                true during a revision too, but revisePlan/reviseDay have no
                AbortController — so this rendered a Stop square that did
                nothing for 20-40 seconds. Without onStop it's a spinner, which
                is at least honest about being un-interruptible. */}
            {isStreaming && onStop ? (
              <button
                type="button"
                className="fa-press neo-raised tap-target flex h-11 w-11 items-center justify-center rounded-full bg-mark-tint text-mark transition-shadow md:h-9 md:w-9"
                onClick={onStop}
                aria-label="Stop generating"
              >
                <Square size={15} className="md:size-3.5" fill="currentColor" aria-hidden="true" />
              </button>
            ) : isStreaming ? (
              <span
                className="neo-inset tap-target flex h-11 w-11 items-center justify-center rounded-full bg-paper-sunken text-ink-faint md:h-9 md:w-9"
                title="Revising — this can't be interrupted"
              >
                <Loader2 size={17} className="animate-spin md:size-4" aria-hidden="true" />
              </span>
            ) : !hasContent && onOpenVoice && !voiceModeActive ? (
              /* The send slot's idle form. Nothing typed yet means there is
                 nothing TO send — Gemini's own composer makes the same call,
                 showing the live-voice entry point here instead of a greyed-
                 out arrow with nothing to do. The instant there's a
                 character (or an attachment) this same slot becomes the real
                 Send button below; it never sits alongside it as a second,
                 separate icon. Hidden (not just disabled) while voiceModeActive
                 — the conversation this button starts is already the one
                 open on screen, so it has nothing left to do. */
              <button
                type="button"
                /* text-accent-text at rest, not ink-muted — sitting right
                   beside the plain grey dictate mic (Mic icon, above), this
                   button used to read as a near-identical twin at a glance:
                   same size, same neutral colour, same hover, just a
                   different glyph. Voice mode is a whole conversation, not a
                   second way to fill the text box, and it's the one place
                   in the composer that's allowed to hint at that with
                   colour — the accent tint on hover is the same "this opens
                   something" language RailRow's own icon tiles use. */
                className="fa-press tap-target flex h-11 w-11 items-center justify-center rounded-full text-ink transition-colors hover:bg-paper-sunken md:h-9 md:w-9"
                onClick={onOpenVoice}
                aria-label="Start a voice conversation"
                title="Talk instead of type"
              >
                <AudioLines size={19} className="md:size-[18px]" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                /* bg-accent, not bg-ink: the district blue is the app's own
                   established "this is the primary action" color (see the
                   filled buttons on ClassPage) — a plain black circle here
                   just wasn't reading as the one button that matters on the
                   whole bar. Was bg-accent-tint (a pastel wash) despite this
                   comment already arguing for the full fill — the tint never
                   actually landed here. */
                className={`${motionState === 'submit' ? 'fa-settle ' : ''}fa-press tap-target flex h-11 w-11 items-center justify-center rounded-full transition-all md:h-9 md:w-9 ${
                  canSend
                    ? 'neo-raised bg-paper-raised text-ink hover:bg-paper-sunken'
                    : /* Inset, not a flat grey disc: unavailable reads as
                         pressed into the bar and out of reach, which is the
                         same language the rest of the app uses for "not
                         something you can act on right now." */
                      'neo-inset cursor-not-allowed bg-paper-sunken text-ink-faint'
                }`}
                onClick={submit}
                disabled={!canSend}
                aria-label={sendLabel}
              >
                <ArrowUp size={19} className="md:size-[18px]" strokeWidth={3} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </div>

    </div>
  )
}
