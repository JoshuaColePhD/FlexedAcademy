import { chatAvatarColor, chatPreview, formatChatListTime } from '../lib/chatPresentation'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useExitTransition } from '../hooks/useExitTransition'
import { Link, NavLink, useLocation, useNavigate, useParams } from 'react-router-dom'
import { ChevronDown, MoreHorizontal, Pencil, Pin, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react'

import { useChats, useClasses, useDeleteChat, useRenameChat, useTogglePin } from '../hooks/useAppData'
import { usePullToRefresh } from '../hooks/usePullToRefresh'
import { useAuth } from '../lib/authContext'
import { useConfirm } from '../lib/confirmContext'
import { useToast } from '../lib/toastContext'
import { NARROW, PHONE, TOUCH, useMediaQuery } from '../hooks/useMediaQuery'
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

function ChatRow({ chat, classId, onDelete, onPin, onNavigate, spacious, touchActions = false, swipeOpen, onSwipeOpenChange }) {
  const rename = useRenameChat()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(chat.title)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const optionsRef = useRef(null)
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
    if (!optionsOpen) return undefined
    const onPointerDown = (event) => {
      if (!optionsRef.current?.contains(event.target)) setOptionsOpen(false)
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOptionsOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [optionsOpen])

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
      className={({ isActive }) => `chat-workspace-chat-row${isActive ? ' is-active' : ''}${spacious || touchActions ? ' is-swipe-row' : ''}`}
    >
      <span className="chat-workspace-avatar" style={{ backgroundColor: chatAvatarColor(chat) }} aria-hidden="true">
        {(chat.title || 'Chat').replace(/[^A-Za-z]/g, '').slice(0, 1).toUpperCase() || 'C'}
      </span>
      <span className="chat-workspace-chat-copy">
        <span className="chat-workspace-chat-heading">
          <span className="truncate">{chat.title || 'Untitled chat'}</span>
          <time dateTime={chat.updated_at || chat.created_at || undefined}>{formatChatListTime(chat.updated_at || chat.created_at)}</time>
        </span>
        <span className="chat-workspace-chat-preview">{chatPreview(chat)}</span>
      </span>
    </NavLink>
  )

  if (spacious || touchActions) {
    // Swipe-to-reveal, the native iOS list pattern, instead of the
    // desktop/tablet hover-reveal cluster: on a screen with no hover at
    // all, a row permanently showing three icons reads as cluttered (see
    // .chat-row-actions's own history — that CSS fix made the icons
    // reachable on touch for the first time, but "always visible" and
    // "phone-native" are different bars). Pin/rename/delete sit on a
    // layer BEHIND the row; dragging the row left uncovers them, same as
    // Mail.app or Messages. This branch is used both by the spacious
    // phone home and by the compact phone drawer.
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
      <div ref={optionsRef} className={`chat-row-options${optionsOpen ? ' is-open' : ''}`}>
        <button
          type="button"
          className="chat-row-options-trigger"
          aria-label={`Options for ${chat.title}`}
          aria-haspopup="menu"
          aria-expanded={optionsOpen}
          title="Chat options"
          onClick={() => setOptionsOpen((open) => !open)}
        >
          <MoreHorizontal size={17} aria-hidden="true" />
        </button>
        {optionsOpen ? (
          <div className="chat-row-options-menu" role="menu" aria-label={`Options for ${chat.title}`}>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onPin(chat)
                setOptionsOpen(false)
              }}
            >
              <Pin size={15} aria-hidden="true" className={chat.is_pinned ? 'fill-amber-500' : ''} />
              {chat.is_pinned ? 'Unpin chat' : 'Pin chat'}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setEditing(true)
                setOptionsOpen(false)
              }}
            >
              <Pencil size={15} aria-hidden="true" />
              Rename chat
            </button>
            <button
              type="button"
              role="menuitem"
              className="is-destructive"
              onClick={() => {
                onDelete(chat)
                setOptionsOpen(false)
              }}
            >
              <Trash2 size={15} aria-hidden="true" />
              Delete chat
            </button>
          </div>
        ) : null}
      </div>
    </motion.li>
  )
}

