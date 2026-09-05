import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useExitTransition } from '../hooks/useExitTransition'
import { Link, NavLink, useLocation, useNavigate, useParams } from 'react-router-dom'
import { ChevronDown, Database, FileText, MoreHorizontal, PanelLeft, Pencil, Pin, Plus, RefreshCw, Search, Trash2, Users, X } from 'lucide-react'

import { useChats, useClasses, useDeleteChat, useRenameChat, useTogglePin } from '../hooks/useAppData'
import { usePullToRefresh } from '../hooks/usePullToRefresh'
import { useAuth } from '../lib/authContext'
import { useConfirm } from '../lib/confirmContext'
import { useToast } from '../lib/toastContext'
import { NARROW, PHONE, useMediaQuery } from '../hooks/useMediaQuery'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { AccountMenu } from './AccountMenu'
import { SkeletonText } from './Skeleton'
import { onOpenOnboardingWizard } from '../lib/onboardingWizardBus'
import { readAccountStorage, writeAccountStorage } from '../lib/accountStorage'
import { WorkspaceRailContext } from '../lib/workspaceRailContext'

/* The frame. A chat client's shape, which is what this is now.
 *
 * The rail is a plain flex column, not a resizable <Panel> — that is what forced
 * two nested PanelGroups with two fighting layout ids, and nobody resizes a
 * 264px nav. The one PanelGroup left splits the chat from the plan.
 */

// Width of the revealed pin/rename/delete strip on a spacious (mobile) swipe —
// three .btn-icon-lg targets plus the row's own internal gaps/padding.
const SWIPE_ACTIONS_WIDTH = 132
const OnboardingWizard = lazy(() => import('./OnboardingWizard').then((module) => ({ default: module.OnboardingWizard })))

