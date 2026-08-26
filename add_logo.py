import re

with open("frontend/src/components/AppShell.jsx", "r") as f:
    content = f.read()

# Add CheckSquare to imports
content = content.replace("Users, X, Database } from 'lucide-react'", "Users, X, Database, CheckSquare } from 'lucide-react'")

target = """      <div className="flex h-14 shrink-0 items-center gap-2 px-3">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight text-ink">
          FlexEd Academy
        </span>"""

replacement = """      <div className="flex h-14 shrink-0 items-center gap-2.5 px-3">
        <div className="flex items-center justify-center w-7 h-7 rounded-[9px] bg-accent text-white shadow-[0_2px_10px_rgba(var(--accent-rgb),0.3)]">
          <CheckSquare size={15} strokeWidth={2.5} />
        </div>
        <span className="min-w-0 flex-1 truncate text-[15px] font-bold tracking-tight text-ink mt-0.5">
          FlexEd Academy
        </span>"""

if target in content:
    content = content.replace(target, replacement)
    with open("frontend/src/components/AppShell.jsx", "w") as f:
        f.write(content)
    print("Successfully added checkmark logo")
else:
    print("Could not find target block")

