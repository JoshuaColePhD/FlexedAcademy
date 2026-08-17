import sys

file_path = "frontend/src/pages/SettingsPage.jsx"
with open(file_path, "r") as f:
    lines = f.readlines()

split_index = -1
for i, line in enumerate(lines):
    if line.startswith("export function SettingsPage() {"):
        split_index = i
        break

new_content = """export function SettingsPage() {
  const { classId } = useParams()
  const qc = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const meState = useQuery({ queryKey: qk.me, queryFn: () => api.me() })

  const [teacher, setTeacher] = useState('')
  const [savedName, setSavedName] = useState('')
  const [activeTab, setActiveTab] = useState('general')

  // Placeholder states
  const [outputFormat, setOutputFormat] = useState('narrative')
  const [aiTone, setAiTone] = useState('encouraging')
  const [autoSave, setAutoSave] = useState(true)
  const [classifyPlan, setClassifyPlan] = useState(false)
  const [theme, setTheme] = useState('system')
  const [fontSize, setFontSize] = useState('normal')
  const [highContrast, setHighContrast] = useState(false)
  const [betaFeatures, setBetaFeatures] = useState(false)

  const scrollContainerRef = useRef(null)

  useEffect(() => {
    const n = meState.data?.name || ''
    setTeacher(n)
    setSavedName(n)
  }, [meState.data])

  const commitTeacher = async () => {
    const next = teacher.trim()
    if (!next || next === savedName) return setTeacher(savedName)
    try {
      await api.updateMe({ name: next })
      setSavedName(next)
      toast.success('Saved')
      qc.invalidateQueries({ queryKey: qk.me })
    } catch (err) {
      toast.apiError('Could not save your name', err)
      setTeacher(savedName)
    }
  }

  const tabs = [
    { id: 'general', label: 'General' },
    { id: 'preferences', label: 'Preferences' },
    { id: 'account', label: 'Account & Security' },
    { id: 'integrations', label: 'Integrations' },
    { id: 'billing', label: 'Billing' },
    { id: 'advanced', label: 'Advanced' },
  ]

  // Intersection Observer for scroll spy
  useEffect(() => {
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
          setActiveTab(visibleId.replace('section-', ''))
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
  }, [])

  const scrollToSection = (id) => {
    setActiveTab(id)
    const el = document.getElementById(`section-${id}`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' })
    }
  }

  const fileRef = useRef(null)
  const [uploading, setUploading] = useState(false)
  const schoolsState = useQuery({ queryKey: qk.schools, queryFn: () => api.listSchools() })
  const schools = schoolsState.data || []
  const selectedSchool = schools.find((s) => s.id === meState.data?.school) || null

  const uploadCalendar = async (e) => {
    const file = e.target.files?.[0]
    if (!file || !selectedSchool) return
    setUploading(true)
    try {
      await api.uploadSchoolCalendar(selectedSchool.name, { file })
      toast.success('Calendar submitted', 'It is now applied to this school.')
      schoolsState.refetch()
    } catch (err) {
      toast.apiError('Could not upload the calendar', err)
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-paper">
      
      {/* Left Sidebar (Master) */}
      <div className="flex w-64 shrink-0 flex-col border-r border-edge bg-paper-sunken">
        <header className="flex h-14 shrink-0 items-center gap-2 px-4">
          <button
            onClick={() => navigate(-1)}
            aria-label="Back"
            className="rounded-md p-1.5 text-ink-muted transition-colors hover:bg-paper-inset hover:text-ink"
          >
            <ArrowLeft size={16} aria-hidden="true" />
          </button>
          <h1 className="text-sm font-semibold text-ink">Settings</h1>
        </header>

        <div className="flex-1 overflow-y-auto py-2">
          <nav className="flex flex-col px-2 gap-0.5">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => scrollToSection(tab.id)}
                className={`flex items-center justify-between min-h-touch rounded-lg px-2 text-sm transition-colors ${
                  activeTab === tab.id
                    ? 'bg-paper-inset font-medium text-ink'
                    : 'text-ink-soft hover:bg-paper-inset hover:text-ink'
                }`}
              >
                <span className="truncate">{tab.label}</span>
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* Right Content Area (Detail) */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="flex h-14 shrink-0 items-center border-b border-edge bg-paper/80 px-8 backdrop-blur-sm z-10">
          <div className="text-sm font-medium text-ink-muted">
            {tabs.find(t => t.id === activeTab)?.label}
          </div>
        </header>

        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-8 py-8 scroll-smooth">
          <div className="mx-auto w-full max-w-3xl flex flex-col gap-16 pb-32">
            
            {/* General Section */}
            <div id="section-general" className="scroll-mt-8">
              <h2 className="text-xl font-bold text-ink mb-6">General</h2>
              
              <section className="mb-8">
                <div className="border-b border-edge pb-2 mb-4">
                  <h3 className="text-sm font-semibold text-ink">Profile</h3>
                  <p className="text-xs text-ink-muted">How you are addressed in the app and on your plans.</p>
                </div>
                <div className="max-w-md">
                  <label htmlFor="teacher" className="mb-1 block text-xs text-ink-muted">
                    Your Name
                  </label>
                  <input
                    id="teacher"
                    value={teacher}
                    onChange={(e) => setTeacher(e.target.value)}
                    onBlur={commitTeacher}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur()
                      if (e.key === 'Escape') setTeacher(savedName)
                    }}
                    placeholder="Mr. Cole"
                    className="neo-inset w-full rounded-lg bg-paper-raised px-3 py-2 text-sm text-ink outline-none focus:ring-1 focus:ring-accent"
                  />
                </div>
              </section>
              
              <section className="mb-8">
                <SchoolPicker
                  value={meState.data?.school}
                  onSaved={() => qc.invalidateQueries({ queryKey: qk.me })}
                />
              </section>

              <section>
                <div className="border-b border-edge pb-2 mb-4">
                  <h3 className="text-sm font-semibold text-ink">AI Defaults</h3>
                  <p className="text-xs text-ink-muted">Default behaviors for plan generation.</p>
                </div>
                
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 max-w-xl mb-6">
                  <label className="block">
                    <span className="mb-1 block text-xs text-ink-muted">Default Output Format</span>
                    <select
                      value={outputFormat}
                      onChange={(e) => setOutputFormat(e.target.value)}
                      className="neo-select neo-inset w-full rounded-lg bg-paper-raised py-2.5 pl-2.5 pr-8 text-sm text-ink"
                    >
                      <option value="narrative">Narrative Text</option>
                      <option value="bullets">Bulleted Lists</option>
                      <option value="tables">Tables</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-ink-muted">AI Tone / Voice</span>
                    <select
                      value={aiTone}
                      onChange={(e) => setAiTone(e.target.value)}
                      className="neo-select neo-inset w-full rounded-lg bg-paper-raised py-2.5 pl-2.5 pr-8 text-sm text-ink"
                    >
                      <option value="formal">Formal</option>
                      <option value="encouraging">Encouraging</option>
                      <option value="direct">Direct</option>
                    </select>
                  </label>
                </div>

                <div className="max-w-xl border border-edge rounded-xl p-4">
                  <Toggle 
                    label="Auto-Save Drafts" 
                    description="Automatically save changes to your plans while editing."
                    checked={autoSave}
                    onChange={setAutoSave}
                  />
                  <div className="h-px w-full bg-edge my-2" />
                  <Toggle 
                    label="Classify Plan Status" 
                    description="Allow the AI to automatically label plans as Draft, Review, or Final."
                    checked={classifyPlan}
                    onChange={setClassifyPlan}
                  />
                </div>
              </section>
            </div>

            {/* Preferences Section */}
            <div id="section-preferences" className="scroll-mt-8">
              <h2 className="text-xl font-bold text-ink mb-6">Preferences</h2>
              
              <section className="mb-8">
                <DesignSkinSection />
              </section>
              
              <section className="mb-8">
                <div className="border-b border-edge pb-2 mb-4">
                  <h3 className="text-sm font-semibold text-ink">Interface Settings</h3>
                </div>
                
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 max-w-xl mb-6">
                  <label className="block">
                    <span className="mb-1 block text-xs text-ink-muted">Theme</span>
                    <select
                      value={theme}
                      onChange={(e) => setTheme(e.target.value)}
                      className="neo-select neo-inset w-full rounded-lg bg-paper-raised py-2.5 pl-2.5 pr-8 text-sm text-ink"
                    >
                      <option value="system">System Default</option>
                      <option value="light">Light</option>
                      <option value="dark">Dark</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-ink-muted">Editor Font Size</span>
                    <select
                      value={fontSize}
                      onChange={(e) => setFontSize(e.target.value)}
                      className="neo-select neo-inset w-full rounded-lg bg-paper-raised py-2.5 pl-2.5 pr-8 text-sm text-ink"
                    >
                      <option value="small">Small</option>
                      <option value="normal">Normal</option>
                      <option value="large">Large</option>
                    </select>
                  </label>
                </div>

                <div className="max-w-xl border border-edge rounded-xl p-4">
                  <Toggle 
                    label="High Contrast Mode" 
                    description="Increases text contrast across the application for readability."
                    checked={highContrast}
                    onChange={setHighContrast}
                  />
                </div>
              </section>

              <section>
                <CustomInstructions
                  value={meState.data?.custom_instructions}
                  onSaved={() => qc.invalidateQueries({ queryKey: qk.me })}
                />
              </section>
            </div>

            {/* Account Section */}
            <div id="section-account" className="scroll-mt-8">
              <h2 className="text-xl font-bold text-ink mb-6">Account & Security</h2>
              
              {meState.data && meState.data.has_password ? (
                <section className="mb-8">
                  <div className="border-b border-edge pb-2 mb-4">
                    <h3 className="text-sm font-semibold text-ink">Password</h3>
                  </div>
                  <ChangePassword />
                </section>
              ) : meState.data ? (
                <section className="mb-8">
                  <div className="border-b border-edge pb-2 mb-4">
                    <h3 className="text-sm font-semibold text-ink">Password</h3>
                  </div>
                  <p className="text-sm text-ink-muted">
                    This account signs in with Google — there’s no password to change here.
                  </p>
                </section>
              ) : null}
              <section>
                <AccountSafety />
              </section>
            </div>

            {/* Integrations Section */}
            <div id="section-integrations" className="scroll-mt-8">
              <h2 className="text-xl font-bold text-ink mb-6">Integrations</h2>
              
              <section>
                <GoogleDriveSection />
                
                <div className="mt-8">
                  <h2 className="text-sm font-semibold text-ink">Other Integrations</h2>
                  <p className="mt-1 text-xs text-ink-muted">
                    Connect your external accounts to push and pull assignments seamlessly.
                  </p>
                  
                  <IntegrationPlaceholder 
                    name="Canvas LMS" 
                    description="Export your plans directly to Canvas Modules."
                    icon={<span className="font-bold">C</span>}
                  />
                  
                  <IntegrationPlaceholder 
                    name="Microsoft OneDrive" 
                    description="Save and sync documents with OneDrive."
                    icon={<span className="font-bold">O</span>}
                  />
                </div>
              </section>
            </div>

            {/* Billing Section */}
            <div id="section-billing" className="scroll-mt-8">
              <h2 className="text-xl font-bold text-ink mb-6">Billing</h2>
              <section>
                <BillingSection />
              </section>
            </div>

            {/* Advanced Section */}
            <div id="section-advanced" className="scroll-mt-8">
              <h2 className="text-xl font-bold text-ink mb-6">Advanced</h2>
              <section>
                <div className="border-b border-edge pb-2 mb-4">
                  <h3 className="text-sm font-semibold text-ink">Experimental</h3>
                  <p className="text-xs text-ink-muted">Try out features before they are widely released.</p>
                </div>
                
                <div className="max-w-xl border border-edge rounded-xl p-4">
                  <Toggle 
                    label="Enable Beta Features" 
                    description="Opt-in to use experimental AI models and cutting-edge features."
                    checked={betaFeatures}
                    onChange={setBetaFeatures}
                  />
                </div>

                {import.meta.env.DEV && (
                  <div className="mt-8">
                    <Diagnostics />
                  </div>
                )}
              </section>
            </div>

          </div>
        </div>
      </div>

    </div>
  )
}
"""

with open(file_path, "w") as f:
    f.writelines(lines[:split_index])
    f.write(new_content)

print("SettingsPage.jsx updated for scroll spy layout.")
