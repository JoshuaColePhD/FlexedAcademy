import re

with open('backend/routes/plans.py', 'r') as f:
    content = f.read()

route = """
class DayUpdateRequest(BaseModel):
    field: str
    content: str

@router.put("/{plan_id}/days/{day_index}")
def update_day(
    plan_id: str, day_index: int, body: DayUpdateRequest, user_id: str = Depends(get_current_user)
):
    plan = db.get_plan(user_id, plan_id)
    if not plan:
        raise AppError("plan_not_found", "Plan not found", status=404)
    if day_index < 0 or day_index >= len(plan["days"]):
        raise AppError("bad_index", "Invalid day index", status=400)
        
    plan["days"][day_index][body.field] = body.content
    
    # Needs to write back to db
    db.save_plan(user_id, plan_id, plan["days"], plan.get("subject_str", ""), plan.get("week_of", ""))
    return plan
"""

content = content.replace('class QuizUpdateRequest(BaseModel):', route + '\nclass QuizUpdateRequest(BaseModel):')

with open('backend/routes/plans.py', 'w') as f:
    f.write(content)

print("Added update_day route.")
