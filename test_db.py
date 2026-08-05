import sys
sys.path.insert(0, ".")
from backend import db
print(db.list_chats("default_user"))
