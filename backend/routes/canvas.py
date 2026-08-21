import asyncio

from fastapi import APIRouter, Depends

from ..deps import get_current_user

router = APIRouter(prefix="/api/canvas", tags=["canvas"])

@router.post("/export_quiz")
async def export_quiz(
    plan_id: str,
    quiz_id: str,
    user_id: str = Depends(get_current_user)
):
    """
    Mock endpoint for pushing a quiz to Canvas.
    Since the school doesn't use the Canvas API yet, this simulates a successful API call.
    """
    # Simulate a 2.5 second network delay to Canvas API
    await asyncio.sleep(2.5)
    
    return {"status": "success", "message": "Quiz successfully synced to Canvas!"}
