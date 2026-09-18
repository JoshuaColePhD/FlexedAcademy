import { chatAvatarColor, chatPreview, formatChatListTime } from '../lib/chatPresentation'
import { haptic } from '../lib/haptics'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useExitTransition } from '../hooks/useExitTransition'
import { Link, NavLink, useLocation, useNavigate, useParams } from 'react-router-dom'
import { ChevronDown, MoreHorizontal, Pencil, Pin, Plus, Search, Trash2, X } from 'lucide-react'

import { useChats, useClasses, useDeleteChat, useRenameChat, useTogglePin } from '../hooks/useAppData'
import { useAuth } from '../lib/authContext'
import { useConfirm } from '../lib/confirmContext'
import { useToast } from '../lib/toastContext'
import { PHONE, TOUCH, between, useMediaQuery } from '../hooks/useMediaQuery'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { AccountMenu } from './AccountMenu'
import { MobileTabBar } from './MobileTabBar'
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
// Open only after a committed drag. Halfway + a 300px/s flick felt like
// ice: a light thumb slide would snap the row open. ~62% travel and a
// real flick are closer to Mail.app's planted swipe.
const SWIPE_OPEN_DISTANCE = Math.round(SWIPE_ACTIONS_WIDTH * 0.62)
const SWIPE_FLICK_VELOCITY = 720
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
        haptic('light')
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
          dragDirectionLock
          dragConstraints={{ left: -SWIPE_ACTIONS_WIDTH, right: 0 }}
          dragElastic={0}
          dragMomentum={false}
          animate={{ x: swipeOpen ? -SWIPE_ACTIONS_WIDTH : 0 }}
          transition={{ type: 'spring', stiffness: 680, damping: 58, mass: 0.85 }}
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
            const past = info.offset.x < -SWIPE_OPEN_DISTANCE
            if (past !== crossedRef.current) {
              crossedRef.current = past
              if (past) haptic('selection')
            }
          }}
          onDragEnd={(_e, info) => {
            // A planted swipe commits; a light slide snaps back. Past the
            // open distance, or a decisive flick — not a 300px/s graze.
            const pastOpen = info.offset.x < -SWIPE_OPEN_DISTANCE
            const flickedOpen = info.velocity.x < -SWIPE_FLICK_VELOCITY
            const flickedClosed = info.velocity.x > SWIPE_FLICK_VELOCITY
            onSwipeOpenChange(flickedClosed ? false : flickedOpen || pastOpen)
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
  const { data: chats, isLoading } = useChats()
  const deleteChat = useDeleteChat()
  const confirm = useConfirm()
  const toast = useToast()
  const navigate = useNavigate()
  const classPath = `/c/${classId}`
  // Only one row's swipe strip open at a time — opening a second one closes
  // whichever was already open, same as every native swipe-action list.
  const [swipeOpenId, setSwipeOpenId] = useState(null)
  const searchInputRef = useRef(null)
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
        <div className="rail-collapsed-actions flex h-full min-h-0 shrink-0 flex-col items-center justify-between py-2">
          <Link
            to={classPath}
            onClick={(event) => {
              onToggleCollapse?.()
              haptic('light')
              onNavigate?.(event)
            }}
            className="chat-workspace-add"
            aria-label="New chat"
            title="New chat"
          >
            <Plus size={20} aria-hidden="true" />
          </Link>
          <AccountMenu classPath={classPath} collapsed />
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
        <Link to={classPath} onClick={(event) => { haptic('light'); onNavigate?.(event) }} className={`chat-workspace-add${spacious ? ' mobile-rail-new-chat' : ''}`} aria-label="New chat" title="New chat"><Plus size={20} aria-hidden="true" /></Link>
        {onClose ? (
          <button type="button" className="btn-icon" aria-label="Close menu" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      )}

      {spacious && !collapsed ? (
        <div className="mobile-chat-home-actions">
          <Link
            to={classPath}
            onClick={(event) => { haptic('light'); onNavigate?.(event) }}
            className="mobile-floating-new-chat"
            aria-label="Start a new chat"
            title="New chat"
          >
            <span>New Chat</span>
            <Plus size={22} strokeWidth={1.9} aria-hidden="true" />
          </Link>
          {headerExtra ? (
            <div className="mobile-chat-home-course-selector">
              {headerExtra}
            </div>
          ) : null}
        </div>
      ) : null}

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
      {headerExtra && !spacious ? <div className="px-2 pb-2">{headerExtra}</div> : null}


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
            className="min-h-0 flex-1 scroll-y pb-4"
          >
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
                onClick={(event) => { haptic('light'); onNavigate?.(event) }}
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

      {!collapsed && !spacious ? (
        <div className="flex w-full shrink-0 flex-col pt-2 pb-1">
          <div className="mt-auto w-full">
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
  const { classId } = useParams()
  const isPhone = useMediaQuery(PHONE)
  const isTablet = useMediaQuery(between('md', 'lg'))
  const tabletPortrait = useMediaQuery('(orientation: portrait)')
  const isTouch = useMediaQuery(TOUCH)
  /* iPad landscape gets the same persistent master/detail navigation as the
     desktop workspace. iPad portrait keeps the drawer so the conversation
     still has a comfortable reading width. A short landscape viewport is an
     iPhone in Safari, not an iPad, and remains on the compact phone path. */
  const isShortLandscape = useMediaQuery('(orientation: landscape) and (max-height: 520px)')
  const isTouchLandscapeTablet = useMediaQuery('(hover: none) and (pointer: coarse) and (orientation: landscape) and (min-height: 521px)')
  const usesTabletDock = !isPhone && !tabletPortrait && !isShortLandscape && (isTablet || isTouchLandscapeTablet)
  const usesDockedRail = !isPhone && (!isTablet || usesTabletDock)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const drawerRef = useRef(null)
  // Keep the mounted exit window aligned with the drawer's direct
  // translateX settle animation so it never vanishes mid-flight.
  const drawerExit = useExitTransition(drawerOpen, 170)
  useFocusTrap(drawerRef, { active: drawerOpen, trap: drawerOpen, onEscape: () => setDrawerOpen(false) })

  /* Desktop-dock only — the narrow/phone drawer above already has its own
     open/close (drawerOpen). At >=lg this is a true hide/show control, not a
     compact navigation strip: collapsing returns every pixel to the workspace.
     Persist it so the teacher's preferred layout survives reloads. */
  const location = useLocation()
  // The preview is mounted under `/preview.html`, while production mounts at
  // `/`. Match the class route at the end of either basename so footer
  // visibility does not depend on how the app was launched.
  const isChatRoute = /(?:^|\/)c\/[^/]+(?:\/chat\/[^/]+)?$/.test(location.pathname)
  const isActiveConversation = /\/c\/[^/]+\/chat\/[^/]+$/.test(location.pathname)
  // `/c/:classId` serves two intentionally different phone surfaces: a blank
  // new-plan composer and the Chats list revealed by the in-app back action.
  // Only the list owns the bottom navigation; the composer needs the extra
  // vertical room and already has its own back/new-chat controls.
  const isMobileChatHome = isChatRoute && !isActiveConversation && location.state?.mobileHome
  /* Settings, Class Profiles, Admin, and Contact Support are focused
     master/detail views. Give
     their own split panels the full shell width so the chat rail never crowds
     the page's navigation and content surfaces. */
  const isFocusedRoute = /\/(settings|class|admin|contact|assignment-preview)$/.test(location.pathname)
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
  const toggleRailCollapsed = useCallback(() => {
    setRailCollapsed((collapsed) => {
      const next = !collapsed
      writeAccountStorage('rail-collapsed', user?.id, '', next ? '1' : '0')
      return next
    })
  }, [user?.id])

  const toggleWorkspaceRail = useCallback(() => {
    if (usesDockedRail) {
      toggleRailCollapsed()
      return
    }
    setDrawerOpen((open) => !open)
  }, [toggleRailCollapsed, usesDockedRail])

  const [documentReading, setDocumentReading] = useState(false)
  const effectiveRailCollapsed = railCollapsed || routeCollapsesRail || documentReading
  const workspaceRailValue = useMemo(
    () => ({
      collapsed: effectiveRailCollapsed,
      docked: usesDockedRail,
      drawerOpen,
      documentReading,
      toggle: toggleWorkspaceRail,
      setDocumentReading,
    }),
    [drawerOpen, effectiveRailCollapsed, documentReading, toggleWorkspaceRail, usesDockedRail],
  )

  return (
    <WorkspaceRailContext.Provider value={workspaceRailValue}>
      <div className={`app-shell-frame flex h-full w-full overflow-hidden p-2 gap-2 relative z-10${effectiveRailCollapsed ? ' is-rail-collapsed' : ''}${usesTabletDock ? ' is-tablet-landscape' : ''}`}>
      <div className="app-blob" aria-hidden="true" />
      <a
        className="sr-only transition-all focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-ink focus:px-4 focus:py-2 focus:text-ink-inverse focus:shadow-md"
        href="#main"
      >
        Skip to content
      </a>

      {/* docked */}
      {usesDockedRail ? (
        <div
          className="app-rail relative z-10 flex shrink-0 flex-row overflow-hidden transition-[width] bg-paper/40 backdrop-blur-3xl rounded-2xl glass-panel"
          style={{
            width: effectiveRailCollapsed ? '0px' : 'var(--sidebar-w)',
            transitionDuration: documentReading ? 'var(--t-reader)' : 'var(--t-base)',
            transitionTimingFunction: documentReading ? 'var(--ease-glide)' : 'var(--ease-out)',
          }}
        >
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <Rail collapsed={effectiveRailCollapsed} onToggleCollapse={toggleRailCollapsed} touchActions={isTouch} />
          </div>
        </div>
      ) : null}

      {/* drawer */}
      {!usesDockedRail && drawerExit.mounted ? (
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
        {!usesDockedRail && !isChatRoute ? (
          <div className="mobile-app-brand-bar relative flex h-12 shrink-0 items-center gap-2 border-b border-edge px-2">
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
        {isPhone && classId && (!isChatRoute || isMobileChatHome) ? <MobileTabBar classId={classId} /> : null}
      </div>
      </div>
    </WorkspaceRailContext.Provider>
  )
}
