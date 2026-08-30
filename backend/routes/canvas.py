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
    Preview endpoint for the future Canvas integration.
    The school does not use the Canvas API yet, so this deliberately does not
    mutate a live Canvas course.
    """
    # Simulate a 2.5 second network delay to the future Canvas API
    await asyncio.sleep(2.5)
    
    return {"status": "preview", "message": "Canvas export preview completed; no live course was changed."}
