#!/usr/bin/env python3
"""Frontend chatToolRecovery: a well-formed tool call is preferred over JSON-as-text."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

FRONTEND = Path(__file__).resolve().parent.parent / "frontend"
SCRIPT = FRONTEND / "scripts" / "test-chat-tool-recovery.mjs"


def main() -> int:
    result = subprocess.run(["node", str(SCRIPT)], cwd=FRONTEND, capture_output=True, text=True)
    if result.returncode != 0:
        sys.stderr.write(result.stdout + result.stderr)
        print("FAILED — tool-call preference for clarifying JSON recovery")
        return 1
    print("PASSED — well-formed tool calls are preferred over JSON dumped as text.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
