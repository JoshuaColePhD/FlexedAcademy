#!/usr/bin/env python3
"""Refresh the FlexEd Academy current-work snapshot in the Obsidian vault.

This intentionally exports only project memory and Git status. It does not copy
source code, secrets, databases, node_modules, or generated binaries into the
vault.
"""

from __future__ import annotations

import os
import subprocess
from datetime import date
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
DEFAULT_VAULT = Path(
    "/Users/JoshuaCole/My Drive/Iris_OS/Obsidian/JoshuaColePhD"
)
VAULT = Path(os.environ.get("FLEXED_OBSIDIAN_ROOT", DEFAULT_VAULT))
OUT = VAULT / "Knowledge/FlexEd Academy/Current Work.md"


def git(*args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=REPO,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def main() -> None:
    branch_status = git("status", "--short", "--branch")
    head = git("log", "-1", "--format=%h %ad — %s", "--date=short")
    recent = git(
        "log",
        "-12",
        "--format=%h|%ad|%s",
        "--date=short",
    )

    changed = [
        line[3:].strip()
        for line in branch_status.splitlines()
        if len(line) > 3 and line[:2] != "##"
    ]
    changed_list = "\n".join(f"- `{path}`" for path in changed) or "- Clean working tree"
    commit_list = "\n".join(
        f"- `{sha}` — {commit_date} — {subject}"
        for sha, commit_date, subject in (
            line.split("|", 2) for line in recent.splitlines() if line
        )
    )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        f"""---
title: \"FlexEd Academy — Current Work\"
type: current-work
project: flexed-academy
generated: true
updated: {date.today().isoformat()}
repository: \"{REPO}\"
---

# FlexEd Academy — Current Work

> [!info] Generated snapshot
> Refresh this note from the repository with `./venv/bin/python scripts/sync_obsidian_flexed.py`. The script exports Git status and history only; the repository remains the source of truth.

## Repository state

```text
{branch_status}
```

**HEAD:** `{head}`

### Uncommitted files

{changed_list}

## Recent work

{commit_list}

## Related project notes

- [[FlexEd Academy Dashboard]]
- [[Repository Artifact Register]]
- [[FlexEd Outputs Index]]
- [[Traceability Map]]
- [[FlexEd Academy Decision Log]]

## Review habit

Read this note before a planning session or release review. If a change affects product truth, architecture, safety, or operations, update the relevant note and [[FlexEd Academy Decision Log]] after the code is settled.
""",
        encoding="utf-8",
    )
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
