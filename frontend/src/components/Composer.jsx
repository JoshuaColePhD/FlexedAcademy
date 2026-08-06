import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, FileText, Loader2, Mic, Paperclip, Square, X } from 'lucide-react'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'

const MAX_H = 220

export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  isStreaming,
  attachments,
  setAttachments,
  focusOnMount = false,
  /* Composer is shared by the chat and (formerly) the plan surface, so the two
     strings that name the ACTION are props. Hardcoding "Build the lesson plan"
     meant a screen-reader user on the chat page was told the send button
     generates a document. */
  placeholder = 'What are you teaching?',
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

  const canSend = (value.trim() || attachments.length > 0) && !isStreaming && !isRecording && !isTranscribing

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (canSend) onSubmit()
    }
  }

  return (
    <div className="relative w-full">
      <div
        className="relative flex w-full flex-col overflow-hidden rounded-xl border border-edge bg-paper-raised transition-colors focus-within:border-edge-strong"
        ref={wrapperRef}
      >
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

          <label
            className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-paper-sunken hover:text-ink"
            htmlFor="composer-file"
          >
            {isAttaching ? (
              <Loader2 size={18} className="animate-spin" aria-hidden="true" />
            ) : (
              <Paperclip size={18} aria-hidden="true" />
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
            className="max-h-[220px] flex-1 resize-none overflow-y-auto border-none bg-transparent px-2 py-[0.9375rem] text-[0.9375rem] leading-relaxed text-ink outline-none placeholder:font-normal placeholder:text-ink-faint"
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={isRecording || isTranscribing}
          />

          <div className="flex shrink-0 items-center gap-1 pb-0.5">
            {isTranscribing ? (
              <button
                type="button"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-muted"
                disabled
                aria-label="Transcribing"
              >
                <Loader2 size={18} className="animate-spin" aria-hidden="true" />
              </button>
            ) : isRecording ? (
              <button
                type="button"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-mark transition-colors hover:bg-mark-tint"
                onClick={stopRecording}
                aria-label="Stop recording"
              >
                <Square size={16} fill="currentColor" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-paper-sunken hover:text-ink disabled:opacity-50"
                onClick={startRecording}
                disabled={isStreaming}
                aria-label="Dictate"
              >
                <Mic size={18} aria-hidden="true" />
              </button>
            )}

            {isStreaming ? (
              <button
                type="button"
                className="flex h-9 w-9 items-center justify-center rounded-full bg-ink text-ink-inverse transition-colors hover:bg-ink-soft"
                onClick={onStop}
                aria-label="Stop generating"
              >
                <Square size={14} fill="currentColor" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                className={`flex h-9 w-9 items-center justify-center rounded-full transition-all ${
                  canSend
                    ? 'bg-ink text-ink-inverse hover:bg-ink-soft active:scale-95'
                    : 'cursor-not-allowed bg-paper-sunken text-ink-faint'
                }`}
                onClick={() => onSubmit()}
                disabled={!canSend}
                aria-label={sendLabel}
              >
                <ArrowUp size={16} strokeWidth={2.5} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </div>

    </div>
  )
}
