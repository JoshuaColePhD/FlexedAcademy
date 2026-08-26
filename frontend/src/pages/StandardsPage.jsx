import { SplitLayout } from "../components/SplitLayout"
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search, Loader2, Database, BookOpen, ChevronDown, ListFilter, Plus, FileText } from 'lucide-react'
import { api } from '../lib/api'
import { useActiveClass } from '../hooks/useAppData'
import { useNavigate, Link } from 'react-router-dom'
import { useToast } from '../lib/toastContext'

function StandardRow({ s, classId, subject, coverageCount }) {
  const [expanded, setExpanded] = useState(false)
  const navigate = useNavigate()
  const toast = useToast()

  const handleQuickAdd = (e) => {
    e.stopPropagation()
    const text = `Focus this lesson on ${s.code}: ${s.description}`
    navigate(`/c/${classId}?prefill=${encodeURIComponent(text)}`)
    toast({ title: 'Added to chat', type: 'success' })
  }

  const { data: lessons, isLoading: lessonsLoading } = useQuery({
    queryKey: ['standards', s.code, 'lessons', classId],
    queryFn: () => api.getStandardLessons(s.code, classId),
    enabled: expanded && !!classId,
    staleTime: Infinity
  })

  const isChild = !!s.parent_code

  return (
    <div 
      className={`flex flex-col gap-2 rounded-xl bg-paper/40 hover:bg-paper/60 backdrop-blur-md p-4 transition-colors border border-white/5 shadow-sm cursor-pointer ${isChild ? 'ml-6 border-l-4 border-l-edge/50 rounded-l-none' : ''}`}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-start gap-4">
        <div className="flex flex-col gap-2 shrink-0 pt-0.5">
          <span className="rounded-md bg-paper-sunken px-2.5 py-1 text-sm font-mono font-medium text-ink border border-edge/30">
            {s.code}
          </span>
          {coverageCount > 0 ? (
            <span className="text-[10px] font-semibold uppercase tracking-wide bg-emerald-500/10 text-emerald-600 px-2 py-0.5 rounded-full text-center border border-emerald-500/20">
              Used {coverageCount}x
            </span>
          ) : (
            <span className="text-[10px] font-semibold uppercase tracking-wide bg-ink/5 text-ink-muted px-2 py-0.5 rounded-full text-center border border-ink/10">
              0x Taught
            </span>
          )}
        </div>
        
        <div className="flex-1 min-w-0 pt-1.5">
          {s.parent_code && expanded && (
            <p className="text-xs text-ink-muted mb-1 font-medium">{s.parent_text}</p>
          )}
          <p className={`text-sm text-ink ${expanded ? '' : 'truncate'}`}>
            {s.description}
          </p>
        </div>
        
        <div className="shrink-0 flex items-center gap-2 pt-1">
          <button 
            onClick={handleQuickAdd}
            className="hidden md:flex items-center gap-1.5 text-xs font-medium text-ink-muted hover:text-accent bg-paper-sunken hover:bg-accent/10 px-2.5 py-1.5 rounded-md transition-colors border border-edge/30 hover:border-accent/30"
            title="Add to active lesson plan"
          >
            <Plus size={14} /> Add to Plan
          </button>
          
          <div className="w-8 h-8 flex items-center justify-center">
            <ChevronDown 
              size={16} 
              className={`text-ink-muted transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} 
            />
          </div>
        </div>
      </div>
      
      {expanded && (
        <div className="mt-2 pl-4 border-l-2 border-accent/30 flex flex-col gap-4">
          <div className="flex flex-wrap gap-2 mt-1">
            {s.grade && (
              <span className="text-[10px] font-semibold uppercase tracking-wide bg-accent/10 text-accent px-2 py-0.5 rounded-full">
                Grade {s.grade}
              </span>
            )}
            {s.strand && (
              <span className="text-[10px] font-semibold uppercase tracking-wide bg-ink/5 text-ink-muted px-2 py-0.5 rounded-full border border-ink/5">
                {s.strand}
              </span>
            )}
            {s.domain && (
              <span className="text-[10px] font-semibold uppercase tracking-wide bg-ink/5 text-ink-muted px-2 py-0.5 rounded-full border border-ink/5">
                {s.domain}
              </span>
            )}
          </div>
          
          {/* Past Lessons Integration */}
          <div className="mt-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-2">Past Lessons Taught</p>
            {lessonsLoading ? (
              <div className="flex items-center gap-2 text-sm text-ink-faint">
                <Loader2 size={14} className="animate-spin" /> Loading past lessons...
              </div>
            ) : lessons && lessons.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                {lessons.map(lesson => (
                  <Link 
                    key={lesson.id} 
                    to={`/c/${classId}/history`} 
                    className="flex items-center gap-2 text-sm text-accent hover:underline w-fit"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <FileText size={14} />
                    {lesson.title || 'Untitled Lesson'}
                  </Link>
                ))}
              </div>
            ) : (
              <p className="text-sm text-ink-faint">You haven't used this standard in a plan yet.</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export function StandardsPage() {
  const { activeClass, classId } = useActiveClass()
  const subject = activeClass?.subject
  const grade = activeClass?.grade

  const [search, setSearch] = useState('')
  const [selectedStrand, setSelectedStrand] = useState('All')

  const [viewMode, setViewMode] = useState('list') // 'list' | 'heatmap'

  // Fetch standards
  const { data, isLoading } = useQuery({
    queryKey: ['standards', subject, grade],
    queryFn: () => api.listStandards({ subject, grade }),
    staleTime: Infinity,
    enabled: !!subject && grade !== undefined,
  })

  // Fetch coverage heatmap
  const { data: coverageData } = useQuery({
    queryKey: ['standards', 'coverage', classId],
    queryFn: () => api.getStandardsCoverage(classId),
    staleTime: Infinity,
    enabled: !!classId
  })
  const coverage = coverageData || {}

  const standards = data?.items || []

  // Extract unique strands
  const strands = useMemo(() => {
    const set = new Set()
    for (const s of standards) {
      if (s.strand) set.add(s.strand)
    }
    const list = Array.from(set).sort()
    return ['All', ...list]
  }, [standards])

  // Reset selected strand if it disappears due to class change
  useMemo(() => {
    if (selectedStrand !== 'All' && !strands.includes(selectedStrand)) {
      setSelectedStrand('All')
    }
  }, [strands, selectedStrand])

  const filtered = useMemo(() => {
    let result = standards

    if (selectedStrand !== 'All') {
      result = result.filter(s => s.strand === selectedStrand)
    }

    const q = search.toLowerCase().trim()
    if (q) {
      result = result.filter(
        (s) =>
          s.code.toLowerCase().includes(q) ||
          (s.description || '').toLowerCase().includes(q) ||
          (s.strand || '').toLowerCase().includes(q)
      )
    }
    return result
  }, [standards, search, selectedStrand])

  const tabs = strands.map(strand => ({
    id: strand,
    label: strand === 'All' ? 'All Standards' : strand,
  }))

  return (
    <SplitLayout
      title="Standards Browser"
      icon={Database}
      tabs={tabs}
      activeTab={selectedStrand}
      onTabChange={setSelectedStrand}
      backPath="/"
    >
      <div className="flex flex-col gap-6 w-full max-w-7xl mx-auto">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-2xl font-bold text-ink">Standards Browser</h1>
              {activeClass && (
                <span className="rounded-full bg-paper-sunken px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider text-ink border border-edge/30">
                  {activeClass.name}
                </span>
              )}
            </div>
            <p className="text-sm text-ink-muted">
              Browse, track, and add curriculum standards to your active lesson plans.
            </p>
          </div>
          
          {/* View Toggle */}
          <div className="flex items-center bg-paper-sunken p-1 rounded-lg border border-edge/30 shrink-0 w-fit">
            <button 
              onClick={() => setViewMode('list')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${viewMode === 'list' ? 'bg-paper shadow-sm text-ink' : 'text-ink-muted hover:text-ink'}`}
            >
              List View
            </button>
            <button 
              onClick={() => setViewMode('heatmap')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${viewMode === 'heatmap' ? 'bg-paper shadow-sm text-ink' : 'text-ink-muted hover:text-ink'}`}
            >
              Visual Heatmap
            </button>
          </div>
        </div>

        {/* Right Content - Standards List */}
        <div className="flex-1 flex flex-col">
          <div className="flex w-full items-center gap-3 rounded-xl bg-paper/50 backdrop-blur-md px-4 py-3 shadow-inner ring-1 ring-white/10 focus-within:ring-accent transition-all mb-6">
            <Search size={20} className="text-ink-muted shrink-0" />
            <input
              type="text"
              placeholder="Search standards by code or keyword..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-transparent text-base text-ink outline-none placeholder:text-ink-faint"
            />
          </div>

          {isLoading ? (
            <div className="flex mt-20 flex-col items-center justify-center text-ink-muted gap-3">
              <Loader2 size={32} className="animate-spin text-accent" />
              <p className="text-sm font-medium">Loading standards...</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex mt-20 flex-col items-center justify-center text-center text-ink-muted">
              <BookOpen size={48} className="mb-4 opacity-20" />
              <p className="text-lg font-medium text-ink">No standards found</p>
              <p className="text-sm mt-1">Try adjusting your search query or category.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2 pb-20">
              <div className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-2 px-2 flex justify-between">
                <span>{selectedStrand === 'All' ? 'All Standards' : selectedStrand}</span>
                <span>{filtered.length} {filtered.length === 1 ? 'result' : 'results'}</span>
              </div>
              
              {viewMode === 'heatmap' ? (
                <div className="flex flex-wrap gap-3 mt-4">
                  {filtered.map(s => {
                    const count = coverage[s.code] || 0
                    let bgColor = 'bg-paper-sunken border-edge/30 text-ink-muted hover:bg-paper hover:border-edge/60'
                    if (count > 0) bgColor = 'bg-emerald-500/20 border-emerald-500/40 text-emerald-700 hover:bg-emerald-500/30'
                    if (count > 2) bgColor = 'bg-emerald-500/40 border-emerald-500/60 text-emerald-800 hover:bg-emerald-500/50'
                    if (count > 5) bgColor = 'bg-emerald-500/80 border-emerald-500 text-white hover:bg-emerald-500'
                    
                    return (
                      <div 
                        key={s.code} 
                        title={`${s.code}\n${s.description}\nUsed ${count}x`} 
                        className={`flex flex-col items-center justify-center p-2 rounded-xl border-2 transition-colors cursor-help w-20 h-20 ${bgColor}`}
                      >
                        <span className="text-[11px] font-bold text-center leading-tight truncate w-full px-1">{s.code.split('.').pop()}</span>
                        <span className="text-[10px] opacity-75 mt-1 font-mono bg-black/5 px-1.5 rounded-sm">{count}x</span>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {filtered.map((s, i) => (
                    <StandardRow 
                      key={`${s.code}-${i}`} 
                      s={s} 
                      classId={classId} 
                      subject={subject} 
                      coverageCount={coverage[s.code] || 0}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </SplitLayout>
  )
}

