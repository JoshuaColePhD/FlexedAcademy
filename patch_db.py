with open('backend/db.py', 'r') as f:
    text = f.read()

func = """def update_user_avatar(user_id: str, avatar: str) -> None:
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE users SET avatar = %s WHERE id = %s", (avatar, user_id))

"""

if "def update_user_avatar" not in text:
    text = text.replace("def update_user_password", f"{func}def update_user_password")
    with open('backend/db.py', 'w') as f:
        f.write(text)
    print("Added update_user_avatar to db.py")
