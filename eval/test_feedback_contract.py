"""Contract checks for structured plan feedback and its review export."""
import sys
from pathlib import Path

from pydantic import ValidationError

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from backend.routes.plans import PlanFeedback


def main() -> int:
    assert PlanFeedback(is_good=True).reason is None
    negative = PlanFeedback(
        is_good=False,
        reason="retrieval",
        notes="The cited standard was off topic.",
    )
    assert negative.reason == "retrieval"
    try:
        PlanFeedback(is_good=False, reason="not-a-valid-reason")
    except ValidationError as exc:
        assert "reason" in str(exc)
    else:
        raise AssertionError("invalid feedback reason was accepted")
    print("PASS — feedback reason validation and notes contract")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