function ChatRow({ chat, classId, onDelete, onPin, onNavigate, spacious, swipeOpen, onSwipeOpenChange }) {
  const rename = useRenameChat()
  const [editing, setEditing] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
  const actionsRef = useRef(null)
  const [draft, setDraft] = useState(chat.title)
  // Tracks which side of the reveal threshold the CURRENT drag gesture is
  // on, so the haptic tick below fires once per crossing instead of once
  // per pixel of drag. Seeded from swipeOpen (not always false) so a drag
  // that starts already-open and never crosses back doesn't fire a tick on
  // release for a threshold it never actually re-crossed.
  const crossedRef = useRef(false)

  const commit = () => {
    const next = draft.trim()
    setEditing(false)
    if (next && next !== chat.title) rename.mutate({ id: chat.id, title: next })
    else setDraft(chat.title)
  }

  useEffect(() => {
    if (!actionsOpen) return undefined
    const closeOnOutsidePress = (event) => {
      if (!actionsRef.current?.contains(event.target)) setActionsOpen(false)
    }
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setActionsOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePress)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [actionsOpen])

  if (editing) {
    return (
      <motion.li
        className="px-2"
        initial={{ opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: 'auto' }}
        exit={{ opacity: 0, height: 0, x: -20 }}
      >
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              setDraft(chat.title)
              setEditing(false)
            }
          }}
          aria-label={`Rename ${chat.title}`}
          className="w-full rounded-md bg-paper-inset px-2 py-1.5 text-sm text-ink outline-none"
        />
      </motion.li>
    )
  }

  const rowInner = (
    <NavLink
      to={`/c/${classId}/chat/${chat.id}`}
      // Every other row in this rail (New plan, History, Plans) already
      // closes the phone drawer on navigate — this one was the one
      // link left out, so opening a chat from the drawer left the drawer
      // sitting open over it instead of getting out of the way.
      onClick={(e) => {
        // A tap while the swipe strip is open closes it instead of
        // navigating — the same "tap the row to dismiss" behavior every
        // native swipe-action list uses, so a stray tap can't fire off
        // into a chat mid-gesture.
        if (spacious && swipeOpen) {
          e.preventDefault()
          onSwipeOpenChange(false)
          return
        }
        onNavigate?.(e)
      }}
      className={({ isActive }) =>
        /* neo-inset, not a background tint — "pressed in" is what already
           means "selected" in this world (see every neo-raised button's
           own :active state), so the active row reads as a permanent
           version of that same press instead of a third, unrelated
           signal.

           spacious (MobileChatHome only — the one place a chat row is a
           thumb target on a screen with nothing else fighting it for
           room): taller rows and larger type instead of just a bigger
           invisible .tap-target hit area, since there's space here to
           actually grow the control, not just its hitbox. */
        `flex items-center rounded-md transition-all duration-300 ${spacious ? 'bg-paper' : ''} ${
          spacious ? 'min-h-[44px] py-2.5 px-3 pr-4 text-base' : 'min-h-[28px] py-1.5 px-2 pr-4 text-sm'
        } ${
          isActive ? 'neo-inset bg-paper-sunken text-accent-text drop-shadow-[0_0_8px_rgba(var(--accent-rgb),0.5)] font-medium' : 'text-ink-soft hover:bg-paper-inset/60 hover:text-ink'
        }`
      }
    >
      <span className="truncate">{chat.title}</span>
    </NavLink>
  )

  if (spacious) {
    // Swipe-to-reveal, the native iOS list pattern, instead of the
    // desktop/tablet hover-reveal cluster: on a screen with no hover at
    // all, a row permanently showing three icons read as cluttered (see
    // .chat-row-actions's own history — that CSS fix made the icons
    // reachable on touch for the first time, but "always visible" and
    // "phone-native" are different bars). Pin/rename/delete sit on a
    // layer BEHIND the row; dragging the row left uncovers them, same as
    // Mail.app or Messages.
    return (
      <motion.li
        className="relative touch-pan-y overflow-hidden px-2"
        initial={{ opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: 'auto' }}
        exit={{ opacity: 0, height: 0, x: -20, transition: { duration: 0.2 } }}
      >
        <div
          className="absolute inset-y-0 right-2 flex items-center gap-1.5 pr-1"
          style={{ width: SWIPE_ACTIONS_WIDTH }}
          aria-hidden={!swipeOpen}
        >
          <button
            type="button"
            tabIndex={swipeOpen ? 0 : -1}
            className={`btn-icon-lg tap-target ${chat.is_pinned ? 'text-amber-500' : ''}`}
            aria-label={chat.is_pinned ? `Unpin ${chat.title}` : `Pin ${chat.title}`}
            onClick={() => {
              onPin(chat)
              onSwipeOpenChange(false)
            }}
          >
            <Pin size={16} aria-hidden="true" className={chat.is_pinned ? 'fill-amber-500' : ''} />
          </button>
          <button
            type="button"
            tabIndex={swipeOpen ? 0 : -1}
            className="btn-icon-lg tap-target"
            aria-label={`Rename ${chat.title}`}
            onClick={() => {
              setEditing(true)
              onSwipeOpenChange(false)
            }}
          >
            <Pencil size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            tabIndex={swipeOpen ? 0 : -1}
            className="btn-icon-lg tap-target text-mark"
            aria-label={`Delete ${chat.title}`}
            onClick={() => {
              onDelete(chat)
              onSwipeOpenChange(false)
            }}
          >
            <Trash2 size={16} aria-hidden="true" />
          </button>
        </div>
        <motion.div
          drag="x"
          dragConstraints={{ left: -SWIPE_ACTIONS_WIDTH, right: 0 }}
          dragElastic={0.04}
          dragMomentum={false}
          animate={{ x: swipeOpen ? -SWIPE_ACTIONS_WIDTH : 0 }}
          transition={{ type: 'spring', stiffness: 500, damping: 40 }}
          onDragStart={() => {
            crossedRef.current = swipeOpen
          }}
          onDrag={(_e, info) => {
            // A short tick right as the drag crosses into "will reveal"
            // territory — the same real-time feedback iOS's own swipe
            // actions give, rather than only confirming the choice after
            // the finger's already lifted (onDragEnd, below). Guarded on
            // vibrate existing at all: iOS Safari has never implemented the
            // Vibration API (desktop Safari and iOS both lack it), so this
            // silently no-ops there instead of throwing — Android Chrome and
            // most other touch browsers do support it.
            const past = info.offset.x < -SWIPE_ACTIONS_WIDTH / 2
            if (past !== crossedRef.current) {
              crossedRef.current = past
              if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(10)
            }
          }}
          onDragEnd={(_e, info) => {
            // Past the halfway point, or flicked with real velocity —
            // either commits to fully open/closed rather than resting
            // wherever the finger happened to lift.
            const pastHalfway = info.offset.x < -SWIPE_ACTIONS_WIDTH / 2
            const flickedOpen = info.velocity.x < -300
            const flickedClosed = info.velocity.x > 300
            onSwipeOpenChange(flickedClosed ? false : flickedOpen || pastHalfway)
          }}
          className="relative z-10"
        >
          {rowInner}
        </motion.div>
      </motion.li>
    )
  }

  return (
    <motion.li
      className="group relative px-2"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0, x: -20, transition: { duration: 0.2 } }}
    >
      {rowInner}
      <span ref={actionsRef} className={`chat-row-actions absolute right-2 top-1/2 flex -translate-y-1/2 items-center${actionsOpen ? ' is-open' : ''}`}>
        <button
          type="button"
          className="btn-icon"
          aria-label={`More actions for ${chat.title}`}
          aria-haspopup="menu"
          aria-expanded={actionsOpen}
          onClick={() => setActionsOpen((open) => !open)}
        >
          <MoreHorizontal size={16} aria-hidden="true" />
        </button>
        {actionsOpen ? (
          <div className="chat-row-menu" role="menu" aria-label={`Actions for ${chat.title}`}>
            <button
              type="button"
              role="menuitem"
              className="chat-row-menu-item"
              onClick={() => {
                onPin(chat)
                setActionsOpen(false)
              }}
            >
              <Pin size={15} aria-hidden="true" className={chat.is_pinned ? 'fill-amber-500 text-amber-500' : ''} />
              {chat.is_pinned ? 'Unpin' : 'Pin'}
            </button>
            <button
              type="button"
              role="menuitem"
              className="chat-row-menu-item"
              onClick={() => {
                setEditing(true)
                setActionsOpen(false)
              }}
            >
              <Pencil size={15} aria-hidden="true" />
              Rename
            </button>
            <button
              type="button"
              role="menuitem"
              className="chat-row-menu-item text-mark"
              onClick={() => {
                onDelete(chat)
                setActionsOpen(false)
              }}
            >
              <Trash2 size={15} aria-hidden="true" />
              Delete
            </button>
          </div>
        ) : null}
      </span>
    </motion.li>
  )
}

