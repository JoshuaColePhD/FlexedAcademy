import { PanelLeft } from 'lucide-react'

/* A thin strip, not a chrome bar.
 *
 * It used to carry `border-b`, `bg-paper/85` and `backdrop-blur-sm` — plus a
 * `sticky top-0` that never did anything, since this is a flex sibling of the
 * scroller rather than a child of it, so the blur was decorating a surface
 * nothing ever scrolled under. All of it is gone; the tone step between the
 * sidebar and the page does the separating.
 *
 * `course` is the safety net for a real gap: the composer no longer shows which
 * class a plan is being built for, so the sidebar footer is the only place that
 * lives — and the sidebar can be collapsed with a *persisted* preference. When
 * it is, the course comes up here so a teacher is never planning blind.
 */
export function TopBar({ title, course, collapsed, onToggleSidebar, children }) {
  return (
    <header className="flex h-14 shrink-0 items-center px-4">
      {collapsed && (
        <button
          type="button"
          className="mr-3 rounded-lg p-1.5 text-ink-muted transition-colors hover:bg-paper-sunken hover:text-ink"
          onClick={onToggleSidebar}
          aria-label="Show sidebar"
        >
          <PanelLeft size={16} aria-hidden="true" />
        </button>
      )}

      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        {title ? (
          <h2 className="truncate text-sm font-medium text-ink-soft">{title}</h2>
        ) : null}
        {collapsed && course ? (
          <span className="truncate text-xs text-ink-muted">{course}</span>
        ) : null}
      </div>

      {children ? <div className="ml-4 flex items-center gap-2">{children}</div> : null}
    </header>
  )
}
