"""The school year, as structured data.

`backend/context/school_calendar.md` already holds the real week map — 43 rows of
`| Wk | Mon | Fri | Notes |` plus a bullet list of closures. Until now nothing
read it: it was pasted verbatim into the model prompt and hoped for. That is why
a plan could be built for Fall Break, and why "the week of Aug 10" was a string
the model invented rather than a date anyone had checked.

This parses that same file, so the prompt and the interface cannot disagree —
there is still exactly one source of truth, it just has a reader now.

Deliberately not a database table. The calendar is authored by hand once a year,
belongs in version control next to the prompt that quotes it, and would be one
more thing to keep in sync if it were duplicated into Postgres.
"""

from __future__ import annotations

import logging
import re
from datetime import date, datetime, timedelta
from functools import lru_cache

from .config import settings

log = logging.getLogger("aplang.schoolcal")

# "| 12 | Oct 19 | Oct 23 | |"
_ROW = re.compile(
    r"^\|\s*(\d{1,2})\s*\|\s*([A-Z][a-z]{2}\s+\d{1,2})\s*\|\s*([A-Z][a-z]{2}\s+\d{1,2})\s*\|(.*)\|\s*$"
)
# "# Florence City Schools — Global Calendar 2026-2027"
_YEARS = re.compile(r"(\d{4})\s*[-–—]\s*(\d{4})")

_MONTHS = {
    "Jan": 1, "Feb": 2, "Mar": 3, "Apr": 4, "May": 5, "Jun": 6,
    "Jul": 7, "Aug": 8, "Sep": 9, "Oct": 10, "Nov": 11, "Dec": 12,
}

# A week is off if its Notes say so. "no school all week" and "Winter break" are
# whole-week closures; "Mon Jan 18 = MLK Day (no school)" is a single day and
# must NOT take the week out — that week is still four teaching days.
_WEEK_OFF = re.compile(r"no school all week|break\s*[—-]\s*no school|winter break", re.I)
_ANY_CLOSURE = re.compile(r"no school", re.I)


def _mk_date(token: str, fall_year: int, spring_year: int) -> date | None:
    """"Oct 19" -> date. Aug–Dec belong to the first year of the span, Jan–Jul to
    the second. The table carries no years, which is fine for a human reading it
    and useless for anything else."""
    try:
        mon_s, day_s = token.split()
        month = _MONTHS[mon_s[:3].title()]
        return date(fall_year if month >= 8 else spring_year, month, int(day_s))
    except (ValueError, KeyError):
        return None


@lru_cache(maxsize=1)
def school_weeks() -> list[dict]:
    """Every numbered week of the year, in order.

    Each: {week, start, end, notes, no_school, closures}
      week       int
      start/end  ISO date strings (Monday and Friday as published)
      no_school  True when the WHOLE week is out
      closures   True when any day in it is out — a plan for such a week has
                 fewer than five teaching days
    """
    path = settings.calendar_path
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        log.warning("school calendar not readable at %s — week board will be empty", path)
        return []

    m = _YEARS.search(text)
    fall_year, spring_year = (int(m.group(1)), int(m.group(2))) if m else (date.today().year,) * 2

    weeks: list[dict] = []
    for line in text.splitlines():
        row = _ROW.match(line.strip())
        if not row:
            continue
        num, mon_tok, fri_tok, notes = row.groups()
        start = _mk_date(mon_tok.strip(), fall_year, spring_year)
        end = _mk_date(fri_tok.strip(), fall_year, spring_year)
        if not start or not end:
            continue
        notes = notes.strip(" |")
        weeks.append(
            {
                "week": int(num),
                "start": start.isoformat(),
                "end": end.isoformat(),
                "notes": notes,
                "no_school": bool(_WEEK_OFF.search(notes)),
                "closures": bool(_ANY_CLOSURE.search(notes)),
            }
        )

    weeks.sort(key=lambda w: w["week"])
    return weeks


def week_for(day: date | None = None) -> dict | None:
    """The week containing `day` — or, if that falls in a gap, the next one to
    start. Returns None once the year is over."""
    day = day or date.today()
    iso = day.isoformat()
    upcoming = None
    for w in school_weeks():
        if w["start"] <= iso <= w["end"]:
            return w
        if w["start"] > iso and upcoming is None:
            upcoming = w
    return upcoming


def label_for(week: dict) -> str:
    """The week_label the rest of the app already speaks — matches the format
    `units.week_number` parses and `plans.week_label` stores."""
    start = date.fromisoformat(week["start"])
    end = date.fromisoformat(week["end"])
    span = (
        f"{start.strftime('%b')} {start.day}-{end.day}"
        if start.month == end.month
        else f"{start.strftime('%b')} {start.day}-{end.strftime('%b')} {end.day}"
    )
    return f"Week {week['week']:02d} — {span}, {end.year}"


def teaching_days(week: dict) -> list[str]:
    """Monday–Friday as ISO dates, minus whole-week closures. Individual
    no-school days stay in the list: the note names them ("Mon Jan 18 = MLK Day")
    but not in a shape worth parsing, and the model is already told to mark a day
    `no_school` when the calendar says so."""
    if week["no_school"]:
        return []
    start = date.fromisoformat(week["start"])
    return [(start + timedelta(days=i)).isoformat() for i in range(5)]
