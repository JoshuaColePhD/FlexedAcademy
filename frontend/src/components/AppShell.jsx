import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useExitTransition } from '../hooks/useExitTransition'
import { Link, NavLink, useLocation, useNavigate, useParams } from 'react-router-dom'
import { ChevronLeft, ChevronRight, FileText, PanelLeft, Pencil, Pin, Plus, Trash2, Users, X, Database } from 'lucide-react'

import { useChats, useDeleteChat, useRenameChat } from '../hooks/useAppData'
import { ShellContext } from '../lib/shellContext'
import { useAuth } from '../lib/authContext'
import { useConfirm } from '../lib/confirmContext'
import { useToast } from '../lib/toastContext'
import { NARROW, useMediaQuery } from '../hooks/useMediaQuery'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { AccountMenu } from './AccountMenu'
import { SkeletonText } from './Skeleton'
import { OnboardingWizard } from './OnboardingWizard'
import { onOpenOnboardingWizard } from '../lib/onboardingWizardBus'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { qk } from '../lib/queryKeys'

/* The frame. A chat client's shape, which is what this is now.
 *
 * The rail is a plain flex column, not a resizable <Panel> — that is what forced
 * two nested PanelGroups with two fighting layout ids, and nobody resizes a
 * 264px nav. The one PanelGroup left splits the chat from the plan.
 */

function ChatRow({ chat, classId, onDelete, onPin, onNavigate }) {
  const rename = useRenameChat()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(chat.title)

  const commit = () => {
    const next = draft.trim()
    setEditing(false)
    if (next && next !== chat.title) rename.mutate({ id: chat.id, title: next })
    else setDraft(chat.title)
  }

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

  return (
    <motion.li 
      className="group relative px-2"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0, x: -20, transition: { duration: 0.2 } }}
    >
      <NavLink
        to={`/c/${classId}/chat/${chat.id}`}
        // Every other row in this rail (New plan, History, Plans) already
        // closes the phone drawer on navigate — this one was the one
        // link left out, so opening a chat from the drawer left the drawer
        // sitting open over it instead of getting out of the way.
        onClick={onNavigate}
        className={({ isActive }) =>
          /* neo-inset, not a background tint — "pressed in" is what already
             means "selected" in this world (see every neo-raised button's
             own :active state), so the active row reads as a permanent
             version of that same press instead of a third, unrelated
             signal. */
          `flex min-h-[28px] py-1.5 items-center rounded-md px-2 pr-4 text-sm transition-all duration-300 ${
            isActive ? 'neo-inset bg-paper-sunken text-accent-text drop-shadow-[0_0_8px_rgba(var(--accent-rgb),0.5)] font-medium' : 'text-ink-soft hover:bg-paper-inset/60 hover:text-ink'
          }`
        }
      >
        <span className="truncate">{chat.title}</span>
      </NavLink>
      <span className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-md bg-paper p-0.5 shadow-sm border border-edge/50 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <button
          type="button"
          className={`btn-icon ${chat.is_pinned ? 'text-amber-500' : ''}`}
          aria-label={chat.is_pinned ? `Unpin ${chat.title}` : `Pin ${chat.title}`}
          onClick={() => onPin(chat)}
        >
          <Pin size={13} aria-hidden="true" className={chat.is_pinned ? 'fill-amber-500' : ''} />
        </button>
        <button
          type="button"
          className="btn-icon"
          aria-label={`Rename ${chat.title}`}
          onClick={() => setEditing(true)}
        >
          <Pencil size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="btn-icon"
          aria-label={`Delete ${chat.title}`}
          onClick={() => onDelete(chat)}
        >
          <Trash2 size={13} aria-hidden="true" />
        </button>
      </span>
    </motion.li>
  )
}

/* Exported so ChatPage.jsx can reuse it as the phone-only "home" screen —
   chats list + Workspace Tools + Settings, the same content as the desktop
   sidebar, landing where a teacher currently gets dropped straight into an
   empty chat instead. See MobileChatHome.jsx. */