/* Exported so ChatPage.jsx can reuse it as the phone-only "home" screen —
   the chats list and account controls, the same core content as the desktop
   sidebar, landing where a teacher currently gets dropped straight into an
   empty chat instead. See MobileChatHome.jsx. */
export function Rail({ onNavigate, onClose, collapsed, onToggleCollapse, headerExtra, spacious, touchActions = false }) {
  const { classId } = useParams()
  const location = useLocation()
  const { data: chats, isLoading, refetch } = useChats()
  const deleteChat = useDeleteChat()
  const confirm = useConfirm()
  const toast = useToast()
  const navigate = useNavigate()
  const classPath = `/c/${classId}`
  // Only one row's swipe strip open at a time — opening a second one closes
  // whichever was already open, same as every native swipe-action list.
  const [swipeOpenId, setSwipeOpenId] = useState(null)
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
  const [searchOpen, setSearchOpen] = useState(false)
  const [recentOpen, setRecentOpen] = useState(true)
  const chatSearchQuery = chatSearch.trim().toLowerCase()
  const searchFilter = (c) => !chatSearchQuery || `${c.title || ''} ${c.last_message_preview || c.preview || ''}`.toLowerCase().includes(chatSearchQuery)

  const pinnedChats = (chats?.filter((c) => c.is_pinned) || []).filter(searchFilter)
  const recentChats = (chats?.filter((c) => !c.is_pinned) || []).filter(searchFilter)
  const visibleRecentChats = recentChats
  const showRecentChats = recentOpen || Boolean(chatSearchQuery)

  useEffect(() => {
    if (!searchOpen) return undefined
    const frame = requestAnimationFrame(() => searchInputRef.current?.focus())
    const closeOnEscape = (event) => {
      if (event.key !== 'Escape') return
      setChatSearch('')
      setSearchOpen(false)
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [searchOpen])

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
      {collapsed ? (
        <div className="flex h-14 shrink-0 items-center justify-center">
          <Link
            to={classPath}
            onClick={(event) => {
              onToggleCollapse?.()
              onNavigate?.(event)
            }}
            className="chat-workspace-add"
            aria-label="New chat"
            title="New chat"
          >
            <Plus size={20} aria-hidden="true" />
          </Link>
        </div>
      ) : (
      <div className="rail-brand-row flex h-14 shrink-0 items-center gap-2 px-3 mt-2">
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
        <span className="rail-reveal min-w-0 flex-1 truncate text-[13.5px] font-bold tracking-tight text-ink">
          FlexEd Academy
        </span>
        <button
          type="button"
          className="chat-workspace-add"
          aria-label={searchOpen ? 'Close chat search' : 'Search chats'}
          title={searchOpen ? 'Close search' : 'Search chats'}
          onClick={() => {
            setChatSearch('')
            setSearchOpen((open) => !open)
          }}
        >
          {searchOpen ? <X size={18} aria-hidden="true" /> : <Search size={18} aria-hidden="true" />}
        </button>
        <Link to={classPath} onClick={onNavigate} className="chat-workspace-add" aria-label="New chat" title="New chat"><Plus size={20} aria-hidden="true" /></Link>
        {onClose ? (
          <button type="button" className="btn-icon" aria-label="Close menu" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      )}

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


      {!collapsed && searchOpen ? (
        <div className="rail-search-popover px-3 pb-3 pt-1">
          <label className="chat-workspace-search-field">
            <Search size={17} aria-hidden="true" />
            <input ref={searchInputRef} type="search" value={chatSearch} onChange={(event) => setChatSearch(event.target.value)} placeholder="Search chats" aria-label="Search your chats" />
          </label>
        </div>
      ) : null}

      {collapsed ? null : (
        <nav className="rail-reveal min-h-0 flex-1 flex flex-col pt-2" aria-label="Your chats">
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
                      <ChatRow key={c.id} chat={c} classId={classId} onDelete={remove} onPin={togglePin} onNavigate={onNavigate} spacious={spacious} touchActions={touchActions} swipeOpen={swipeOpenId === c.id} onSwipeOpenChange={(open) => setSwipeOpenId(open ? c.id : null)} />
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
                          <ChatRow key={c.id} chat={c} classId={classId} onDelete={remove} onPin={togglePin} onNavigate={onNavigate} spacious={spacious} touchActions={touchActions} swipeOpen={swipeOpenId === c.id} onSwipeOpenChange={(open) => setSwipeOpenId(open ? c.id : null)} />
                        ))}
                      </AnimatePresence>
                    </ul>
                  </>
                ) : !pinnedChats.length && (
                  <p className="px-4 py-2 text-xs text-ink-muted">
                    {chatSearchQuery ? `No chats match "${chatSearch.trim()}".` : 'No chats yet. Start one with +.'}
                  </p>
                )}
              </div>
            ) : null}
          </div>
        </nav>
      )}

      {!collapsed ? (
        <div className="pt-2 pb-1 flex shrink-0 flex-col">
          <div className="mt-auto">
            <AccountMenu classPath={classPath} collapsed={false} spacious={spacious} />
          </div>
        </div>
      ) : null}
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
  const isTouch = useMediaQuery(TOUCH)
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
  /* Settings, Class Profiles, Admin, and Contact Support are focused
     master/detail views. Give
     their own split panels the full shell width so the chat rail never crowds
     the page's navigation and content surfaces. */
  const isFocusedRoute = /\/(settings|class|admin|contact)$/.test(location.pathname)
  const routeCollapsesRail = isFocusedRoute
  const { user, logout } = useAuth()

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

  const effectiveRailCollapsed = railCollapsed || routeCollapsesRail

  return (
    <WorkspaceRailContext.Provider value={{ collapsed: effectiveRailCollapsed, toggle: toggleRailCollapsed }}>
      <div className={`app-shell-frame flex h-full w-full overflow-hidden p-2 gap-2 relative z-10${effectiveRailCollapsed ? ' is-rail-collapsed' : ''}`}>
      <div className="app-blob" aria-hidden="true" />
      <a
        className="sr-only transition-all focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-ink focus:px-4 focus:py-2 focus:text-ink-inverse focus:shadow-md"
        href="#main"
      >
        Skip to content
      </a>

      {/* docked */}
      {!isNarrow ? (
        <div
          className="app-rail relative z-10 flex shrink-0 flex-row overflow-hidden transition-[width] bg-paper/40 backdrop-blur-3xl rounded-2xl glass-panel"
          style={{
            width: effectiveRailCollapsed ? '0px' : 'var(--sidebar-w)',
            transitionDuration: 'var(--t-base)',
            transitionTimingFunction: 'var(--ease-out)',
          }}
        >
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <Rail collapsed={effectiveRailCollapsed} onToggleCollapse={toggleRailCollapsed} touchActions={isTouch} />
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
              <Rail onNavigate={() => setDrawerOpen(false)} onClose={() => setDrawerOpen(false)} touchActions={isTouch} />
            </div>
          </>,
          document.body
        )
      ) : null}

      <div
        className={`app-shell-main${routeCollapsesRail ? ' is-focused-route' : ''} relative z-10 flex min-w-0 flex-1 flex-col overflow-hidden bg-paper/40 backdrop-blur-3xl rounded-2xl glass-panel`}
        id="main"
      >
        <OnboardingWizardHost />
        {user?.read_only ? (
          <div className="flex shrink-0 flex-col items-center justify-between gap-2 border-b border-blue-500/20 bg-blue-500/10 px-4 py-2.5 text-center text-xs text-blue-800 sm:flex-row sm:text-left">
            <p>
              <strong className="font-semibold">Recruiter showcase · read-only.</strong>{' '}
              Inspect the seeded plan, cited standards, and DOCX export. Generation and account changes are disabled.
            </p>
            <button
              type="button"
              onClick={() => logout()}
              className="shrink-0 rounded-md border border-blue-500/25 bg-white/45 px-2.5 py-1 font-semibold text-blue-700 transition-colors hover:bg-white/75"
            >
              Exit demo
            </button>
          </div>
        ) : null}
        {isNarrow && (!isPhone || !isChatRoute) ? (
          <div className="relative flex h-12 shrink-0 items-center gap-2 border-b border-edge px-2">
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
