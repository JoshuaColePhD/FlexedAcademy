"""Teacher delivery records and recoverable plan history."""
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from .. import db, teaching
from ..deps import get_current_user

router = APIRouter(prefix='/api/teaching', tags=['teaching'])


class DeliveryBody(BaseModel):
    revision: int = Field(ge=1)
    status: Literal['planned', 'taught', 'assessed', 'skipped']
    notes: str = Field(default='', max_length=2000)
    review_checks: dict[Literal['alignment', 'materials', 'timing'], bool] = Field(default_factory=dict)


class RestoreBody(BaseModel):
    expected_revision: int = Field(ge=1)


@router.get('/plans/{plan_id}')
def get_workflow(plan_id: str, user_id: str = Depends(get_current_user)):
    return teaching.get_workflow(user_id, plan_id)


@router.put('/plans/{plan_id}/days/{day_index}')
def save_delivery(plan_id: str, day_index: int, body: DeliveryBody, user_id: str = Depends(get_current_user)):
    return teaching.save_delivery(user_id, plan_id, day_index, **body.model_dump())


@router.get('/plans/{plan_id}/versions')
def versions(plan_id: str, user_id: str = Depends(get_current_user)):
    return teaching.list_versions(user_id, plan_id)


@router.post('/plans/{plan_id}/versions/{revision}/restore')
def restore(plan_id: str, revision: int, body: RestoreBody, user_id: str = Depends(get_current_user)):
    return teaching.restore_version(user_id, plan_id, revision, body.expected_revision)


@router.get('/plans/{plan_id}/handoff')
def handoff(plan_id: str, user_id: str = Depends(get_current_user)):
    row = teaching.require_plan(user_id, plan_id)
    delivery = db._rows('SELECT day_index, plan_revision, status, notes FROM lesson_delivery WHERE plan_id=? AND user_id=?', (plan_id, user_id))
    return {'prompt': teaching.handoff_prompt(row, delivery), 'week_number': (row.get('week_number') or 0) + 1}
