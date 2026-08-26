import re
with open('frontend/src/lib/api.js', 'r') as f:
    text = f.read()

func = "  updateAvatar: (avatar) => request('/api/auth/avatar', { method: 'PUT', body: { avatar } }),"
if "updateAvatar: (" not in text:
    text = text.replace("  me: ({ signal } = {}) => request('/api/auth/me', { signal }),", f"  me: ({{ signal }} = {{}}) => request('/api/auth/me', {{ signal }}),\n{func}")
    with open('frontend/src/lib/api.js', 'w') as f:
        f.write(text)
    print("Patched export const api")
