import re

with open('backend/routes/auth.py', 'r') as f:
    text = f.read()

# 1. Add avatar to _public_user
public_user_pattern = r'("name": user\["name"\],)'
text = re.sub(public_user_pattern, r'\1\n        "avatar": user.get("avatar"),', text, count=1)

# 2. Add AvatarBody class
if "class AvatarBody" not in text:
    avatar_body = """
class AvatarBody(BaseModel):
    avatar: str = Field(..., max_length=100)
"""
    text = text.replace("class ChangePasswordBody(BaseModel):", f"{avatar_body}\nclass ChangePasswordBody(BaseModel):")

# 3. Add PUT /avatar route
if "@router.put(\"/avatar\")" not in text:
    avatar_route = """
@router.put("/avatar")
def set_avatar(body: AvatarBody, user_id: str = Depends(get_current_user)):
    db.execute("UPDATE users SET avatar = ? WHERE id = ?", (body.avatar, user_id))
    user = db.get_user_by_id(user_id)
    return _public_user(user)

"""
    text = text.replace("@router.get(\"/me\")", f"{avatar_route}@router.get(\"/me\")")

with open('backend/routes/auth.py', 'w') as f:
    f.write(text)
print("Patched auth.py successfully")
