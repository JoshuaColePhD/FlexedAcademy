"""Export privacy-minimized teacher feedback for retrieval evaluation review."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from backend import db


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=500)
    parser.add_argument(
        "--output",
        type=Path,
        default=PROJECT_ROOT / "quality_feedback_cases.json",
    )
    args = parser.parse_args()

    db.connect()
    rows = db.list_plan_feedback_for_quality(args.limit)
    cases = []
    for row in rows:
        context = row.get("context_json") or {}
        if isinstance(context, str):
            context = json.loads(context)
        cases.append(
            {
                "feedback_id": row["id"],
                "plan_id": row["plan_id"],
                "is_good": bool(row["is_good"]),
                "reason": row.get("reason"),
                "notes": row.get("notes"),
                "course": context.get("course"),
                "week_label": context.get("week_label"),
                "retrieved_ids": context.get("retrieved_ids", []),
                "warnings": context.get("warnings", []),
                "created_at": row.get("created_at"),
            }
        )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(cases, indent=2, default=str) + "\n", encoding="utf-8")
    print(f"Exported {len(cases)} feedback cases to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
