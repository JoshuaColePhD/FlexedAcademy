import { useCallback, useEffect, useRef, useState } from 'react'
import { BrowserRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels'
import { GoogleOAuthProvider } from '@react-oauth/google'
import { api } from './lib/api'
import { useTheme } from './hooks/useTheme'
import { NARROW, useMediaQuery } from './hooks/useMediaQuery'
import { useToast } from './lib/toastContext'
import { ToastProvider } from './components/ToastProvider'
import { ConfirmProvider } from './components/ConfirmProvider'
import { useConfirm } from './lib/confirmContext'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Sidebar } from './components/Sidebar'
import { AuthProvider } from './components/AuthProvider'
import { useAuth } from './lib/authContext'
import { ChatPage } from './pages/ChatPage'
import { MyClassPage } from './pages/MyClassPage'
import LoginPage from './pages/LoginPage'
import { NotFoundPage } from './pages/NotFoundPage'
import './styles/base.css'

const LEGACY_KEY = 'lesson_chats'
const SIDEBAR_KEY = 'aplang.sidebarCollapsed'

/** The teacher's docked-layout preference. One reader, used by both the initial
 *  state and the breakpoint effect, so they can't disagree. */
function readCollapsedPref() {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1'
  } catch {
    return false
  }
}

/** One-time migration of the old localStorage chats into the database.
 *  localStorage is cleared only after the import succeeds, so a failure is never
 *  data loss. */
function useLegacyImport(onImported) {
  const toast = useToast()
  useEffect(() => {
    let raw
    try {
      raw = localStorage.getItem(LEGACY_KEY)
    } catch {
      return
    }
    if (!raw) return

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      // A corrupt entry used to white-screen the app permanently on boot.
      try {
        localStorage.removeItem(LEGACY_KEY)
      } catch {
        /* nothing more to do */
      }
      return
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      try {
        localStorage.removeItem(LEGACY_KEY)
      } catch {
        /* ignore */
      }
      return
    }

    api
      .importChats(parsed)
      .then((res) => {
        localStorage.removeItem(LEGACY_KEY)
        if (res.imported) {
          toast.success(
            `Moved ${res.imported} conversation${res.imported === 1 ? '' : 's'} to the server`,
            'They were only in this browser before.'
          )
          onImported?.()
        }
      })
      .catch(() => {
        // Leave localStorage intact and try again next load.
      })
  }, [toast, onImported])
}