export function Rail({ onNavigate, onClose, collapsed, onToggleCollapse, headerExtra }) {
  const { entitlement } = useAuth()
  const { classId } = useParams()
  const location = useLocation()
  const { data: chats, isLoading, refetch } = useChats()
  const deleteChat = useDeleteChat()
  const confirm = useConfirm()
  const toast = useToast()
  const navigate = useNavigate()
  const classPath = `/c/${classId}`
  const togglePin = async (chat) => {
    try {
      await api.togglePin(chat.id, !chat.is_pinned)
      refetch()
    } catch (err) {
      toast.apiError('Could not pin chat', err)
    }
  }

  const pinnedChats = chats?.filter(c => c.is_pinned) || []
  const recentChats = chats?.filter(c => !c.is_pinned) || []
  
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
      <div className="flex h-14 shrink-0 items-center gap-2 px-3 mt-2">
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
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-bold tracking-tight text-ink">
            FlexEd Academy
          </span>
        )}
        {/* Same collapse toggle as the app-rail-handle groove on the sidebar's
            own edge (AppShell's docked wrapper below) — that one's easy to
            miss since it's a hover/touch strip with no label of its own.
            This copy lives right in the header, next to the wordmark it
            collapses away, so the control is visible without having to find
            the seam first. Collapsed state already has its own re-expand
            affordance (the edge handle), so this only needs to render
            expanded — same reasoning as the wordmark it sits beside. */}
        {!collapsed && onToggleCollapse ? (
          <button
            type="button"
            className="btn-icon shrink-0 !h-6 !w-6"
            aria-label="Collapse the sidebar"
            title="Collapse the sidebar"
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
        <motion.div whileHover={{ scale: 1.02, y: -1 }} className={collapsed ? 'flex justify-center' : ''}>
          <Link
            to={classPath}
            onClick={onNavigate}
            title={collapsed ? 'New plan' : undefined}
            className={`fa-press neo-raised btn-blob flex items-center rounded-md text-sm font-medium text-ink transition-all duration-300 overflow-hidden whitespace-nowrap ${
              collapsed ? 'justify-center w-10 h-10 px-0' : 'gap-2 px-3 py-1.5 min-h-[32px] w-full'
            }`}
          >
            <Plus size={15} aria-hidden="true" className="shrink-0" />
            {collapsed ? null : (
              <>
                <span className="flex-1 overflow-hidden text-ellipsis">New plan</span>
                <kbd className="font-mono text-2xs shrink-0">⌘K</kbd>
              </>
            )}
          </Link>
        </motion.div>
      </div>

      {collapsed ? null : (
        <nav className="min-h-0 flex-1 flex flex-col pt-2" aria-label="Your plans">
          <div className="min-h-0 flex-1 overflow-y-auto pb-4">
            
            {pinnedChats.length > 0 && (
              <div className="mb-4">
                <p className="eyebrow px-4 pb-1">Pinned</p>
                <ul className="flex flex-col gap-0">
                  <AnimatePresence initial={false}>
                    {pinnedChats.map((c) => (
                      <ChatRow key={c.id} chat={c} classId={classId} onDelete={remove} onPin={togglePin} onNavigate={onNavigate} />
                    ))}
                  </AnimatePresence>
                </ul>
              </div>
            )}

            <div className="flex items-center justify-between px-4 pb-1 mt-2">
              <p className="eyebrow">Recent</p>
              <Link
                to={`${classPath}/history`}
                onClick={onNavigate}
                className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-ink-muted hover:text-ink"
                aria-label="Edit chat history"
              >
                <Pencil size={11} aria-hidden="true" />
                Edit
              </Link>
            </div>
            
            {isLoading ? (
              <div className="px-4 py-2">
                <SkeletonText lines={4} />
              </div>
            ) : recentChats.length ? (
              <ul className="flex flex-col gap-0">
                <AnimatePresence initial={false}>
                  {recentChats.map((c) => (
                    <ChatRow key={c.id} chat={c} classId={classId} onDelete={remove} onPin={togglePin} onNavigate={onNavigate} />
                  ))}
                </AnimatePresence>
              </ul>
            ) : !pinnedChats.length && (
              <p className="px-4 py-2 text-xs text-ink-muted">
                Nothing yet. Describe a week to get started.
              </p>
            )}
          </div>
        </nav>
      )}

      <motion.div layout className={`pt-2 pb-1 flex flex-col ${collapsed ? 'flex-1' : 'shrink-0'}`}>
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
          {collapsed ? null : <p className="eyebrow px-4 pb-2">Workspace Tools</p>}
          <ul className={`flex flex-col gap-0 ${collapsed ? 'px-1 items-center' : 'px-2'}`}>
            <li>
              <NavLink
                to={`${classPath}/standards`}
                onClick={onNavigate}
                title="Standards Browser"
                className={({ isActive }) =>
                  `flex items-center gap-2.5 py-1.5 rounded-md text-sm transition-all duration-300 ${
                    collapsed ? 'justify-center w-10 h-10' : 'px-2'
                  } ${
                    isActive ? 'neo-inset bg-paper-sunken text-accent-text font-medium drop-shadow-[0_0_8px_rgba(var(--accent-rgb),0.3)]' : 'text-ink-soft hover:bg-paper-inset hover:text-ink'
                  }`
                }
              >
                <Database size={17} aria-hidden="true" />
                {collapsed ? null : <span>Standards Browser</span>}
              </NavLink>
            </li>
            <li>
              <NavLink
                to={`${classPath}/class`}
                end
                onClick={onNavigate}
                title="Classroom Profile"
                className={({ isActive }) =>
                  `flex items-center gap-2.5 py-1.5 rounded-md text-sm transition-all duration-300 ${
                    collapsed ? 'justify-center w-10 h-10' : 'px-2'
                  } ${
                    isActive ? 'neo-inset bg-paper-sunken text-accent-text font-medium drop-shadow-[0_0_8px_rgba(var(--accent-rgb),0.3)]' : 'text-ink-soft hover:bg-paper-inset hover:text-ink'
                  }`
                }
              >
                <Users size={17} aria-hidden="true" />
                {collapsed ? null : <span>Classroom Profile</span>}
              </NavLink>
            </li>
            <li>
              <NavLink
                to={`${classPath}/plans`}
                onClick={onNavigate}
                title="Library"
                className={({ isActive }) =>
                  `flex items-center gap-2.5 py-1.5 rounded-md text-sm transition-all duration-300 ${
                    collapsed ? 'justify-center w-10 h-10' : 'px-2'
                  } ${
                    isActive ? 'neo-inset bg-paper-sunken text-accent-text font-medium drop-shadow-[0_0_8px_rgba(var(--accent-rgb),0.3)]' : 'text-ink-soft hover:bg-paper-inset hover:text-ink'
                  }`
                }
              >
                <FileText size={17} aria-hidden="true" />
                {collapsed ? null : <span>Library</span>}
              </NavLink>
            </li>
          </ul>
        </div>
        <div className="mt-auto">
          <AccountMenu classPath={classPath} collapsed={collapsed} />
        </div>
      </motion.div>
    </>
  )
}

