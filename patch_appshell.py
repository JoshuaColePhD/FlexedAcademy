with open("frontend/src/components/AppShell.jsx", "r") as f:
    content = f.read()

# 1. Update root wrapper
content = content.replace(
    'className="app-texture neo-world flex h-app w-full overflow-hidden bg-paper-sunken font-sans text-ink p-2 gap-2"',
    'className="app-texture neo-world flex h-app w-full overflow-hidden bg-paper font-sans text-ink"'
)

# 2. Update sidebar
content = content.replace(
    'className="app-rail flex shrink-0 flex-row overflow-hidden transition-[width] bg-paper rounded-2xl border border-edge shadow-sm"',
    'className="app-rail flex shrink-0 flex-row overflow-hidden transition-[width] border-r border-edge/50"'
)

with open("frontend/src/components/AppShell.jsx", "w") as f:
    f.write(content)
print("Updated AppShell.jsx")
