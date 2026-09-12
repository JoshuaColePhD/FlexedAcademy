"""Gates that reuse the teacher's existing Settings beta-features opt-in.

Quizzes stay in the repo; they are offered, created, revised, and shown only
when `users.beta_features` is true (Settings → Enable Beta Features).
"""

from . import db
from .errors import AppError

QUIZ_BETA_DISABLED = (
    "Quizzes are a beta feature. Turn on Enable Beta Features in Settings to use them."
)


def beta_features_for(user_id: str) -> bool:
    user = db.get_user_by_id(user_id)
    return bool(user and user.get("beta_features"))


def require_quiz_beta(user_id: str) -> None:
    if not beta_features_for(user_id):
        raise AppError("quizzes_disabled", QUIZ_BETA_DISABLED, status=403)