/* Post-login guided setup (OnboardingWizard.jsx) — mounted here rather than
 * on a specific page since it's meant to greet the account, not one route.
 * Opens automatically once per account (gated on user.onboarding_seen_at,
 * NULL meaning "never"), and again on demand via the event
 * SettingsPage's "Take the tour again" link fires (onboardingWizardBus.js).
 *
 * `cls` picks the same class TemplateBanner does when there's a classId in
 * the URL, falling back to the account's first class otherwise (e.g. a
 * forced reopen from /settings, which has no classId) — there is nothing
 * to confirm or upload against without one, so this renders nothing until a
 * class exists.
 */
function OnboardingWizardHost() {
  const { user } = useAuth()
  const { classId } = useParams()
  const { data: classes = [] } = useQuery({ queryKey: qk.classes, queryFn: () => api.listClasses() })
  const [forcedOpen, setForcedOpen] = useState(false)
  // Closing only ever flipped forcedOpen to false, which was already false
  // for the auto-open path — autoOpen stayed true (server write hadn't been
  // reflected in `user` yet, or failed outright) and the wizard reappeared
  // immediately, looking like the close button did nothing. This tracks an
  // explicit "the user is done with this" for the session, independent of
  // whether the server-side mark-seen call ever lands.
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => onOpenOnboardingWizard(() => { setForcedOpen(true); setDismissed(false) }), [])

  const cls = classes.find((c) => c.id === classId) || classes[0]
  const autoOpen = !!user && !user.onboarding_seen_at && !!cls
  const open = !dismissed && (forcedOpen || autoOpen)

  return (
    <OnboardingWizard
      open={open}
      cls={cls}
      onClose={() => {
        setForcedOpen(false)
        setDismissed(true)
      }}
    />
  )
}

