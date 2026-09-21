import { useCallback, useEffect, useRef, useState } from 'react'
import { readAccountStorage, writeAccountStorage } from '../lib/accountStorage'

/** Everything about where the transcript is scrolled to.
 *
 * Extracted from ChatPage unchanged: the same refs, the same effects, the same
 * order. It is a self-contained concern — a scroller, a saved reading position,
 * a gesture lock, and the pinned-anchor follow — and it was the largest block in
 * that file that touched nothing else.
 *
 * Callers get:
 *   scrollRef / endRef / spacerRef   attach to the scroller and its tail
 *   atBottom                          is the teacher reading the newest turn
 *   onScroll                          the scroller's handler
 *   followLatest(id)                  a new exchange: pin this turn to the top
 *   followLatestOnly(id)              keep up with new content, do not re-pin
 *   snapToBottom()                    treat the view as caught up
 *   scrollToBottom()                  the "Latest" jump
 */
export function useChatScroll({ chatId, userId, messageCount, streamText, bottomClearance = 0 }) {
  const [atBottom, setAtBottom] = useState(true)
  const scrollRef = useRef(null)
  const endRef = useRef(null)
  const scrollRestoreKeyRef = useRef(null)
  const scrollSaveTimerRef = useRef(null)
  /* Set when a new turn's user message is pushed (see submit()). The scroll
     effect reads it once, follows the transcript's end, then clears it. This
     makes the response visible immediately and keeps streaming replies in
     view until the teacher deliberately scrolls upward. */
  const followLatestIdRef = useRef(null)
  /* Which turn is pinned to the TOP of the viewport for this exchange, and the
     spacer that makes that possible. Scrolling to the absolute bottom meant a
     streaming reply crawled up from the bottom edge, so the line being read
     never held still. Pinning the question to the top and letting the answer
     fill the space beneath it is what ChatGPT and Claude both do.

     The spacer is sized so that (content below the anchor + spacer) exactly
     fills one viewport. As the reply grows the spacer shrinks by the same
     amount, so total scroll height — and therefore the pinned position — stays
     put while the text arrives, and the spacer reaches zero on its own once the
     reply is tall enough to stand alone. No dead space left behind, and no
     jump from removing it. */
  const followAnchorIdRef = useRef(null)
  const spacerRef = useRef(null)
  /* While the teacher is actively dragging/wheeling the transcript, ignore
     follow-scroll for a beat after the gesture ends. Instant programmatic
     jumps mid-gesture are what made the list feel slippery — native momentum
     would start, then get yanked to the bottom every streamed frame. */
  const userScrollLockRef = useRef(false)
  const userScrollUnlockTimerRef = useRef(null)
  const lockUserScroll = useCallback((ms = 420) => {
    userScrollLockRef.current = true
    window.clearTimeout(userScrollUnlockTimerRef.current)
    userScrollUnlockTimerRef.current = window.setTimeout(() => {
      userScrollLockRef.current = false
    }, ms)
  }, [])
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return undefined
    const onPointer = () => lockUserScroll(520)
    // Direction matters: scrolling TOWARD the bottom is the teacher asking to
    // keep up, and locking on it suppressed the very follow they wanted.
    const onWheel = (e) => { if (e.deltaY < 0) lockUserScroll(380) }
    let touchY = null
    const onTouch = (e) => { touchY = e.touches?.[0]?.clientY ?? null }
    const onTouchMove = (e) => {
      const y = e.touches?.[0]?.clientY
      if (touchY != null && y != null && y > touchY) lockUserScroll(520)
      touchY = y ?? touchY
    }
    el.addEventListener('pointerdown', onPointer, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchstart', onTouch, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    return () => {
      el.removeEventListener('pointerdown', onPointer)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onTouch)
      el.removeEventListener('touchmove', onTouchMove)
      window.clearTimeout(userScrollUnlockTimerRef.current)
    }
  }, [lockUserScroll, chatId])
  /* ── scroll ───────────────────────────────────────────────────────────── */
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const nextAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    setAtBottom(nextAtBottom)
    if (chatId && userId) {
      window.clearTimeout(scrollSaveTimerRef.current)
      scrollSaveTimerRef.current = window.setTimeout(() => {
        writeAccountStorage(
          'chat-scroll',
          userId,
          encodeURIComponent(chatId),
          JSON.stringify({ top: el.scrollTop, atBottom: nextAtBottom })
        )
      }, 120)
    }
  }
  /* Restore a teacher's reading position per chat. This is intentionally a
     scroll offset, not a focus jump: reopening a long plan should return to
     the paragraph they were reading while still allowing the normal
     follow-latest behavior once they send a new turn. */
  useEffect(() => {
    const restoreKey = `${userId || ''}:${chatId || ''}`
    if (!chatId || !userId || scrollRestoreKeyRef.current === restoreKey || !messageCount) return
    const raw = readAccountStorage('chat-scroll', userId, encodeURIComponent(chatId))
    scrollRestoreKeyRef.current = restoreKey
    if (!raw) return
    try {
      const saved = JSON.parse(raw)
      requestAnimationFrame(() => {
        const el = scrollRef.current
        if (!el || typeof saved.top !== 'number') return
        el.scrollTop = Math.max(0, Math.min(saved.top, el.scrollHeight - el.clientHeight))
        setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 120)
      })
    } catch {
      /* A malformed position is disposable UI state; the transcript is not. */
    }
  }, [chatId, messageCount, userId])
  useEffect(() => () => window.clearTimeout(scrollSaveTimerRef.current), [])
  // Follow the latest content while the teacher remains at the bottom. A
  // deliberate upward scroll flips atBottom false, so streaming does not
  // wrestle the viewport back under the teacher's cursor.
  // Coalesce streamed chunks into one update per frame. Only move this
  // scroller: scrollIntoView also moves ancestor panes. A queued frame runs
  // when a background tab becomes visible again, using the latest height.
  const applyFollow = useCallback(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    const spacer = spacerRef.current
    const anchorId = followAnchorIdRef.current
    const anchor = anchorId
      ? scroller.querySelector(`[data-message-id="${CSS.escape(String(anchorId))}"]`)
      : null
    if (!anchor) {
      if (spacer) spacer.style.height = '0px'
      // Direct scrollTop assignment keeps follow-scroll in lockstep with the
      // growing bubble without invoking smooth/instant scrollTo behavior that
      // can cancel native inertia mid-flick on some browsers.
      scroller.scrollTop = scroller.scrollHeight
      return
    }
    const gutter = 12
    const anchorTop = Math.max(0, anchor.offsetTop - gutter)
    const currentSpacer = spacer ? spacer.offsetHeight : 0
    const contentHeight = scroller.scrollHeight - currentSpacer
    const needed = Math.max(0, anchorTop + scroller.clientHeight - contentHeight)
    // Only write when it actually changes. Rewriting the same height still
    // resizes the transcript column, which re-fires the ResizeObserver below,
    // which calls back in here — "ResizeObserver loop completed with
    // undelivered notifications".
    if (spacer && Math.abs(currentSpacer - needed) > 1) spacer.style.height = `${needed}px`
    if (Math.abs(scroller.scrollTop - anchorTop) > 1) scroller.scrollTop = anchorTop
  }, [])

  useEffect(() => {
    if (!followLatestIdRef.current && !atBottom) return undefined
    if (userScrollLockRef.current && !followLatestIdRef.current) return undefined
    const frame = requestAnimationFrame(() => {
      followLatestIdRef.current = null
      applyFollow()
    })
    return () => cancelAnimationFrame(frame)
  }, [messageCount, atBottom, streamText, bottomClearance, applyFollow])

  /* A pin belongs to one exchange. Leaving it set across a chat switch would
     keep a spacer sized for a conversation that is no longer on screen. */
  useEffect(() => {
    followAnchorIdRef.current = null
    if (spacerRef.current) spacerRef.current.style.height = '0px'
  }, [chatId])

  /* Progressive markdown changes height on frames where streamText has
     not changed — KaTeX laying out, a table finalizing, a font swapping in — so
     the effect above cannot see them. Safari has no overflow-anchor, so this is
     the portable answer. */
  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller || typeof ResizeObserver === 'undefined') return undefined
    let frame = 0
    const observer = new ResizeObserver(() => {
      if (!followAnchorIdRef.current) return
      if (userScrollLockRef.current || !atBottom) return
      // Deferred to the next frame so the callback never mutates layout inside
      // the observation it was delivered for.
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        applyFollow()
      })
    })
    for (const child of scroller.children) observer.observe(child)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [atBottom, applyFollow, messageCount])

  const followLatest = useCallback((id) => {
    followLatestIdRef.current = id
    followAnchorIdRef.current = id
  }, [])
  const followLatestOnly = useCallback((id) => {
    followLatestIdRef.current = id
  }, [])
  const snapToBottom = useCallback(() => setAtBottom(true), [])
  const scrollToBottom = useCallback(() => {
    const scroller = scrollRef.current
    if (scroller) scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' })
  }, [])

  return {
    scrollRef,
    endRef,
    spacerRef,
    atBottom,
    onScroll,
    followLatest,
    followLatestOnly,
    snapToBottom,
    scrollToBottom,
  }
}

export default useChatScroll
