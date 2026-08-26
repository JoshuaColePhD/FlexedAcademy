import re

with open('backend/routes/auth.py', 'r') as f:
    text = f.read()

avatar_route = """@router.put("/avatar")
def set_avatar(body: AvatarBody, user_id: str = Depends(get_current_user)):
    db.update_user_avatar(user_id, body.avatar)
    user = db.get_user_by_id(user_id)
    return _public_user(user)

@router.get("/me")"""

text = text.replace("""@router.put("/avatar")
def set_avatar(body: AvatarBody, user_id: str = Depends(get_current_user)):
    db.execute("UPDATE users SET avatar = ? WHERE id = ?", (body.avatar, user_id))
    user = db.get_user_by_id(user_id)
    return _public_user(user)

@router.get("/me")""", avatar_route)

with open('backend/routes/auth.py', 'w') as f:
    f.write(text)
print("Patched auth.py successfully")
