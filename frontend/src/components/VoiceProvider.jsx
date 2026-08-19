import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { VoiceContext } from '../lib/voiceContext'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'

const KEY = 'aplang.voice'

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
  const [caption, setCaption] = useState('')
  
  const pcRef = useRef(null)
  const dcRef = useRef(null)
  const audioElRef = useRef(null)
  const localStreamRef = useRef(null)
  const activeSessionRef = useRef(false)

  useEffect(() => {
    const el = document.createElement('audio')
    el.autoplay = true
    audioElRef.current = el
    return () => {
      el.pause()
      el.srcObject = null
    }
  }, [])

  const stop = useCallback(() => {
    activeSessionRef.current = false
    setSpeaking(false)
    
    if (dcRef.current) {
      dcRef.current.close()
      dcRef.current = null
    }
    if (pcRef.current) {
      pcRef.current.close()
      pcRef.current = null
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop())
      localStreamRef.current = null
    }
    if (audioElRef.current) {
      audioElRef.current.srcObject = null
    }
  }, [])

  const unlock = useCallback(async (chatId = null, weekNumber = null, mode = 'brainstorm') => {
    if (activeSessionRef.current) return
    
    try {
      activeSessionRef.current = true
      
      const { client_secret } = await api.createVoiceSession({
        chat_id: chatId,
        week_number: weekNumber,
        mode
      })

      const pc = new RTCPeerConnection()
      pcRef.current = pc

      pc.ontrack = e => {
        if (audioElRef.current) {
          audioElRef.current.srcObject = e.streams[0]
        }
      }

      const ms = await navigator.mediaDevices.getUserMedia({ audio: true })
      localStreamRef.current = ms
      pc.addTrack(ms.getTracks()[0], ms)

      const dc = pc.createDataChannel('oai-events')
      dcRef.current = dc
      
      dc.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data)
          
          if (event.type === 'response.audio_transcript.delta') {
            setSpeaking(true)
            setCaption(prev => prev + event.delta)
          } else if (event.type === 'response.audio_transcript.done') {
            setSpeaking(false)
            setTimeout(() => setCaption(''), 2000)
          } else if (event.type === 'response.function_call.arguments.done') {
            const args = JSON.parse(event.arguments)
            window.dispatchEvent(new CustomEvent('voice:tool_call', { 
              detail: { name: event.name, args }
            }))
          }
        } catch (err) {
          console.error("Failed to parse data channel message", err)
        }
      }

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)

      const baseUrl = 'https://api.openai.com/v1/realtime'
      const model = 'gpt-4o-realtime-preview'
      
      const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
        method: 'POST',
        body: offer.sdp,
        headers: {
          'Authorization': `Bearer ${client_secret.value}`,
          'Content-Type': 'application/sdp'
        }
      })

      if (!sdpResponse.ok) {
        throw new Error("Failed to connect to OpenAI Realtime")
      }

      const answer = {
        type: 'answer',
        sdp: await sdpResponse.text()
      }
      await pc.setRemoteDescription(answer)
      
    } catch (err) {
      console.error(err)
      stop()
      toast.error('Couldn’t start Voice Mode', err?.message || String(err))
    }
  }, [toast, stop])

  const toggle = useCallback((chatId, weekNumber, mode) => {
    setEnabled((prev) => {
      const next = !prev
      try {
        localStorage.setItem(KEY, next ? '1' : '0')
      } catch {}
      if (next) unlock(chatId, weekNumber, mode)
      else stop()
      return next
    })
  }, [stop, unlock])

  const sendContextEvent = useCallback((text) => {
    if (dcRef.current && dcRef.current.readyState === 'open') {
      const event = {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'system',
          content: [{ type: 'input_text', text }]
        }
      }
      dcRef.current.send(JSON.stringify(event))
      
      const responseEvent = {
        type: 'response.create',
        response: {
           modalities: ['text', 'audio']
        }
      }
      dcRef.current.send(JSON.stringify(responseEvent))
    }
  }, [])

  const value = useMemo(() => ({
    enabled,
    toggle,
    speaking,
    caption,
    stop,
    unlock,
    sendContextEvent,
  }), [enabled, toggle, speaking, caption, stop, unlock, sendContextEvent])

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>
}
