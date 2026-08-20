from backend import db
import json

res = db._row("SELECT * FROM settings LIMIT 1")
print(json.dumps(res, default=str))