export function AppShell({ children }) {
  const isNarrow = useMediaQuery(NARROW)
  const [drawerOpen, setDrawerOpen] = useState(false)
  /* Owned here, set by ChatPage — see lib/shellContext.js. The rail is the one
     column with slack in it, so it gives up 48px while the document is open. */
  const [docOpen, setDocOpen] = useState(false)
  const shell = useMemo(() => ({ docOpen, setDocOpen }), [docOpen])
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
  const isFocusMode = false // We now want the sidebar to be permanent across all pages

  const [railCollapsed, setRailCollapsed] = useState(() => {
    try {
      return localStorage.getItem('aplang.railCollapsed') === '1'
    } catch {
      return false
    }
  })
  const toggleRailCollapsed = () => {
    setRailCollapsed((collapsed) => {
      const next = !collapsed
      try {
        localStorage.setItem('aplang.railCollapsed', next ? '1' : '0')
      } catch {
        /* not persisted */
      }
      return next
    })
  }

  return (
    <ShellContext.Provider value={shell}>
    <div className="flex h-full w-full overflow-hidden p-2 gap-2 relative z-10">
      <div className="app-blob" aria-hidden="true" />
      <a
        className="sr-only transition-all focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-ink focus:px-4 focus:py-2 focus:text-ink-inverse focus:shadow-md"
        href="#main"
      >
        Skip to content
      </a>

      {/* docked */}
      {!isNarrow && !isFocusMode ? (
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 30 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1], delay: 0.1 }}
          className="app-rail relative z-10 flex shrink-0 flex-row overflow-hidden transition-[width] bg-paper/40 backdrop-blur-3xl rounded-2xl glass-panel"
          style={{
            width: railCollapsed ? '68px' : docOpen ? 'var(--sidebar-w-tight)' : 'var(--sidebar-w)',
            transitionDuration: 'var(--t-base)',
            transitionTimingFunction: 'var(--ease-out)',
          }}
        >
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <Rail collapsed={railCollapsed} onToggleCollapse={toggleRailCollapsed} />
          </div>
          {/* Same seam-handle language as the artifact rail's own collapse
              control on the other side of the screen (ArtifactRail.jsx) —
              a groove found by hover/touch, not a labeled button competing
              with everything else in the header. The chevron is always
              drawn (not just while collapsed) so the handle reads as
              clickable in both states; it just flips to point whichever
              way this click will move the rail. */}
          <button
            type="button"
            className="app-rail-handle tap-target"
            onClick={toggleRailCollapsed}
            aria-expanded={!railCollapsed}
            aria-label={railCollapsed ? 'Show the sidebar' : 'Collapse the sidebar'}
            title={railCollapsed ? 'Show the sidebar' : 'Collapse the sidebar'}
          >
            {railCollapsed ? (
              <ChevronRight className="app-rail-handle-arrow" aria-hidden="true" />
            ) : (
              <ChevronLeft className="app-rail-handle-arrow" aria-hidden="true" />
            )}
          </button>
        </motion.div>
      ) : null}

      {/* drawer */}
      {isNarrow && drawerExit.mounted ? (
        <>
          <button
            type="button"
            className={`panel-scrim${drawerExit.closing ? ' is-closing' : ''}`}
            aria-label="Close menu"
            onClick={() => setDrawerOpen(false)}
          />
          <div
            ref={drawerRef}
            className={`app-rail rail-drawer${drawerExit.closing ? ' is-closing' : ''} fixed inset-y-0 left-0 z-50 flex w-[min(300px,85vw)] flex-col shadow-lg`}
          >
            <Rail onNavigate={() => setDrawerOpen(false)} onClose={() => setDrawerOpen(false)} />
          </div>
        </>
      ) : null}

      <motion.div 
        initial={{ opacity: 0, scale: 0.96, y: 30 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1], delay: 0.25 }}
        className="relative z-10 flex min-w-0 flex-1 flex-col overflow-hidden bg-paper/40 backdrop-blur-3xl rounded-2xl glass-panel"
        id="main"
      >
        <OnboardingWizardHost />
        {isNarrow && !location.pathname.match(/^\/c\/[^/]+(\/chat\/[^/]+)?$/) ? (
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
      </motion.div>
    </div>
    </ShellContext.Provider>
  )
}
