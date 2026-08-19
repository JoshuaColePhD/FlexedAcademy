import re

with open('backend/routes/plans.py', 'r') as f:
    content = f.read()

content = content.replace(
    'db.save_plan(user_id, plan_id, plan["days"], plan.get("subject_str", ""), plan.get("week_of", ""))',
    'db.update_plan(user_id, plan_id, days=plan["days"])'
)

with open('backend/routes/plans.py', 'w') as f:
    f.write(content)

print("Fixed update_day route.")
