import { BookOpen, GraduationCap, MessageCircle, Settings } from 'lucide-react'
import { NavLink, useLocation } from 'react-router-dom'
import { haptic } from '../lib/haptics'

const TABS = [
  { id: 'chats', label: 'Chats', icon: MessageCircle },
  { id: 'plans', label: 'Plans', icon: BookOpen },
  { id: 'classes', label: 'Classes', icon: GraduationCap },
  { id: 'settings', label: 'Settings', icon: Settings },
]

function tabIsActive(id, pathname, classPath) {
  if (id === 'chats') return pathname === classPath || pathname.startsWith(`${classPath}/chat/`)
  return pathname === `${classPath}/${id === 'classes' ? 'class' : id}` || pathname.startsWith(`${classPath}/${id === 'classes' ? 'class' : id}/`)
}

export function MobileTabBar({ classId }) {
  const location = useLocation()
  if (!classId) return null

  const classPath = `/c/${classId}`

  return (
    <nav className="mobile-tab-bar" aria-label="Primary navigation">
      {TABS.map(({ id, label, icon: Icon }) => {
        const active = tabIsActive(id, location.pathname, classPath)
        const target = id === 'chats' ? classPath : `${classPath}/${id === 'classes' ? 'class' : id}`
        return (
          <NavLink
            key={id}
            to={target}
            end={id === 'chats'}
            state={id === 'chats' ? { mobileHome: true } : undefined}
            onClick={(event) => haptic('light', event)}
            className={`mobile-tab-item fa-press${active ? ' is-active' : ''}`}
            aria-current={active ? 'page' : undefined}
          >
            <span className="mobile-tab-icon" aria-hidden="true">
              <Icon size={21} strokeWidth={active ? 2.2 : 1.8} />
            </span>
            <span className="mobile-tab-label">{label}</span>
          </NavLink>
        )
      })}
    </nav>
  )
}
