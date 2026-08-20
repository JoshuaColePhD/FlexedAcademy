from backend import db
from backend.routes.classes import update_class_route, ClassPatch
import json

def test():
    classes = db._rows("SELECT * FROM classes LIMIT 1")
    if not classes:
        print("No classes")
        return
    c = classes[0]
    print("Old class:", c["name"])
    
    # Patch the class subject/grade
    patch = ClassPatch(subject="AP_Physics_2", grade="12")
    res = update_class_route(class_id=c["id"], body=patch, user_id=c["user_id"])
    print("New class:", res["name"])
    
    # Restore
    patch2 = ClassPatch(subject=c["subject"], grade=c["grade"])
    res2 = update_class_route(class_id=c["id"], body=patch2, user_id=c["user_id"])
    print("Restored:", res2["name"])

test()
