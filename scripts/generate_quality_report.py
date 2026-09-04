"""Run the cheap, reproducible standards quality checks and save a report."""
from __future__ import annotations

import json
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUTPUT = PROJECT_ROOT / "quality_results.json"


def main() -> int:
    checks = [
        ("alabama_ingest", [sys.executable, "scripts/check_alabama_ingest.py", "--grades", "0-12"]),
        ("fast_regression", [sys.executable, "eval/run_all.py", "--fast"]),
    ]
    report = {
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "python": sys.version.split()[0],
        "checks": [],
    }
    failed = False
    for name, command in checks:
        started = time.monotonic()
        proc = subprocess.run(command, cwd=PROJECT_ROOT, text=True, capture_output=True, check=False)
        result = {
            "name": name,
            "command": command,
            "ok": proc.returncode == 0,
            "returncode": proc.returncode,
            "seconds": round(time.monotonic() - started, 2),
            "stdout": proc.stdout[-12000:],
            "stderr": proc.stderr[-4000:],
        }
        report["checks"].append(result)
        failed |= proc.returncode != 0
        print(f"{'PASS' if result['ok'] else 'FAIL'} {name} ({result['seconds']:.1f}s)")

    OUTPUT.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"Report: {OUTPUT}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