function Shell() {
  const theme = useTheme()
  const toast = useToast()
  const navigate = useNavigate()
  const location = useLocation()
  const confirm = useConfirm()

  const [chats, setChats] = useState([])
  const [currentChatId, setCurrentChatId] = useState(null)
  const [settings, setSettings] = useState(null)
  const isNarrow = useMediaQuery(NARROW)
  const [collapsed, setCollapsed] = useState(() => {
    // On a narrow screen the sidebar is an overlay drawer, so it must start shut
    // rather than covering the app on first load.
    if (window.matchMedia?.(NARROW).matches) return true
    return readCollapsedPref()
  })

  // Crossing the breakpoint changes what the sidebar IS (a column vs. an
  // overlay), so the open/closed default has to change with it.
  //
  // Guarded by the previous value because this effect also runs on mount, where
  // it used to overwrite the localStorage preference the useState initialiser had
  // just restored — so the docked preference was written on every toggle and
  // honoured on none. Coming back to desktop now restores it rather than forcing
  // the sidebar open.
  const prevNarrowRef = useRef(isNarrow)
  useEffect(() => {
    if (prevNarrowRef.current === isNarrow) return
    prevNarrowRef.current = isNarrow
    setCollapsed(isNarrow ? true : readCollapsedPref())
  }, [isNarrow])

  // A failed fetch used to be swallowed, so the sidebar showed "Nothing yet.
  // Describe a week to get started." — a backend outage rendered as an empty
  // state, which invites the teacher to start a duplicate of a chat that exists.
  const [chatsError, setChatsError] = useState(null)
  const [chatsLoading, setChatsLoading] = useState(true)

  const refreshChats = useCallback(() => {
    setChatsLoading(true)
    return api
      .listChats()
      .then((rows) => {
        setChats(rows)
        setChatsError(null)
      })
      .catch((err) => setChatsError(err))
      .finally(() => setChatsLoading(false))
  }, [])

  useLegacyImport(refreshChats)

  // Recorded, not just toasted: MyClassPage derives `dirty` from `settings`, so a
  // null settings object used to disable Save permanently with no explanation.
  const [settingsError, setSettingsError] = useState(null)

  const loadSettings = useCallback(
    () =>
      api
        .getSettings()
        .then((row) => {
          setSettings(row)
          setSettingsError(null)
        })
        .catch((err) => {
          setSettingsError(err)
          toast.apiError('Can’t reach the backend', err, 'Start it with ./run.sh, then reload.')
        }),
    [toast]
  )

  useEffect(() => {
    refreshChats()
    loadSettings()
  }, [refreshChats, loadSettings])

  const toggleSidebar = useCallback(() => {
    setCollapsed((c) => {
      const next = !c
      // Only remember the choice for the docked layout; the drawer always
      // reopens shut.
      if (!window.matchMedia?.(NARROW).matches) {
        try {
          localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0')
        } catch {
          /* not persisted */
        }
      }
      return next
    })
  }, [])

  const newChat = useCallback(() => {
    setCurrentChatId(null)
    navigate('/')
  }, [navigate])

  const openChat = useCallback(
    (id) => {
      setCurrentChatId(id)
      navigate('/')
      if (window.matchMedia?.(NARROW).matches) setCollapsed(true)
    },
    [navigate]
  )

  const renameChat = useCallback(
    async (id, title) => {
      setChats((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)))
      try {
        await api.renameChat(id, title)
      } catch (err) {
        toast.apiError('Could not rename that chat', err)
        refreshChats()
      }
    },
    [toast, refreshChats]
  )

  const deleteChat = useCallback(
    async (chat) => {
      const ok = await confirm({
        title: `Delete “${chat.title}”?`,
        body: 'Plans it generated are kept.',
        confirmLabel: 'Delete',
        tone: 'danger',
      })
      if (!ok) return
      setChats((prev) => prev.filter((c) => c.id !== chat.id))
      if (currentChatId === chat.id) setCurrentChatId(null)
      try {
        await api.deleteChat(chat.id)
      } catch (err) {
        toast.apiError('Could not delete that chat', err)
        refreshChats()
      }
    },
    [currentChatId, toast, refreshChats, confirm]
  )

  /* Cmd/Ctrl+K starts a new plan. The Sidebar shows the shortcut next to "New
     plan" — it existed here for a while with no affordance anywhere, so nobody
     could have known about it.

     There used to be a global contextmenu handler here suppressing right-click
     "for IDE feel". It is gone: teachers copy text out of a plan constantly, and
     it broke every one of those attempts. */
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        newChat()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newChat])

  const shell = {
    chats,
    setChats,
    currentChatId,
    setCurrentChatId,
    settings,
    setSettings,
    settingsError,
    reloadSettings: loadSettings,
    theme,
    onToggleSidebar: toggleSidebar,
    refreshChats,
    collapsed,
  }

  const narrowOpen = isNarrow && !collapsed

  return (
    <div className="h-full w-full overflow-hidden bg-paper font-sans text-ink">
      <a className="sr-only transition-all focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-ink focus:px-4 focus:py-2 focus:text-ink-inverse focus:shadow-md" href="#main">
        Skip to content
      </a>

      <PanelGroup autoSaveId="app-layout-v2" orientation="horizontal" className="h-full w-full">
        
        {/* Mobile Sidebar Overlay */}
        {narrowOpen && (
          <div className="fixed inset-y-0 left-0 z-50 flex h-full w-[264px] flex-col bg-paper-sunken shadow-lg">
            <Sidebar
              collapsed={false}
              onClose={() => setCollapsed(true)}
              onToggleSidebar={toggleSidebar}
              chats={chats}
              currentChatId={currentChatId}
              onNewChat={newChat}
              onOpenChat={openChat}
              onRenameChat={renameChat}
              onDeleteChat={deleteChat}
              settings={settings}
              chatsError={chatsError}
              chatsLoading={chatsLoading}
              onRetryChats={refreshChats}
              isNarrow={isNarrow}
              theme={theme}
            />
          </div>
        )}

        {/* Desktop Sidebar Panel */}
        {!isNarrow && !collapsed && (
          <>
            <Panel order={1} id="sidebar" defaultSize="20" minSize="15" maxSize="30" className="flex h-full flex-col overflow-hidden bg-paper-sunken">
              <Sidebar
                collapsed={collapsed}
                onClose={() => setCollapsed(true)}
                onToggleSidebar={toggleSidebar}
                chats={chats}
                currentChatId={currentChatId}
                onNewChat={newChat}
                onOpenChat={openChat}
                onRenameChat={renameChat}
                onDeleteChat={deleteChat}
                settings={settings}
                chatsError={chatsError}
                chatsLoading={chatsLoading}
                onRetryChats={refreshChats}
                isNarrow={isNarrow}
                theme={theme}
              />
            </Panel>
            <PanelResizeHandle className="w-px shrink-0 cursor-col-resize bg-edge transition-colors hover:bg-edge-strong active:w-0.5 active:bg-accent" />
          </>
        )}

        {/* Mobile Backdrop */}
        {narrowOpen && (
          <button
            type="button"
            className="fixed inset-0 z-40 bg-[var(--scrim)] backdrop-blur-[2px]"
            aria-label="Close menu"
            onClick={() => setCollapsed(true)}
          />
        )}

        <Panel order={2} className="relative flex min-w-[300px] flex-col overflow-hidden bg-paper" id="main">
          <Routes location={location}>
            <Route path="/" element={<ChatPage shell={shell} />} />
            <Route path="/my-class" element={<MyClassPage shell={shell} />} />
            <Route path="*" element={<NotFoundPage shell={shell} />} />
          </Routes>
        </Panel>
      </PanelGroup>
    </div>
  )
}

/** Renders the login form until a session cookie resolves to a real user —
 *  everything below this (chats, plans, settings) is per-teacher data now, so
 *  nothing in Shell should mount before we know who's asking. */
function Gate() {
  const { status } = useAuth()
  if (status === 'loading') return null // Or a spinner
  if (status === 'anon') return <LoginPage />
  return <Shell />
}

export default function App() {
  return (
    <GoogleOAuthProvider clientId={import.meta.env.VITE_GOOGLE_CLIENT_ID}>
      <ErrorBoundary>
        <BrowserRouter>
          <ToastProvider>
            <ConfirmProvider>
              <AuthProvider>
                <Gate />
              </AuthProvider>
            </ConfirmProvider>
          </ToastProvider>
        </BrowserRouter>
      </ErrorBoundary>
    </GoogleOAuthProvider>
  )
}
