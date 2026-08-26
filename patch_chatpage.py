with open("frontend/src/pages/ChatPage.jsx", "r") as f:
    content = f.read()

# 1. Update chatPaneWrapRef container
content = content.replace(
    'className="flex min-w-0 flex-col transition-[flex-basis] bg-paper rounded-2xl border border-edge shadow-sm overflow-hidden"',
    'className="flex min-w-0 flex-col transition-[flex-basis] overflow-hidden"'
)

# 2. Update chatPane inner container
content = content.replace(
    '<div className="relative flex h-full min-h-0 flex-col bg-paper/30 backdrop-blur-3xl saturate-[1.2] border border-r-0 border-white/5 shadow-inner shadow-white/5">',
    '<div className="relative flex h-full min-h-0 flex-col">'
)

# 3. Update chat header
content = content.replace(
    '<div className="flex h-11 shrink-0 items-center bg-paper border-b border-edge px-2 z-10">',
    '<div className="flex h-11 shrink-0 items-center px-2 z-10">'
)

# 4. Narrow the width constraint
content = content.replace("voiceOpen ? 'max-w-5xl' : 'max-w-4xl'", "voiceOpen ? 'max-w-4xl' : 'max-w-3xl'")

with open("frontend/src/pages/ChatPage.jsx", "w") as f:
    f.write(content)
print("Updated ChatPage.jsx")
