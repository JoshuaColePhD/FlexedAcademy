import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, AudioLines, FileText, Loader2, Mic, Paperclip, Square, X } from 'lucide-react'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'
import { useVoice } from '../lib/voiceContext'

const MAX_H = 220

export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  isStreaming,
  attachments,
  setAttachments,
  onOpenVoice,
  focusOnMount = false,
  /* Composer is shared by the chat and (formerly) the plan surface, so the two
     strings that name the ACTION are props. Hardcoding "Build the lesson plan"
     meant a screen-reader user on the chat page was told the send button
     generates a document. */
  placeholder = 'What are you teaching?',
  sendLabel = 'Send',
  /* Optional context rendered inside the same bordered shell, above the input
     row — e.g. the week picker on an empty chat. Defaults to null so nothing
     about the shell's layout changes when there's nothing to show, and this
     component's own lifecycle-sensitive internals (MediaRecorder,
     ResizeObserver, autosize) never see a remount as the slot's content
     comes and goes. */
  topSlot = null,
}) {
  const toast = useToast()
  const voice = useVoice()
  const textareaRef = useRef(null)
  const wrapperRef = useRef(null)
  const mediaRecorder = useRef(null)
  const audioChunks = useRef([])
  const [isRecording, setIsRecording] = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [isAttaching, setIsAttaching] = useState(false)

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
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      mediaRecorder.current = recorder
      audioChunks.current = []
      recorder.ondataavailable = (e) => e.data.size > 0 && audioChunks.current.push(e.data)
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(audioChunks.current, { type: 'audio/webm' })
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
      setAttachments((prev) => [...prev, data])
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
    // A keydown is as much a real user gesture as a click — see the Send
    // button's own onClick for why this has to run somewhere other than
    // just voice's toggle.
    if (voice.enabled) voice.unlock()
    onSubmit()
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (canSend) submit()
    }
  }

  return (
    <div className="relative w-full">
      <div
        className="composer-shell relative flex w-full flex-col overflow-hidden rounded-xl border border-edge bg-paper-raised transition-colors"
        ref={wrapperRef}
      >
        {topSlot ? (
          <div className="border-b border-edge/70 bg-paper-sunken/40 px-3 py-1.5">{topSlot}</div>
        ) : null}
        {attachments.length > 0 ? (
          <div className="flex flex-wrap gap-2 px-3 pt-2.5">
            {attachments.map((f, i) => (
              <span
                className="flex items-center gap-1.5 rounded-md bg-paper-sunken px-2.5 py-1 text-xs font-medium text-ink"
                key={`${f.filename}-${i}`}
              >
                <FileText size={14} className="text-ink-muted" aria-hidden="true" />
                <span className="max-w-[120px] truncate">{f.filename}</span>
                <button
                  type="button"
                  className="ml-1 rounded-sm p-0.5 text-ink-muted transition-colors hover:bg-paper-inset hover:text-ink"
                  aria-label={`Remove ${f.filename}`}
                  onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </span>
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
            className="tap-target flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-paper-sunken hover:text-ink md:h-9 md:w-9"
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

          <textarea
            id="composer-input"
            ref={textareaRef}
            rows={1}
            value={value}
            placeholder={
              isRecording
                ? 'Listening…'
                : isTranscribing
                  ? 'Transcribing…'
                  : placeholder
            }
            title="Enter to send · Shift+Enter for a new line"
            className="composer-input max-h-[220px] flex-1 resize-none overflow-y-auto border-none bg-transparent px-2 py-[0.9375rem] text-[0.9375rem] leading-relaxed text-ink outline-none placeholder:font-normal placeholder:text-ink-faint"
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={isRecording || isTranscribing}
          />

          {/* gap-1.5, not gap-1 — at 44px buttons the tighter gap read as
              the icons overlapping their own tap targets. md:gap-1 restores
              the denser desktop spacing these were tuned for. */}
          <div className="flex shrink-0 items-center gap-1.5 pb-0.5 md:gap-1">
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
                className="tap-target flex h-11 w-11 items-center justify-center rounded-lg text-mark transition-colors hover:bg-mark-tint md:h-9 md:w-9"
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
                disabled={isStreaming}
                aria-label="Dictate"
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
                className="tap-target flex h-11 w-11 items-center justify-center rounded-full bg-ink text-ink-inverse transition-colors hover:bg-ink-soft md:h-9 md:w-9"
                onClick={onStop}
                aria-label="Stop generating"
              >
                <Square size={15} className="md:size-3.5" fill="currentColor" aria-hidden="true" />
              </button>
            ) : isStreaming ? (
              <span
                className="tap-target flex h-11 w-11 items-center justify-center rounded-full bg-paper-sunken text-ink-faint md:h-9 md:w-9"
                title="Revising — this can't be interrupted"
              >
                <Loader2 size={17} className="animate-spin md:size-4" aria-hidden="true" />
              </span>
            ) : !hasContent && onOpenVoice ? (
              /* The send slot's idle form. Nothing typed yet means there is
                 nothing TO send — Gemini's own composer makes the same call,
                 showing the live-voice entry point here instead of a greyed-
                 out arrow with nothing to do. The instant there's a
                 character (or an attachment) this same slot becomes the real
                 Send button below; it never sits alongside it as a second,
                 separate icon. */
              <button
                type="button"
                className="tap-target flex h-11 w-11 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-paper-sunken hover:text-ink md:h-9 md:w-9"
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
                   whole bar. */
                className={`tap-target flex h-11 w-11 items-center justify-center rounded-full transition-all md:h-9 md:w-9 ${
                  canSend
                    ? 'bg-accent text-ink-inverse hover:bg-accent-hover active:scale-95'
                    : 'cursor-not-allowed bg-paper-sunken text-ink-faint'
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
