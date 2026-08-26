with open("/Users/JoshuaCole/.gemini/antigravity-ide/brain/30349abf-e8b0-4ad7-9c7c-82a4faabf964/task.md", "r") as f:
    content = f.read()

content = content.replace("`[ ]` Update AppShell.jsx layout", "`[/]` Update AppShell.jsx layout")

with open("/Users/JoshuaCole/.gemini/antigravity-ide/brain/30349abf-e8b0-4ad7-9c7c-82a4faabf964/task.md", "w") as f:
    f.write(content)
