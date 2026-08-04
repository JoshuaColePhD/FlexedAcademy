import { useCallback, useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { api } from './lib/api'
import { useTheme } from './hooks/useTheme'
import { NARROW, useMediaQuery } from './hooks/useMediaQuery'
import { useToast } from './lib/toastContext'
import { ToastProvider } from './components/ToastProvider'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Sidebar } from './components/Sidebar'
import { ChatPage } from './pages/ChatPage'
import { PlansPage } from './pages/PlansPage'
import { StandardsPage } from './pages/StandardsPage'
import { MyClassPage } from './pages/MyClassPage'
import { NotFoundPage } from './pages/NotFoundPage'
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'

const LEGACY_KEY = 'lesson_chats'
const SIDEBAR_KEY = 'aplang.sidebarCollapsed'

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

  const [chats, setChats] = useState([])
  const [currentChatId, setCurrentChatId] = useState(null)
  const [settings, setSettings] = useState(null)
  const isNarrow = useMediaQuery(NARROW)
  const [collapsed, setCollapsed] = useState(() => {
    // On a narrow screen the sidebar is an overlay drawer, so it must start shut
    // rather than covering the app on first load.
    if (window.matchMedia?.(NARROW).matches) return true
    try {
      return localStorage.getItem(SIDEBAR_KEY) === '1'
    } catch {
      return false
    }
  })

  // Crossing the breakpoint changes what the sidebar IS (a column vs. an
  // overlay), so the open/closed default has to change with it.
  useEffect(() => {
    setCollapsed(isNarrow)
  }, [isNarrow])

  const refreshChats = useCallback(() => {
    api
      .listChats()
      .then(setChats)
      .catch(() => {})
  }, [])

  useLegacyImport(refreshChats)

  useEffect(() => {
    refreshChats()
    api
      .getSettings()
      .then(setSettings)
      .catch((err) =>
        toast.error('Can’t reach the backend', err.hint || 'Start it with ./run.sh, then reload.')
      )
  }, [refreshChats, toast])

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
        toast.error('Could not rename that chat', err.message)
        refreshChats()
      }
    },
    [toast, refreshChats]
  )

  const deleteChat = useCallback(
    async (chat) => {
      if (!confirm(`Delete “${chat.title}”? Plans it generated are kept.`)) return
      setChats((prev) => prev.filter((c) => c.id !== chat.id))
      if (currentChatId === chat.id) setCurrentChatId(null)
      try {
        await api.deleteChat(chat.id)
      } catch (err) {
        toast.error('Could not delete that chat', err.message)
        refreshChats()
      }
    },
    [currentChatId, toast, refreshChats]
  )

  // Cmd/Ctrl+K starts a new plan, the way Claude does.
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
    theme,
    onToggleSidebar: toggleSidebar,
    refreshChats,
  }

  const narrowOpen = isNarrow && !collapsed

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <Sidebar
        collapsed={collapsed}
        onClose={() => setCollapsed(true)}
        chats={chats}
        currentChatId={currentChatId}
        onNewChat={newChat}
        onOpenChat={openChat}
        onRenameChat={renameChat}
        onDeleteChat={deleteChat}
        settings={settings}
      />

      {narrowOpen ? (
        <button
          type="button"
          className="scrim only-narrow"
          aria-label="Close menu"
          onClick={() => setCollapsed(true)}
        />
      ) : null}

      <main className="main" id="main">
        <Routes location={location}>
          <Route path="/" element={<ChatPage shell={shell} />} />
          <Route path="/plans" element={<PlansPage shell={shell} />} />
          <Route path="/standards" element={<StandardsPage shell={shell} />} />
          <Route path="/my-class" element={<MyClassPage shell={shell} />} />
          {/* Old paths from the stub nav. */}
          <Route path="/artifacts" element={<Navigate to="/plans" replace />} />
          <Route path="/customize" element={<Navigate to="/my-class" replace />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </div>
  )
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <ToastProvider>
          <Shell />
        </ToastProvider>
      </BrowserRouter>
    </ErrorBoundary>
  )
}
