import re
with open('frontend/src/components/AccountMenu.jsx', 'r') as f:
    text = f.read()

imports = "import { getAvatar } from '../lib/avatars'"
text = text.replace("import { BookOpen, ChevronUp, Info, LogOut, Settings, ShieldCheck, User } from 'lucide-react'", f"import {{ BookOpen, ChevronUp, Info, LogOut, Settings, ShieldCheck, User }} from 'lucide-react'\n{imports}")

avatar_render = """        {(() => {
          const avatar = getAvatar(user?.avatar)
          if (avatar) {
            return (
              <span
                aria-hidden="true"
                className={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${avatar.bg} ${avatar.color} border border-edge/30`}
              >
                <avatar.icon size={15} />
              </span>
            )
          }
          return (
            <span
              aria-hidden="true"
              className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-paper-inset text-ink-muted border border-edge/30"
            >
              <User size={15} />
            </span>
          )
        })()}"""

text = text.replace("""        <span
          aria-hidden="true"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-paper-inset text-ink-muted border border-edge/30"
        >
          <User size={15} />
        </span>""", avatar_render)

with open('frontend/src/components/AccountMenu.jsx', 'w') as f:
    f.write(text)
print("Patched AccountMenu successfully")
