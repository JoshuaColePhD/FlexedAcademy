import sys

file_path = "frontend/src/pages/ClassPage.jsx"
with open(file_path, "r") as f:
    content = f.read()

# 1. Update the 'list' to filter out archived classes
content = content.replace(
    "const list = classes || []",
    "const list = (classes || []).filter(c => !c.archived)"
)

# 2. Add GlobalClassDashboard before export function ClassPage
global_dashboard_code = """
function GlobalClassDashboard({ classes, onUpdated }) {
  const toast = useToast()
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [archiving, setArchiving] = useState(false)
  const [showArchived, setShowArchived] = useState(false)

  const activeClasses = classes.filter((c) => !c.archived)
  const archivedClasses = classes.filter((c) => c.archived)
  
  const displayedClasses = showArchived ? archivedClasses : activeClasses

  const toggleSelectAll = () => {
    if (selectedIds.size === displayedClasses.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(displayedClasses.map((c) => c.id)))
    }
  }

  const toggleSelect = (id) => {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelectedIds(next)
  }

  const batchUpdate = async (isArchived) => {
    if (!selectedIds.size) return
    setArchiving(true)
    try {
      await Promise.all(
        Array.from(selectedIds).map((id) => api.updateClass(id, { archived: isArchived }))
      )
      toast.success(isArchived ? 'Classes archived' : 'Classes restored')
      setSelectedIds(new Set())
      onUpdated?.()
    } catch (err) {
      toast.apiError('Could not update classes', err)
    } finally {
      setArchiving(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl pb-16">
      <div className="mb-8 flex items-center justify-between border-b border-edge pb-4">
        <div>
          <h2 className="text-lg font-semibold text-ink">Class Management</h2>
          <p className="text-sm text-ink-muted">Batch archive older classes to keep your sidebar clean.</p>
        </div>
        <button
          type="button"
          onClick={() => {
             setShowArchived(!showArchived)
             setSelectedIds(new Set())
          }}
          className="text-sm font-medium text-accent hover:underline"
        >
          {showArchived ? 'View Active Classes' : `View Archived (${archivedClasses.length})`}
        </button>
      </div>

      <div className="neo-panel rounded-xl bg-paper">
        <div className="flex items-center justify-between rounded-t-xl border-b border-edge bg-paper-sunken px-4 py-3">
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={displayedClasses.length > 0 && selectedIds.size === displayedClasses.length}
              onChange={toggleSelectAll}
              className="h-4 w-4 rounded border-edge text-accent focus:ring-accent"
            />
            <span className="text-sm font-medium text-ink-muted">
              {selectedIds.size} selected
            </span>
          </div>
          {selectedIds.size > 0 && (
            <button
              type="button"
              disabled={archiving}
              onClick={() => batchUpdate(!showArchived)}
              className="neo-raised flex items-center gap-1.5 rounded-lg bg-paper-inset px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-edge disabled:opacity-50"
            >
              {archiving ? <Loader2 size={14} className="animate-spin" /> : showArchived ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
              {showArchived ? 'Restore Selected' : 'Archive Selected'}
            </button>
          )}
        </div>

        <ul className="divide-y divide-edge">
          {displayedClasses.length === 0 ? (
            <li className="px-4 py-8 text-center text-sm text-ink-muted">
              {showArchived ? 'No archived classes.' : 'No active classes.'}
            </li>
          ) : (
            displayedClasses.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-paper-inset">
                <input
                  type="checkbox"
                  checked={selectedIds.has(c.id)}
                  onChange={() => toggleSelect(c.id)}
                  className="h-4 w-4 rounded border-edge text-accent focus:ring-accent"
                />
                <div>
                  <p className="text-sm font-medium text-ink">{c.name}</p>
                  <p className="text-xs text-ink-muted">{c.subject} · Grade {c.grade}</p>
                </div>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  )
}

/* ── Your classes layout (Master-Detail) ──────────────────────────────────── */
"""

content = content.replace(
    "/* ── Your classes layout (Master-Detail) ──────────────────────────────────── */",
    global_dashboard_code
)

# 3. Replace the empty state with the new component
empty_state = """<div className="flex h-full flex-col items-center justify-center text-ink-muted">
              <p className="text-sm">Select a class from the sidebar to manage its settings.</p>
            </div>"""

new_empty_state = "<GlobalClassDashboard classes={classes} onUpdated={reloadClasses} />"

content = content.replace(empty_state, new_empty_state)

with open(file_path, "w") as f:
    f.write(content)

print("Updated ClassPage.jsx with GlobalClassDashboard successfully.")
