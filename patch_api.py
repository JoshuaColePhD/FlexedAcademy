import re

with open('frontend/src/lib/api.js', 'r') as f:
    text = f.read()

update_avatar = """
export async function updateAvatar(avatar) {
  const res = await fetch('/api/user/avatar', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ avatar }),
  })
  if (!res.ok) throw await APIError.fromResponse(res)
  return res.json()
}

"""

if "export async function updateAvatar" not in text:
    text = text.replace("export async function forgotPassword", f"{update_avatar}export async function forgotPassword")
    with open('frontend/src/lib/api.js', 'w') as f:
        f.write(text)
    print("Added updateAvatar to api.js")
