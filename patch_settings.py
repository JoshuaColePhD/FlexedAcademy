import re

with open('frontend/src/pages/SettingsPage.jsx', 'r') as f:
    text = f.read()

# add imports
imports = """import { AVATAR_OPTIONS } from '../lib/avatars'
"""
text = text.replace("import { AccountMenu } from '../components/AccountMenu'", f"import {{ AccountMenu }} from '../components/AccountMenu'\n{imports}")


avatar_ui = """
function AvatarSelect() {
  const { data: user, refetch } = useQuery({ queryKey: ['me'], queryFn: api.me })
  const [saving, setSaving] = useState(false)
  const toast = useToast()

  const handleSelect = async (avatarId) => {
    if (saving || user?.avatar === avatarId) return
    setSaving(true)
    try {
      await api.updateAvatar(avatarId)
      await refetch()
      toast.success('Avatar updated')
    } catch (err) {
      toast.apiError('Could not update avatar', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mb-8 border-b border-edge pb-8">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-ink">Profile Icon</h3>
        <p className="mt-1 text-xs text-ink-muted">Choose a fun icon to give your profile some personality.</p>
      </div>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => handleSelect(null)}
          className={`flex h-12 w-12 items-center justify-center rounded-full border-2 transition-all hover:scale-110 active:scale-95 ${!user?.avatar ? 'border-[var(--accent)] shadow-md' : 'border-transparent bg-paper-inset text-ink-muted hover:bg-paper-sunken'}`}
          disabled={saving}
          aria-label="Default avatar"
          title="Default"
        >
          <User size={20} />
        </button>
        {AVATAR_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            type="button"
            onClick={() => handleSelect(opt.id)}
            disabled={saving}
            className={`flex h-12 w-12 items-center justify-center rounded-full border-2 transition-all hover:scale-110 active:scale-95 ${opt.bg} ${opt.color} ${user?.avatar === opt.id ? 'border-[var(--accent)] shadow-[0_0_0_2px_var(--paper),0_0_0_4px_var(--accent)]' : 'border-transparent'}`}
            aria-label={opt.label}
            title={opt.label}
          >
            <opt.icon size={20} />
          </button>
        ))}
      </div>
    </div>
  )
}
"""

text = text.replace("function SettingsPage() {", f"{avatar_ui}\nexport default function SettingsPage() {{")
text = text.replace("export default function SettingsPage() {", "function SettingsPage() {", 1) # remove the duplicated export if any

account_section = """              <h2 className="text-xl font-bold text-ink mb-6">Account & Security</h2>
              
              <AvatarSelect />"""

text = text.replace('<h2 className="text-xl font-bold text-ink mb-6">Account & Security</h2>', account_section)

with open('frontend/src/pages/SettingsPage.jsx', 'w') as f:
    f.write(text)
print("Patched SettingsPage.jsx successfully")
