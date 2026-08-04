import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, FileText, Loader2, Mic, Paperclip, Square, X } from 'lucide-react'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'

const MAX_H = 220

export function Composer({ value, onChange, onSubmit, onStop, isStreaming, attachments, setAttachments }) {
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
    <div className="composer-wrap">
      <div className="composer-inner" ref={wrapperRef}>
        {attachments.length > 0 ? (
          <div className="attachments">
            {attachments.map((f, i) => (
              <span className="chip" key={`${f.filename}-${i}`}>
                <FileText size={12} aria-hidden="true" />
                <span>{f.filename}</span>
                <button
                  type="button"
                  className="btn-icon"
                  aria-label={`Remove ${f.filename}`}
                  onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div className={`composer${isRecording ? ' is-recording' : ''}`}>
          <label className="visually-hidden" htmlFor="composer-input">
            Describe the week you want to plan
          </label>
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
                  : 'Describe the week — e.g. “Week 3, rhetorical analysis of Letter from Birmingham Jail”'
            }
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={isRecording || isTranscribing}
          />

          <div className="composer-bar">
            {/* The input is visually hidden but still focusable — display:none
                would take it out of the tab order entirely. */}
            <label className="btn-icon btn-file" htmlFor="composer-file">
              {isAttaching ? (
                <Loader2 size={16} className="spin" aria-hidden="true" />
              ) : (
                <Paperclip size={16} aria-hidden="true" />
              )}
              <span className="visually-hidden">Attach a PDF or text file</span>
            </label>
            <input
              id="composer-file"
              className="visually-hidden"
              aria-label="Attach a PDF or text file"
              type="file"
              accept=".pdf,.txt,.md,.csv"
              onChange={handleFile}
              disabled={isAttaching}
            />

            {isTranscribing ? (
              <button type="button" className="btn-icon" disabled aria-label="Transcribing">
                <Loader2 size={16} className="spin" aria-hidden="true" />
              </button>
            ) : isRecording ? (
              <button
                type="button"
                className="btn-icon"
                onClick={stopRecording}
                aria-label="Stop recording"
                style={{ color: 'var(--danger)' }}
              >
                <Square size={15} fill="currentColor" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                className="btn-icon"
                onClick={startRecording}
                disabled={isStreaming}
                aria-label="Dictate"
              >
                <Mic size={16} aria-hidden="true" />
              </button>
            )}

            <span className="composer-bar-spacer" />

            {isStreaming ? (
              <button
                type="button"
                className="btn-send is-stop"
                onClick={onStop}
                aria-label="Stop generating"
              >
                <Square size={13} fill="currentColor" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                className="btn-send"
                onClick={onSubmit}
                disabled={!canSend}
                aria-label="Generate the lesson plan"
              >
                <ArrowUp size={16} strokeWidth={2.5} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>

        <p className="composer-note">
          Every standard is cited from your source documents — click a code to see it.{' '}
          <kbd>Enter</kbd> to send, <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line.
        </p>
      </div>
    </div>
  )
}
