import { useEffect, useRef } from 'react'
import { useVoice } from '../lib/voiceContext'

/** A short history of measured sound, sampled without rerendering the chat. */
export function VoiceSignal({ speaking = false }) {
  const voice = useVoice()
  const root = useRef(null)
  const { getAudioLevel, status, muted, audioBlocked } = voice
  useEffect(() => {
    const bars = [...root.current.children]
    const history = Array(bars.length).fill(0)
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let frame = null
    let lastSample = 0
    let level = 0
    const clear = () => {
      if (frame != null) window.cancelAnimationFrame(frame)
      frame = null
      history.fill(0)
      level = 0
      bars.forEach((bar) => { bar.style.transform = 'scaleY(.1)' })
    }
    const tick = (now) => {
      if (now - lastSample >= 40) {
        lastSample = now
        const sample = getAudioLevel?.(speaking ? 'output' : 'input') || 0
        level += (sample - level) * (sample > level ? .7 : .35)
        history.shift()
        history.push(level)
        bars.forEach((bar, index) => { bar.style.transform = `scaleY(${Math.max(.1, history[index])})` })
      }
      frame = window.requestAnimationFrame(tick)
    }
    const sync = () => {
      clear()
      if (status === 'live' && !motion.matches && !document.hidden && (speaking ? !audioBlocked : !muted)) frame = window.requestAnimationFrame(tick)
    }
    sync()
    motion.addEventListener('change', sync)
    document.addEventListener('visibilitychange', sync)
    return () => {
      clear()
      motion.removeEventListener('change', sync)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [getAudioLevel, status, muted, audioBlocked, speaking])
  return <span ref={root} className="voice-signal" aria-hidden="true">{Array.from({ length: 11 }, (_, index) => <i key={index} />)}</span>
}
