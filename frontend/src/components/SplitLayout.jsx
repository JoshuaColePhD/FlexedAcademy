import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Settings } from 'lucide-react'

export function SplitLayout({ 
  title = 'Settings', 
  icon: Icon = Settings,
  tabs = [],
  children,
  onTabChange,
  activeTab: controlledActiveTab,
  backPath = null,
  bottomAction = null,
  contentMaxWidth = 'max-w-4xl',
  mobileTabs = null,
}) {
  const navigate = useNavigate()
  const scrollContainerRef = useRef(null)
  const [internalActiveTab, setInternalActiveTab] = useState(tabs[0]?.id)
  
  const activeTab = controlledActiveTab !== undefined ? controlledActiveTab : internalActiveTab

  // Intersection Observer for scroll spy
  useEffect(() => {
    // Only set up intersection observer if we are using internal state (not controlled)
    // and we have tabs that map to sections on the page.
    if (controlledActiveTab !== undefined || tabs.length === 0) return

    const observer = new IntersectionObserver(
      (entries) => {
        // Find the most visible section
        let maxRatio = 0
        let visibleId = null
        entries.forEach((entry) => {
          if (entry.isIntersecting && entry.intersectionRatio > maxRatio) {
            maxRatio = entry.intersectionRatio
            visibleId = entry.target.id
          }
        })
        if (visibleId) {
          const id = visibleId.replace('section-', '')
          setInternalActiveTab(id)
          if (onTabChange) onTabChange(id)
        }
      },
      {
        root: scrollContainerRef.current,
        threshold: [0.1, 0.5, 0.9],
        rootMargin: '-10% 0px -40% 0px',
      }
    )

    tabs.forEach((tab) => {
      const el = document.getElementById(`section-${tab.id}`)
      if (el) observer.observe(el)
    })

    return () => observer.disconnect()
  }, [tabs, controlledActiveTab, onTabChange])

  const scrollToSection = (id) => {
    if (controlledActiveTab !== undefined) {
      if (onTabChange) onTabChange(id)
      return
    }
    
    setInternalActiveTab(id)
    if (onTabChange) onTabChange(id)
      
    const el = document.getElementById(`section-${id}`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' })
    }
  }

  return (
    <div className="split-layout-shell flex h-full min-h-0 w-full overflow-hidden bg-paper/40 backdrop-blur-3xl saturate-[1.2] glass-panel border border-white/5">
      
      {/* Left Sidebar (Master) */}
      <div className="split-layout-sidebar hidden md:flex w-64 shrink-0 flex-col border-r border-edge bg-paper-sunken">
        <header className="flex h-14 shrink-0 items-center gap-2 px-4">
          <button
            onClick={() => backPath ? navigate(backPath) : navigate(-1)}
            aria-label="Back"
            className="rounded-md p-1.5 text-ink-muted transition-colors hover:bg-paper-inset hover:text-ink"
          >
            <ArrowLeft size={16} aria-hidden="true" />
          </button>
          <div className="flex items-center gap-1.5 min-w-0">
            {Icon && <Icon size={16} aria-hidden="true" className="text-ink-muted shrink-0" />}
            <h1 className="text-sm font-semibold text-ink truncate">{title}</h1>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto py-2">
          <nav className="flex flex-col px-2 gap-0.5">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => scrollToSection(tab.id)}
                className={`flex items-center justify-between min-h-touch rounded-lg px-2 text-sm transition-colors text-left ${
                  activeTab === tab.id
                    ? 'bg-paper shadow-sm ring-1 ring-black/5 font-medium text-ink'
                    : 'text-ink-soft hover:bg-paper-inset hover:text-ink'
                }`}
              >
                <span className="truncate">{tab.label}</span>
                {tab.count !== undefined && (
                  <span className="ml-2 inline-flex h-5 items-center justify-center rounded-full bg-edge/30 px-1.5 text-[10px] font-bold text-ink-muted">
                    {tab.count}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </div>
        
        {bottomAction && (
          <div className="shrink-0 border-t border-edge p-2">
            {bottomAction}
          </div>
        )}
      </div>

      {/* Right Content Area (Detail) */}
      <div className="split-layout-content flex-1 overflow-y-auto relative" ref={scrollContainerRef}>
        <div className={`split-layout-content-inner mx-auto p-6 md:p-10 lg:p-12 pb-32 ${contentMaxWidth}`}>
          {/* Mobile Header (Shows only on small screens) */}
          <div className="split-layout-mobile-header md:hidden flex items-center gap-3 mb-8">
             <button
              type="button"
              onClick={() => backPath ? navigate(backPath) : navigate(-1)}
              className="rounded-md p-1.5 text-ink-muted bg-paper-sunken border border-edge/30"
              aria-label="Go back"
            >
              <ArrowLeft size={16} aria-hidden="true" />
            </button>
            <h1 className="text-xl font-bold text-ink">{title}</h1>
          </div>

          {mobileTabs?.length ? (
            <nav className="split-layout-mobile-tabs md:hidden mb-8 -mx-1 flex gap-1 overflow-x-auto pb-1" aria-label={`${title} sections`}>
              {mobileTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => onTabChange?.(tab.id)}
                  aria-current={activeTab === tab.id ? 'page' : undefined}
                  className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                    activeTab === tab.id ? 'bg-ink text-paper' : 'bg-paper-inset text-ink-muted hover:text-ink'
                  }`}
                >
                  {tab.label}
                  {tab.count !== undefined ? ` · ${tab.count}` : ''}
                </button>
              ))}
            </nav>
          ) : null}
          
          {children}
        </div>
      </div>
    </div>
  )
}
