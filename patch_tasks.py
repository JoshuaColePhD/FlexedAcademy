with open('/Users/JoshuaCole/.gemini/antigravity-ide/brain/30349abf-e8b0-4ad7-9c7c-82a4faabf964/task.md', 'r') as f:
    text = f.read()

text = text.replace("- [ ] Update `backend/db.py`", "- [x] Update `backend/db.py`")
text = text.replace("- [ ] Update `backend/routes/auth.py`", "- [x] Update `backend/routes/auth.py`")
text = text.replace("- [ ] Update `frontend/src/lib/api.js`", "- [x] Update `frontend/src/lib/api.js`")

with open('/Users/JoshuaCole/.gemini/antigravity-ide/brain/30349abf-e8b0-4ad7-9c7c-82a4faabf964/task.md', 'w') as f:
    f.write(text)
