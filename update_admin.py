import sys

file_path = "frontend/src/pages/AdminPage.jsx"
with open(file_path, "r") as f:
    content = f.read()

# We need to replace `export function AdminPage()` and `export function AdminBody()`
# with the new layout.

split_str = "export function AdminPage() {"
before, after = content.split(split_str, 1)

new_code = """export function AdminPage() {
  useDocumentTitle('Accounts')
  const toast = useToast()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const navigate = useNavigate()

  const [activeTab, setActiveTab] = useState('overview')
  const scrollContainerRef = React.useRef(null)

  // -- Data fetching for Accounts --
  const [pending, setPending] = useState(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [sort, setSort] = useState({ key: 'joined', dir: 'desc' })
  const [selected, setSelected] = useState(() => new Set())
  const [bulkCap, setBulkCap] = useState('')
  const [bulkBusy, setBulkBusy] = useState(false)

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['admin', 'accounts'],
    queryFn: () => api.adminListAccounts(),
  })
  const accounts = data?.accounts ?? []

  const onSort = (key) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
  }

  const q = search.trim().toLowerCase()
  const filtered = accounts
    .filter((a) => (q ? a.name?.toLowerCase().includes(q) || a.email?.toLowerCase().includes(q) : true))
    .filter((a) => (statusFilter === 'all' ? true : tier(a) === statusFilter))
  const accessor = SORT_ACCESSORS[sort.key] || SORT_ACCESSORS.joined
  const sorted = [...filtered].sort((a, b) => {
    const av = accessor(a)
    const bv = accessor(b)
    const cmp = av < bv ? -1 : av > bv ? 1 : 0
    return sort.dir === 'asc' ? cmp : -cmp
  })

  const toggleSelect = (id) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const allVisibleSelected = sorted.length > 0 && sorted.every((a) => selected.has(a.id))
  const toggleSelectAllVisible = () => {
    setSelected((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev)
        sorted.forEach((a) => next.delete(a.id))
        return next
      }
      const next = new Set(prev)
      sorted.forEach((a) => next.add(a.id))
      return next
    })
  }
  const clearSelection = () => setSelected(new Set())

  const toggleComp = async (account) => {
    const nextComped = account.subscription_status !== 'comped'
    const ok = await confirm({
      title: nextComped ? `Grant ${account.email} unlimited access?` : `Revoke ${account.email}'s unlimited access?`,
      body: nextComped
        ? 'They will never hit the free-week limit until this is revoked.'
        : 'They will fall back to the ordinary one-week-free limit.',
      confirmLabel: nextComped ? 'Grant' : 'Revoke',
      tone: nextComped ? 'default' : 'danger',
    })
    if (!ok) return
    setPending(account.id)
    try {
      await api.adminSetComped(account.id, nextComped)
      await qc.invalidateQueries({ queryKey: ['admin', 'accounts'] })
      toast.success(
        nextComped ? `${account.email} now has unlimited access` : `${account.email} back to the ordinary free week`
      )
    } catch (err) {
      toast.apiError("Couldn't update that account", err)
    } finally {
      setPending(null)
    }
  }

  const bulkComp = async (comped) => {
    const ids = [...selected]
    if (!ids.length) return
    const ok = await confirm({
      title: comped
        ? `Grant unlimited access to ${ids.length} account${ids.length === 1 ? '' : 's'}?`
        : `Revoke unlimited access from ${ids.length} account${ids.length === 1 ? '' : 's'}?`,
      body: comped
        ? 'None of them will hit the free-week limit until this is revoked.'
        : 'They will all fall back to the ordinary one-week-free limit.',
      confirmLabel: comped ? 'Grant' : 'Revoke',
      tone: comped ? 'default' : 'danger',
    })
    if (!ok) return
    setBulkBusy(true)
    try {
      const results = await Promise.allSettled(ids.map((id) => api.adminSetComped(id, comped)))
      const failed = results.filter((r) => r.status === 'rejected').length
      await qc.invalidateQueries({ queryKey: ['admin', 'accounts'] })
      if (failed) {
        toast.error(`${ids.length - failed} of ${ids.length} updated — ${failed} failed`)
      } else {
        toast.success(`${ids.length} account${ids.length === 1 ? '' : 's'} updated`)
      }
      clearSelection()
    } finally {
      setBulkBusy(false)
    }
  }

  const bulkSetCap = async () => {
    const ids = [...selected]
    if (!ids.length) return
    const cap = bulkCap === '' ? null : Math.max(0, parseInt(bulkCap, 10) || 0)
    const ok = await confirm({
      title:
        cap == null
          ? `Clear the custom cap on ${ids.length} account${ids.length === 1 ? '' : 's'}?`
          : `Cap ${ids.length} account${ids.length === 1 ? '' : 's'} at ${cap.toLocaleString()} tokens/week?`,
      body:
        cap == null
          ? 'Each falls back to its ordinary tier default.'
          : 'Overrides each account’s tier default until cleared, in either direction.',
      confirmLabel: cap == null ? 'Clear' : 'Set cap',
    })
    if (!ok) return
    setBulkBusy(true)
    try {
      const results = await Promise.allSettled(ids.map((id) => api.adminSetCustomCap(id, cap)))
      const failed = results.filter((r) => r.status === 'rejected').length
      await qc.invalidateQueries({ queryKey: ['admin', 'accounts'] })
      if (failed) {
        toast.error(`${ids.length - failed} of ${ids.length} updated — ${failed} failed`)
      } else {
        toast.success(`${ids.length} account${ids.length === 1 ? '' : 's'} updated`)
      }
      clearSelection()
      setBulkCap('')
    } finally {
      setBulkBusy(false)
    }
  }

  // -- Scroll Spy Logic --
  const tabs = React.useMemo(() => [
    { id: 'overview', label: 'Overview' },
    { id: 'users', label: 'User Management' },
    { id: 'standards', label: 'Standards Check' },
    { id: 'schools', label: 'Schools' },
  ], [])

  React.useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
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
  }, [tabs])

  const scrollToSection = (id) => {
    setActiveTab(id)
    const el = document.getElementById(`section-${id}`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' })
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-paper">
      
      {/* Left Sidebar */}
      <div className="flex w-64 shrink-0 flex-col border-r border-edge bg-paper-sunken">
        <header className="flex h-14 shrink-0 items-center gap-2 px-4">
          <Link
            to="/"
            aria-label="Back"
            className="rounded-md p-1.5 text-ink-muted transition-colors hover:bg-paper-inset hover:text-ink"
          >
            <ArrowLeft size={16} aria-hidden="true" />
          </Link>
          <div className="flex items-center gap-1.5">
            <ShieldCheck size={16} aria-hidden="true" className="text-ink-muted" />
            <h1 className="text-sm font-semibold text-ink">Admin</h1>
          </div>
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

      {/* Right Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="flex h-14 shrink-0 items-center border-b border-edge bg-paper/80 px-8 backdrop-blur-sm z-10">
          <div className="text-sm font-medium text-ink-muted">
            {tabs.find(t => t.id === activeTab)?.label}
          </div>
        </header>

        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-8 py-8 scroll-smooth">
          <div className="mx-auto w-full max-w-6xl flex flex-col gap-16 pb-32">
            
            {/* Overview Section */}
            <div id="section-overview" className="scroll-mt-8">
              <h2 className="text-xl font-bold text-ink mb-6">Overview</h2>
              {isLoading ? (
                <p className="text-sm text-ink-muted">Loading…</p>
              ) : isError ? (
                <p className="text-sm text-mark">{error?.message || 'Could not load accounts.'}</p>
              ) : (
                <>
                  <StatsCards accounts={accounts} />
                  <UsageTrendChart />
                </>
              )}
            </div>

            {/* Users Section */}
            <div id="section-users" className="scroll-mt-8">
              <h2 className="text-xl font-bold text-ink mb-6">User Management</h2>
              {isLoading ? (
                <p className="text-sm text-ink-muted">Loading…</p>
              ) : isError ? (
                <p className="text-sm text-mark">Could not load users.</p>
              ) : (
                <>
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap gap-1.5">
                      {STATUS_FILTERS.map((f) => (
                        <button
                          key={f.key}
                          type="button"
                          onClick={() => setStatusFilter(f.key)}
                          aria-pressed={statusFilter === f.key}
                          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                            statusFilter === f.key ? 'bg-accent text-ink-inverse' : 'bg-paper-inset text-ink-muted hover:text-ink'
                          }`}
                        >
                          {f.label}
                        </button>
                      ))}
                    </div>
                    {accounts.length ? (
                      <div className="relative w-full max-w-56">
                        <Search
                          size={14}
                          aria-hidden="true"
                          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint"
                        />
                        <input
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                          placeholder="Find an account…"
                          aria-label="Search accounts by name or email"
                          className="w-full rounded-lg border border-edge bg-paper py-1.5 pl-8 pr-7 text-sm text-ink outline-none focus:border-accent"
                        />
                        {search ? (
                          <button
                            type="button"
                            onClick={() => setSearch('')}
                            aria-label="Clear search"
                            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-ink-faint hover:text-ink"
                          >
                            <X size={13} aria-hidden="true" />
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  {selected.size > 0 ? (
                    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-accent/30 bg-accent-tint px-3 py-2">
                      <span className="text-xs font-medium text-accent-text">
                        {selected.size} selected
                      </span>
                      <button type="button" className="btn text-xs" disabled={bulkBusy} onClick={() => bulkComp(true)}>
                        Grant unlimited
                      </button>
                      <button type="button" className="btn text-xs" disabled={bulkBusy} onClick={() => bulkComp(false)}>
                        Revoke unlimited
                      </button>
                      <div className="flex items-center gap-1.5">
                        <input
                          type="number"
                          min={0}
                          step={1000}
                          value={bulkCap}
                          onChange={(e) => setBulkCap(e.target.value)}
                          placeholder="tier default"
                          aria-label="Custom weekly token cap for selected accounts"
                          className="w-28 rounded-md border border-edge bg-paper px-2 py-1 text-xs text-ink outline-none focus:border-accent"
                        />
                        <button type="button" className="btn text-xs" disabled={bulkBusy} onClick={bulkSetCap}>
                          Set cap
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={clearSelection}
                        className="ml-auto text-xs text-ink-muted underline-offset-2 hover:text-ink hover:underline"
                      >
                        Clear
                      </button>
                    </div>
                  ) : null}

                  {sorted.length === 0 && (search || statusFilter !== 'all') ? (
                    <p className="text-sm text-ink-muted">No account matches.</p>
                  ) : (
                    <>
                      <div className="hidden lg:block">
                        <div className="neo-world neo-panel overflow-x-auto rounded-xl">
                          <table className="w-full text-sm whitespace-nowrap">
                            <thead>
                              <tr className="border-b border-edge bg-paper-sunken text-left text-2xs uppercase tracking-wide text-ink-muted">
                                <th className="w-8 px-3 py-2">
                                  <input
                                    type="checkbox"
                                    checked={allVisibleSelected}
                                    onChange={toggleSelectAllVisible}
                                    aria-label="Select every visible account"
                                  />
                                </th>
                                <SortHeader label="Account" sortKey="name" sort={sort} onSort={onSort} />
                                <SortHeader label="Status" sortKey="status" sort={sort} onSort={onSort} />
                                <th className="px-3 py-2 font-medium">Cap status</th>
                                <SortHeader label="Plans built" sortKey="plans_built" sort={sort} onSort={onSort} />
                                <SortHeader label="Tokens 7d" sortKey="tokens_7d" sort={sort} onSort={onSort} />
                                <th className="px-3 py-2 font-medium">Est. cost 7d</th>
                                <SortHeader label="Avg/day (30d)" sortKey="avg_day" sort={sort} onSort={onSort} />
                                <SortHeader label="Last active" sortKey="last_active" sort={sort} onSort={onSort} />
                                <SortHeader label="Joined" sortKey="joined" sort={sort} onSort={onSort} />
                                <th className="px-3 py-2 font-medium">Custom cap</th>
                                <th className="px-3 py-2 font-medium" />
                              </tr>
                            </thead>
                            <tbody>
                              {sorted.map((a) => (
                                <tr key={a.id} className="border-b border-edge last:border-0">
                                  <td className="px-3 py-2">
                                    <input
                                      type="checkbox"
                                      checked={selected.has(a.id)}
                                      onChange={() => toggleSelect(a.id)}
                                      aria-label={`Select ${a.email}`}
                                    />
                                  </td>
                                  <td className="px-3 py-2">
                                    <div className="font-medium text-ink">{a.name}</div>
                                    <div className="text-2xs text-ink-muted">
                                      {a.email}
                                      {a.is_admin ? ' · admin' : ''}
                                    </div>
                                  </td>
                                  <td className="px-3 py-2">
                                    <StatusPill status={a.subscription_status} />
                                  </td>
                                  <td className="px-3 py-2">
                                    <CapStatusBadge account={a} />
                                  </td>
                                  <td className="px-3 py-2 font-mono text-ink-soft">{a.plans_built}</td>
                                  <td className="px-3 py-2 font-mono text-ink-soft">{(a.tokens_7d || 0).toLocaleString()}</td>
                                  <td className="px-3 py-2 font-mono text-ink-soft">{estCost(a.tokens_7d || 0)}</td>
                                  <td className="px-3 py-2 font-mono text-ink-soft">{(a.tokens_avg_day_30d || 0).toLocaleString()}</td>
                                  <td className="px-3 py-2 text-ink-soft">{relative(a.last_plan_at)}</td>
                                  <td className="px-3 py-2 text-ink-soft">{relative(a.created_at)}</td>
                                  <td className="px-3 py-2">
                                    <CustomCapEditor account={a} />
                                  </td>
                                  <td className="px-3 py-2 text-right">
                                    <button
                                      type="button"
                                      className="btn text-xs"
                                      disabled={pending === a.id}
                                      onClick={() => toggleComp(a)}
                                    >
                                      {a.subscription_status === 'comped' ? 'Revoke unlimited' : 'Grant unlimited'}
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>

                      <ul className="flex flex-col gap-3 lg:hidden">
                        {sorted.map((a) => (
                          <li key={a.id} className="neo-world neo-panel rounded-xl p-3">
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex min-w-0 items-start gap-2">
                                <input
                                  type="checkbox"
                                  checked={selected.has(a.id)}
                                  onChange={() => toggleSelect(a.id)}
                                  aria-label={`Select ${a.email}`}
                                  className="mt-1 shrink-0"
                                />
                                <div className="min-w-0">
                                  <div className="truncate font-medium text-ink">{a.name}</div>
                                  <div className="truncate text-2xs text-ink-muted">
                                    {a.email}
                                    {a.is_admin ? ' · admin' : ''}
                                  </div>
                                </div>
                              </div>
                              <div className="flex shrink-0 flex-col items-end gap-1">
                                <StatusPill status={a.subscription_status} />
                                <CapStatusBadge account={a} />
                              </div>
                            </div>
                            <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                              <dt className="text-ink-muted">Plans built</dt>
                              <dd className="text-right font-mono text-ink-soft">{a.plans_built}</dd>
                              <dt className="text-ink-muted">Tokens 7d</dt>
                              <dd className="text-right font-mono text-ink-soft">{(a.tokens_7d || 0).toLocaleString()}</dd>
                              <dt className="text-ink-muted">Est. cost 7d</dt>
                              <dd className="text-right font-mono text-ink-soft">{estCost(a.tokens_7d || 0)}</dd>
                              <dt className="text-ink-muted">Avg/day (30d)</dt>
                              <dd className="text-right font-mono text-ink-soft">{(a.tokens_avg_day_30d || 0).toLocaleString()}</dd>
                              <dt className="text-ink-muted">Last active</dt>
                              <dd className="text-right text-ink-soft">{relative(a.last_plan_at)}</dd>
                              <dt className="text-ink-muted">Joined</dt>
                              <dd className="text-right text-ink-soft">{relative(a.created_at)}</dd>
                            </dl>
                            <div className="mt-3 flex flex-col gap-2 border-t border-edge pt-3">
                              <label className="text-2xs font-medium uppercase tracking-wider text-ink-muted">
                                Custom weekly cap
                              </label>
                              <CustomCapEditor account={a} />
                              <button
                                type="button"
                                className="btn w-full text-xs"
                                disabled={pending === a.id}
                                onClick={() => toggleComp(a)}
                              >
                                {a.subscription_status === 'comped' ? 'Revoke unlimited' : 'Grant unlimited'}
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}

                  <p className="mt-4 text-2xs text-ink-muted">
                    "Grant unlimited" sets the account to comped — the same status your own account has. It bypasses
                    the free-week limit entirely and never expires on its own; use "Revoke unlimited" to put an
                    account back on the ordinary free week. A custom cap is a middle ground — it overrides the tier
                    default for that one account only, in either direction, until cleared.
                  </p>
                </>
              )}
            </div>

            {/* Standards Section */}
            <div id="section-standards" className="scroll-mt-8">
              <h2 className="text-xl font-bold text-ink mb-6">Standards Check</h2>
              <StandardsCheckSection />
            </div>

            {/* Schools Section */}
            <div id="section-schools" className="scroll-mt-8">
              <h2 className="text-xl font-bold text-ink mb-6">Schools & Calendars</h2>
              <SchoolsAdmin />
            </div>

          </div>
        </div>
      </div>
    </div>
  )
}
"""

# I also need to add React import if it's missing or use it correctly
import_line = "import React, { useEffect, useMemo, useState } from 'react'"
if "import React" not in before:
    before = before.replace("import { useEffect, useMemo, useState } from 'react'", import_line)
    before = before.replace("import { useNavigate } from 'react-router-dom'", "import { Link, useNavigate } from 'react-router-dom'")

with open(file_path, "w") as f:
    f.write(before)
    f.write(new_code)

print("Updated AdminPage.jsx to use master-detail layout.")
