import { NavLink, useLocation } from 'react-router-dom'
import { CalendarDays, GraduationCap, MessageSquare, Rows3 } from 'lucide-react'
import { useActiveClass, useCalendar, useChats } from '../hooks/useAppData'
import { defaultWeek } from '../lib/queue'
import { ClassSwitcher } from './ClassSwitcher'
import { AccountMenu } from './AccountMenu'
import { NextUp } from './NextUp'

/* The frame every class-scoped page renders into.
 *
 * The rail is a plain flex column, NOT a resizable <Panel>. Making it resizable
 * is what forced two nested PanelGroups with two fighting autoSave ids — and
 * nobody resizes a 264px nav. The one PanelGroup left in the app is on the week
 * page, splitting the plan from its rail.
 *
 * What changed inside it is the point: the rail used to be a list of chat
 * titles with a class switcher on top, which is the Claude/ChatGPT shape atom
 * for atom. It is a year rail now. Chats are one destination with a count, not
 * the whole surface. Nothing about the palette changed; the app stops looking
 * like a chat client because it stopped being shaped like one.
 */

function railLink({ isActive }) {
  return `flex min-h-touch items-center gap-2.5 rounded-md px-3 text-sm transition-colors ${
    isActive ? 'bg-paper-inset font-medium text-ink' : 'text-ink-soft hover:bg-paper-inset/60'
  }`
}

function NavItems({ classPath, weekHref, chatCount, onNavigate }) {
  return (
    <>
      <NavLink to={`${classPath}/calendar`} className={railLink} onClick={onNavigate}>
        <CalendarDays size={16} aria-hidden="true" /> Year
      </NavLink>
      <NavLink to={weekHref} className={railLink} onClick={onNavigate}>
        <Rows3 size={16} aria-hidden="true" /> This week
      </NavLink>
      <NavLink to={`${classPath}/chat`} className={railLink} onClick={onNavigate}>
        <MessageSquare size={16} aria-hidden="true" />
        <span className="flex-1">Chats</span>
        {chatCount ? (
          <span className="font-mono text-2xs tabular-nums text-ink-faint">{chatCount}</span>
        ) : null}
      </NavLink>
      <NavLink to={`${classPath}/class`} className={railLink} onClick={onNavigate}>
        <GraduationCap size={16} aria-hidden="true" /> My classes
      </NavLink>
    </>
  )
}

/* Phone navigation. Four destinations, always visible.
   A 264px drawer over a 375px screen covered 70% of the viewport to show a list
   of chat titles — on a surface where you can't start a chat anyway. */
function TabBar({ classPath, weekHref }) {
  const tabs = [
    { to: `${classPath}/calendar`, label: 'Year', Icon: CalendarDays },
    { to: weekHref, label: 'Week', Icon: Rows3 },
    { to: `${classPath}/chat`, label: 'Chat', Icon: MessageSquare },
    { to: `${classPath}/class`, label: 'Class', Icon: GraduationCap },
  ]
  return (
    <nav className="tabbar lg:hidden" aria-label="Main">
      {tabs.map(({ to, label, Icon }) => (
        <NavLink
          key={label}
          to={to}
          className={({ isActive }) => `tabbar-item ${isActive ? 'is-active' : ''}`}
        >
          <Icon size={19} aria-hidden="true" />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  )
}

export function AppShell({ children }) {
  const { classId, classes, activeClass } = useActiveClass()
  const { data: chats } = useChats()
  const { data: calendar } = useCalendar(classId)
  const location = useLocation()

  const classPath = `/c/${classId}`
  // "This week" means the week you'd actually want: the current one while the
  // year is running, else the next one that needs planning.
  const target = defaultWeek(calendar?.weeks)
  const weekHref = target ? `${classPath}/week/${target.week}` : `${classPath}/week/next`

  const onCalendarOrWeek =
    location.pathname.includes('/calendar') || location.pathname.includes('/week')

  return (
    <div className="flex h-app w-full overflow-hidden bg-paper font-sans text-ink">
      <a
        className="sr-only transition-all focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-ink focus:px-4 focus:py-2 focus:text-ink-inverse focus:shadow-md"
        href="#main"
      >
        Skip to content
      </a>

      {/* ── the year rail (desktop) ─────────────────────────────────────── */}
      <div className="hidden w-[264px] shrink-0 flex-col border-r border-edge bg-paper-sunken lg:flex">
        <div className="flex h-14 shrink-0 items-center gap-2.5 px-4">
          <span
            aria-hidden="true"
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-ink text-[0.75rem] font-bold text-ink-inverse"
          >
            F
          </span>
          <span className="truncate text-sm font-semibold tracking-tight text-ink">
            Flexed Academy
          </span>
        </div>

        <ClassSwitcher classes={classes} activeClass={activeClass} classPath={classPath} />

        <NextUp classId={classId} />

        <nav className="flex flex-col gap-0.5 px-2" aria-label="Main">
          <NavItems classPath={classPath} weekHref={weekHref} chatCount={chats?.length} />
        </nav>

        <div className="flex-1" />
        <div className="shrink-0 border-t border-edge">
          <AccountMenu classPath={classPath} />
        </div>
      </div>

      {/* ── main ────────────────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden" id="main">
        <div className="min-h-0 flex-1">{children}</div>

        {/* The queue follows you on a phone, where there is no rail to hold it. */}
        {onCalendarOrWeek ? (
          <div className="shrink-0 lg:hidden">
            <NextUp classId={classId} variant="bar" />
          </div>
        ) : null}

        <TabBar classPath={classPath} weekHref={weekHref} />
      </div>
    </div>
  )
}
