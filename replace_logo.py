import re

with open("frontend/src/components/AppShell.jsx", "r") as f:
    content = f.read()

# Remove CheckSquare import
content = content.replace("Users, X, Database, CheckSquare } from 'lucide-react'", "Users, X, Database } from 'lucide-react'")

logo_svg = """        <svg viewBox="0 0 64 64" className="w-7 h-7 text-[#7c3aed] drop-shadow-sm" aria-hidden="true">
          <circle cx="32" cy="32" r="29" fill="var(--paper)" />
          <circle cx="32" cy="32" r="30.5" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="1.6 3.4" />
          <circle cx="32" cy="32" r="27" fill="none" stroke="currentColor" strokeWidth="2.5" />
          <path d="M20 33l8 8 16-18" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>"""

target = """        <div className="flex items-center justify-center w-7 h-7 rounded-[9px] bg-accent text-white shadow-[0_2px_10px_rgba(var(--accent-rgb),0.3)]">
          <CheckSquare size={15} strokeWidth={2.5} />
        </div>"""

if target in content:
    content = content.replace(target, logo_svg)
    with open("frontend/src/components/AppShell.jsx", "w") as f:
        f.write(content)
    print("Successfully replaced with custom purple logo")
else:
    print("Could not find target block")