/* Exported so ChatPage.jsx can reuse it as the phone-only "home" screen —
   chats list + Workspace Tools + account controls, the same content as the desktop
   sidebar, landing where a teacher currently gets dropped straight into an
   empty chat instead. See MobileChatHome.jsx. */
export function Rail({ onNavigate, onClose, collapsed, onToggleCollapse, headerExtra, spacious }) {
  const { entitlement } = useAuth()
  const { classId } = useParams()
  const location = useLocation()
  const { data: chats, isLoading, refetch } = useChats()
  const deleteChat = useDeleteChat()
  const confirm = useConfirm()
  const toast = useToast()
  const navigate = useNavigate()
  const classPath = `/c/${classId}`
  const isChatRoute = /^\/c\/[^/]+(?:\/chat\/[^/]+)?$/.test(location.pathname)
  // Only one row's swipe strip open at a time — opening a second one closes
  // whichever was already open, same as every native swipe-action list.
  const [swipeOpenId, setSwipeOpenId] = useState(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const searchInputRef = useRef(null)
  // Always called (Rules of Hooks) but only wired up when spacious — see the
  // scroller div below. Harmless unused otherwise: the hook no-ops until its
  // containerRef is actually attached to an element.
  const pullToRefresh = usePullToRefresh(refetch)
  // Optimistic (useTogglePin) — the icon and the Pinned/Recent placement both
  // update on click instead of after a PATCH plus a full list refetch.
  const togglePinMutation = useTogglePin()
  const togglePin = (chat) => {
    togglePinMutation.mutate(
      { id: chat.id, pinned: !chat.is_pinned },
      { onError: (err) => toast.apiError('Could not pin chat', err) }
    )
  }

  // Local filter for every layout — HistoryPage remains the full management
  // view, but searching in place is faster than leaving the conversation just
  // to find an older plan. The sidebar and phone home use the same filter.
  const [chatSearch, setChatSearch] = useState('')
  const [recentOpen, setRecentOpen] = useState(true)
  const chatSearchQuery = chatSearch.trim().toLowerCase()
  const searchFilter = (c) => !chatSearchQuery || c.title?.toLowerCase().includes(chatSearchQuery)

  useEffect(() => {
    if (!searchOpen) return undefined
    const frame = requestAnimationFrame(() => searchInputRef.current?.focus())
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') {
        setChatSearch('')
        setSearchOpen(false)
      }
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [searchOpen])

  const closeSearch = () => {
    setChatSearch('')
    setSearchOpen(false)
  }

  const pinnedChats = (chats?.filter((c) => c.is_pinned) || []).filter(searchFilter)
  const recentChats = (chats?.filter((c) => !c.is_pinned) || []).filter(searchFilter)
  const visibleRecentChats = chatSearchQuery ? recentChats : recentChats.slice(0, 10)
  const showRecentChats = recentOpen || Boolean(chatSearchQuery)

  const isFreeTier = entitlement && (!entitlement.subscribed || entitlement.status !== 'active')
  const freePlansUsed = entitlement ? entitlement.tokens_used : 0
  const freePlansTotal = entitlement ? entitlement.token_cap : 10
  const freePlansProgress = Math.min(100, Math.max(0, (freePlansUsed / (freePlansTotal || 1)) * 100))

  const remove = async (chat) => {
    const ok = await confirm({
      title: `Delete “${chat.title}”?`,
      body: 'The lesson plan it produced is kept.',
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!ok) return
    try {
      await deleteChat.mutateAsync(chat.id)
      /* Only leave if the chat that just went away is the one on screen.
         This used to navigate unconditionally, so tidying up an old chat in
         the sidebar closed the conversation you were in the middle of — the
         plan you were reading disappeared and you were dropped on the greeting
         screen, for deleting something else entirely. */
      if (location.pathname.startsWith(`${classPath}/chat/${chat.id}`)) navigate(classPath)
    } catch (err) {
      toast.apiError('Could not delete that chat', err)
    }
  }

  return (
    <>
      <div className={`rail-brand-row flex h-14 shrink-0 items-center gap-2 px-3 mt-2${collapsed ? ' is-collapsed' : ''}`}>
        <svg viewBox="0 0 64 64" className="w-6 h-6 shrink-0 text-[#7c3aed] drop-shadow-sm" aria-hidden="true">
          <circle cx="32" cy="32" r="29" fill="transparent" className="land-seal-disc" />
          <circle cx="32" cy="32" r="30.5" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="1.6 3.4" className="land-seal-ticks" />
          <circle cx="32" cy="32" r="27" fill="none" stroke="currentColor" strokeWidth="2.5" className="land-seal-ring" />
          <path d="M20 33l8 8 16-18" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" className="land-seal-check" />
        </svg>
        {/* text-[13.5px], not the old 15px: at the sidebar's 220px width,
            15px bold "FlexEd Academy" only fit alongside the header icons
            when this row had nothing after the wordmark. Adding the collapse
            button (below) meant the two together no longer fit, and the
            wordmark itself — not the button — is what should give, since
            "FlexEd Aca…" reads worse truncated than it does simply smaller. */}
        {collapsed ? null : (
          <span className="rail-reveal min-w-0 flex-1 truncate text-[13.5px] font-bold tracking-tight text-ink">
            FlexEd Academy
          </span>
        )}
        {/* Chat pages place this control at the seam beside the workspace
            selector. Other pages keep it here because they do not render the
            chat topbar that owns that shared control. */}
        {onToggleCollapse && !isChatRoute ? (
          <button
            type="button"
            className="workspace-sidebar-toggle shrink-0"
            aria-label={collapsed ? 'Show the sidebar' : 'Collapse the sidebar'}
            title={collapsed ? 'Show the sidebar' : 'Collapse the sidebar'}
            onClick={onToggleCollapse}
          >
            <PanelLeft size={14} aria-hidden="true" />
          </button>
        ) : null}
        {onClose ? (
          <button type="button" className="btn-icon" aria-label="Close menu" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {/* The class switcher used to live here, directly under the logo — it now
          sits inline beside WeekPicker in the chat's own top bar (ChatPage.jsx),
          since that's the one control it always appears next to. Moving it out
          lets "New plan" — the one thing a teacher opens this app to do — sit
          right under the logo instead of one row down.

          headerExtra puts it back, ONLY for MobileChatHome: that screen IS
          the one place left with no chat top bar of its own to carry a
          class switcher, since it's what a teacher sees BEFORE opening any
          chat. Undefined everywhere else (the desktop dock, the tablet
          drawer), so neither gets a second switcher next to the one already
          inline in ChatPage's header. */}
      {headerExtra ? <div className="px-2 pb-2">{headerExtra}</div> : null}


      <div className="px-2 pb-1 pt-1">


        {/* The one thing a teacher opens this app to do. Was .rail-cta's own
            --rail-pop teal (colorize.md) — a token .neo-world doesn't
            redeclare, so it rendered as a mismatched accent against the
            rose/cream palette here. neo-raised + the redeclared --accent
            tokens makes it the one floating, emphasized control in the
            rail instead — still the rarest warm note, just this world's
            warm note. Solid fill now, not a pastel tint — the one button in
            the rail that should read as unmistakably "press me." */}
        <div className={collapsed ? 'flex justify-center' : ''}>
          {collapsed ? (
            <Link
              to={classPath}
              onClick={onNavigate}
              title="New plan"
              className="fa-press neo-raised btn-blob flex h-10 w-10 items-center justify-center rounded-md text-sm font-medium text-ink transition-all duration-300"
            >
              <Plus size={spacious ? 18 : 15} aria-hidden="true" className="shrink-0" />
            </Link>
          ) : (
            <div className="rail-new-plan-row">
              <AnimatePresence initial={false} mode="wait">
                {searchOpen ? (
                  <motion.div
                    key="chat-search"
                    className={`rail-quick-search${spacious ? ' is-spacious' : ''}`}
                    initial={{ opacity: 0, x: 8 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -8 }}
                    transition={{ duration: 0.16, ease: 'easeOut' }}
                  >
                    <Search size={14} aria-hidden="true" className="shrink-0 text-ink-muted" />
                    <input
                      ref={searchInputRef}
                      type="search"
                      value={chatSearch}
                      onChange={(e) => setChatSearch(e.target.value)}
                      placeholder="Search chats"
                      aria-label="Search your chats"
                      className="rail-quick-search-input"
                    />
                    <button type="button" className="btn-icon shrink-0" onClick={closeSearch} aria-label="Close chat search" title="Close search">
                      <X size={14} aria-hidden="true" />
                    </button>
                  </motion.div>
                ) : (
                  <motion.div key="new-plan" className="rail-new-plan-content" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 8 }} transition={{ duration: 0.16, ease: 'easeOut' }}>
                    <Link
                      to={classPath}
                      onClick={onNavigate}
                      className={`fa-press neo-raised btn-blob flex min-w-0 flex-1 items-center rounded-l-md rounded-r-none font-medium text-ink transition-all duration-300 overflow-hidden whitespace-nowrap ${
                        spacious ? 'gap-2 px-3.5 py-3 min-h-[52px] text-base' : 'gap-2 px-3 py-1.5 min-h-[32px] text-sm'
                      }`}
                    >
                      <Plus size={spacious ? 18 : 15} aria-hidden="true" className="shrink-0" />
                      <span className="flex-1 overflow-hidden text-ellipsis">New plan</span>
                    </Link>
                    <button
                      type="button"
                      className={`rail-search-trigger fa-press neo-raised flex shrink-0 items-center justify-center rounded-r-md rounded-l-none text-ink-soft transition-colors hover:text-ink ${spacious ? 'min-h-[52px] w-12' : 'min-h-[32px] w-9'}`}
                      onClick={() => setSearchOpen(true)}
                      aria-label="Search chats"
                      title="Search chats"
                    >
                      <Search size={spacious ? 17 : 14} aria-hidden="true" />
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </div>
      </div>

      {collapsed ? null : (
        <nav className="rail-reveal min-h-0 flex-1 flex flex-col pt-2" aria-label="Your plans">
          <div
            ref={spacious ? pullToRefresh.containerRef : undefined}
            // .scroll-y, not plain overflow-y-auto: without its
            // overscroll-behavior-y: contain, scrolling past the end of
            // this list rubber-bands the whole app on iOS — and on the
            // spacious (MobileChatHome) path, that chained rubber-band was
            // fighting pull-to-refresh's own touch handling for the same
            // gesture at the top of the list.
            className="min-h-0 flex-1 scroll-y pb-4"
          >
            {/* Pull-to-refresh (MobileChatHome only — see usePullToRefresh):
                the one native list gesture a phone landing screen was
                missing. The indicator grows with the pull itself rather
                than overlaying the list, so it reads as pushing the chats
                down instead of floating over them.

                No pullDistance-driven inline style here — usePullToRefresh
                writes height/opacity/transform straight to indicatorRef/
                iconRef during the drag itself (see its own comment on why:
                a React state update on every touchmove event was the
                actual cause of this feeling janky). `refreshing` alone is
                still plain React state — it changes once per gesture, not
                once per pixel, so a re-render here costs nothing. */}
            {spacious ? (
              <div
                ref={pullToRefresh.indicatorRef}
                className="pull-refresh-indicator flex items-center justify-center text-ink-muted"
                aria-hidden="true"
              >
                <RefreshCw
                  ref={pullToRefresh.iconRef}
                  size={16}
                  className={pullToRefresh.refreshing ? 'animate-spin' : ''}
                />
              </div>
            ) : null}
            {spacious && pullToRefresh.refreshing ? (
              <p className="visually-hidden" role="status">Refreshing your chats.</p>
            ) : null}

            {pinnedChats.length > 0 && (
              <div className="mb-4">
                <p className="eyebrow px-4 pb-1">Pinned</p>
                <ul className="flex flex-col gap-0">
                  <AnimatePresence initial={false}>
                    {pinnedChats.map((c) => (
                      <ChatRow key={c.id} chat={c} classId={classId} onDelete={remove} onPin={togglePin} onNavigate={onNavigate} spacious={spacious} swipeOpen={swipeOpenId === c.id} onSwipeOpenChange={(open) => setSwipeOpenId(open ? c.id : null)} />
                    ))}
                  </AnimatePresence>
                </ul>
              </div>
            )}

            <div className="mt-2 flex items-center justify-between gap-2 px-4 pb-1">
              <button
                type="button"
                onClick={() => setRecentOpen((open) => !open)}
                aria-expanded={showRecentChats}
                aria-controls="recent-chat-list"
                className="flex min-w-0 items-center gap-1 text-left"
              >
                <span className="eyebrow">Recent</span>
                {recentChats.length ? <span className="text-[10px] text-ink-faint">{recentChats.length}</span> : null}
                <ChevronDown size={13} aria-hidden="true" className={`shrink-0 text-ink-faint transition-transform ${showRecentChats ? 'rotate-0' : '-rotate-90'}`} />
              </button>
              <Link
                to={`${classPath}/history`}
                onClick={onNavigate}
                className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-ink-muted hover:text-ink"
                aria-label="View all chats"
              >
                View all
              </Link>
            </div>

            {showRecentChats ? (
              <div id="recent-chat-list">
                {isLoading ? (
                  <div className="px-4 py-2">
                    <SkeletonText lines={4} />
                  </div>
                ) : recentChats.length ? (
                  <>
                    <ul className="flex flex-col gap-0">
                      <AnimatePresence initial={false}>
                        {visibleRecentChats.map((c) => (
                          <ChatRow key={c.id} chat={c} classId={classId} onDelete={remove} onPin={togglePin} onNavigate={onNavigate} spacious={spacious} swipeOpen={swipeOpenId === c.id} onSwipeOpenChange={(open) => setSwipeOpenId(open ? c.id : null)} />
                        ))}
                      </AnimatePresence>
                    </ul>
                  </>
                ) : !pinnedChats.length && (
                  <p className="px-4 py-2 text-xs text-ink-muted">
                    {chatSearchQuery ? `No chats match "${chatSearch.trim()}".` : 'Nothing yet. Describe a week to get started.'}
                  </p>
                )}
              </div>
            ) : null}
          </div>
        </nav>
      )}

      <div className={`pt-2 pb-1 flex flex-col ${collapsed ? 'flex-1' : 'shrink-0'}`}>
        {isFreeTier && !collapsed && (
          <div className="px-4 pb-3">
            <div className="flex justify-between text-[10px] font-medium text-ink-muted mb-1.5 uppercase tracking-wider">
              <span>{freePlansUsed} Plans Used</span>
              <span>Trial</span>
            </div>
            <div className="h-1.5 w-full bg-paper-sunken neo-inset rounded-full overflow-hidden">
              <div 
                className="h-full bg-accent transition-all duration-500 ease-out" 
                style={{ width: `${freePlansProgress}%` }} 
              />
            </div>
          </div>
        )}
        
        {/* Every plan this class has ever built, placed at the bottom near account settings. */}
        <div className="mt-2 mb-2">
          {collapsed ? null : <p className="rail-reveal eyebrow px-4 pb-2">Workspace Tools</p>}
          <ul className={`flex flex-col gap-0 ${collapsed ? 'px-1 items-center' : 'px-2'}`}>
            <li>
              <NavLink
                to={`${classPath}/standards`}
                onClick={onNavigate}
                title="Standards"
                className={({ isActive }) =>
                  `flex items-center gap-2.5 rounded-md transition-all duration-300 ${
                    collapsed ? 'justify-center w-10 h-10 text-sm' : spacious ? 'px-3 py-3 min-h-[48px] text-base' : 'px-2 py-1.5 text-sm'
                  } ${
                    isActive ? 'neo-inset bg-paper-sunken text-accent-text font-medium drop-shadow-[0_0_8px_rgba(var(--accent-rgb),0.3)]' : 'text-ink-soft hover:bg-paper-inset hover:text-ink'
                  }`
                }
              >
                <Database size={spacious ? 19 : 17} aria-hidden="true" />
                {collapsed ? null : <span className="rail-reveal">Standards</span>}
              </NavLink>
            </li>
            <li>
              <NavLink
                to={`${classPath}/class`}
                end
                onClick={onNavigate}
                title="Classroom Profile"
                className={({ isActive }) =>
                  `flex items-center gap-2.5 rounded-md transition-all duration-300 ${
                    collapsed ? 'justify-center w-10 h-10 text-sm' : spacious ? 'px-3 py-3 min-h-[48px] text-base' : 'px-2 py-1.5 text-sm'
                  } ${
                    isActive ? 'neo-inset bg-paper-sunken text-accent-text font-medium drop-shadow-[0_0_8px_rgba(var(--accent-rgb),0.3)]' : 'text-ink-soft hover:bg-paper-inset hover:text-ink'
                  }`
                }
              >
                <Users size={spacious ? 19 : 17} aria-hidden="true" />
                {collapsed ? null : <span className="rail-reveal">Classroom Profile</span>}
              </NavLink>
            </li>
            <li>
              <NavLink
                to={`${classPath}/plans`}
                onClick={onNavigate}
                title="Library"
                className={({ isActive }) =>
                  `flex items-center gap-2.5 rounded-md transition-all duration-300 ${
                    collapsed ? 'justify-center w-10 h-10 text-sm' : spacious ? 'px-3 py-3 min-h-[48px] text-base' : 'px-2 py-1.5 text-sm'
                  } ${
                    isActive ? 'neo-inset bg-paper-sunken text-accent-text font-medium drop-shadow-[0_0_8px_rgba(var(--accent-rgb),0.3)]' : 'text-ink-soft hover:bg-paper-inset hover:text-ink'
                  }`
                }
              >
                <FileText size={spacious ? 19 : 17} aria-hidden="true" />
                {collapsed ? null : <span className="rail-reveal">Library</span>}
              </NavLink>
            </li>
          </ul>
        </div>
        <div className="mt-auto">
          <AccountMenu classPath={classPath} collapsed={collapsed} spacious={spacious} />
        </div>
      </div>
    </>
  )
}

/* Guided setup (OnboardingWizard.jsx), reopened on demand — mounted here
 * rather than on a specific page since it's meant to greet the account, not
 * one route. First run itself no longer opens this as a modal over the app
 * shell: App.jsx's ClassRoutes guard routes any account with
 * `onboarding_seen_at` unset to the dedicated /c/:classId/onboarding page
 * (OnboardingSetupPage.jsx, same OnboardingWizard, `variant="page"`) before
 * AppShell — and this component — ever mounts. What's left here is only
 * SettingsPage's "Take the tour again" link, fired via onboardingWizardBus.js.
 *
 * `cls` picks the same class TemplateBanner does when there's a classId in
 * the URL, falling back to the account's first class otherwise (a reopen
 * from /settings has no classId) — there is nothing to confirm or upload
 * against without one, so this renders nothing until a class exists.
 */
function OnboardingWizardHost() {
  const { classId } = useParams()
  const navigate = useNavigate()
  const { data: classes = [] } = useClasses()
  const [open, setOpen] = useState(false)

  useEffect(() => onOpenOnboardingWizard(() => setOpen(true)), [])

  const cls = classes.find((c) => c.id === classId) || classes[0]

  if (!open) return null

  return (
    <Suspense fallback={<div role="status" className="fixed bottom-4 right-4 z-[220] rounded-md bg-paper-raised p-3 text-sm">Opening setup…</div>}>
    <OnboardingWizard
      open={open}
      cls={cls}
      onClose={(finishedClass, opts) => {
        setOpen(false)
        const target = finishedClass?.id || cls?.id
        if (opts?.prefill && target) navigate(`/c/${target}`, { state: { prefill: opts.prefill } })
      }}
    />
    </Suspense>
  )
}

export function AppShell({ children }) {
  const isNarrow = useMediaQuery(NARROW)
  const isPhone = useMediaQuery(PHONE)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const drawerRef = useRef(null)
  const drawerExit = useExitTransition(drawerOpen, 130)
  useFocusTrap(drawerRef, { active: drawerOpen, trap: drawerOpen, onEscape: () => setDrawerOpen(false) })

  /* Desktop-dock only — the narrow/phone drawer above already has its own
     open/close (drawerOpen). At >=lg the rail used to be a permanent fixture
     with no way to reclaim its width, unlike the artifact rail on the other
     side of the screen, which has had a collapse handle from the start.
     Persisted the same way chatWidthPx is (ChatPage.jsx), so it survives a
     reload instead of springing back open every visit. */
  const location = useLocation()
  const isChatRoute = /^\/c\/[^/]+(\/chat\/[^/]+)?$/.test(location.pathname)
  const isFocusMode = false // We now want the sidebar to be permanent across all pages
  const { user } = useAuth()

  const [railCollapsed, setRailCollapsed] = useState(() => {
    try {
      return readAccountStorage('rail-collapsed', user?.id) === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    setRailCollapsed(readAccountStorage('rail-collapsed', user?.id) === '1')
  }, [user?.id])
  const toggleRailCollapsed = () => {
    setRailCollapsed((collapsed) => {
      const next = !collapsed
      writeAccountStorage('rail-collapsed', user?.id, '', next ? '1' : '0')
      return next
    })
  }

  return (
    <WorkspaceRailContext.Provider value={{ collapsed: railCollapsed, toggle: toggleRailCollapsed }}>
      <div className="app-shell-frame flex h-full w-full overflow-hidden p-2 gap-2 relative z-10">
      <div className="app-blob" aria-hidden="true" />
      <a
        className="sr-only transition-all focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-ink focus:px-4 focus:py-2 focus:text-ink-inverse focus:shadow-md"
        href="#main"
      >
        Skip to content
      </a>

      {/* docked */}
      {!isNarrow && !isFocusMode ? (
        <div
          className="app-rail relative z-10 flex shrink-0 flex-row overflow-hidden transition-[width] bg-paper/40 backdrop-blur-3xl rounded-2xl glass-panel"
          style={{
            width: railCollapsed ? '68px' : 'var(--sidebar-w)',
            transitionDuration: 'var(--t-base)',
            transitionTimingFunction: 'var(--ease-out)',
          }}
        >
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <Rail collapsed={railCollapsed} onToggleCollapse={toggleRailCollapsed} />
          </div>
        </div>
      ) : null}

      {/* drawer */}
      {isNarrow && drawerExit.mounted ? (
        createPortal(
          <>
            <button
              type="button"
              className={`panel-scrim${drawerExit.closing ? ' is-closing' : ''}`}
              aria-label="Close menu"
              onClick={() => setDrawerOpen(false)}
            />
            <div
              ref={drawerRef}
              className={`app-rail rail-drawer neo-world${drawerExit.closing ? ' is-closing' : ''} fixed inset-y-0 left-0 z-[210] flex w-[min(300px,85vw)] flex-col shadow-lg`}
            >
              <Rail onNavigate={() => setDrawerOpen(false)} onClose={() => setDrawerOpen(false)} />
            </div>
          </>,
          document.body
        )
      ) : null}

      <div
        className="app-shell-main relative z-10 flex min-w-0 flex-1 flex-col overflow-hidden bg-paper/40 backdrop-blur-3xl rounded-2xl glass-panel"
        id="main"
      >
        <OnboardingWizardHost />
        {user?.read_only ? (
          <div className="shrink-0 border-b border-blue-500/20 bg-blue-500/10 px-4 py-2.5 text-center text-xs font-medium text-blue-700">
            Explore demo · read-only. Existing plans, citations, and exports are available; generation and account changes are disabled.
          </div>
        ) : null}
        {isNarrow && (!isPhone || !isChatRoute) ? (
          <div className="relative flex h-12 shrink-0 items-center gap-2 border-b border-edge px-2">
            <button
              type="button"
              className="btn-icon"
              aria-label="Show menu"
              onClick={() => setDrawerOpen(true)}
            >
              <PanelLeft size={17} aria-hidden="true" />
            </button>
            <span className="pointer-events-none absolute inset-x-0 truncate text-center text-sm font-semibold tracking-tight text-ink">
              FlexEd Academy
            </span>
          </div>
        ) : null}
        
        {location.pathname.match(/^\/c\/[^/]+(\/chat\/[^/]+)?$/) ? (
          <div className="min-h-0 flex-1 flex flex-row gap-2">
            {children}
          </div>
        ) : (
          <div className="min-h-0 flex-1">{children}</div>
        )}
      </div>
      </div>
    </WorkspaceRailContext.Provider>
  )
}
