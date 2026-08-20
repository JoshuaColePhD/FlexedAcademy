from backend import db
import json

res = db._rows("SELECT * FROM classes")
print(json.dumps(res, default=str))
