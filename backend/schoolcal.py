"""The school year, as structured data — one calendar per school.

`backend/context/calendars/<school_id>.md` holds one school's real week map —
rows of `| Wk | Mon | Fri | Notes |` plus a bullet list of closures. Every
function here takes the `school_id` to read as its first argument, resolved
by the caller (generally db.get_user_school) — never guessed inside this
module, and never defaulted, so a caller that forgot to resolve one gets a
loud TypeError here rather than a lesson plan silently built against the
wrong district's calendar.

Deliberately not a database table. Each calendar is authored by hand once a
year, belongs in version control next to the prompt that quotes it, and would
be one more thing to keep in sync if it were duplicated into Postgres. The
`schools` table (db.py) holds only the curated list of which ids exist and
their display names — never the calendar content itself.
"""

from __future__ import annotations

import logging
import re
from datetime import UTC, date, datetime, timedelta
from functools import cache

from .config import settings

log = logging.getLogger("flexedacademy.schoolcal")

# The school id a teacher lands on when their real school isn't set up yet
# (frontend/src/pages/onboarding/WelcomePage.jsx's own picker) — no calendar
# file exists for it on purpose. Every function below that reads a real
# calendar's dates branches around this id instead, returning week NUMBERS
# with no date attached to any of them, rather than either an empty "no
# calendar" state (which used to block picking a week at all) or a
# fabricated date range that would silently claim to be this teacher's
# actual school year.
NO_CALENDAR_SCHOOL_ID = "generic"
# Long enough to cover a real school year (43 in the one real calendar on
# file today) without needing a real end date to know when to stop.
_NO_CALENDAR_WEEK_COUNT = 43


def _synthetic_weeks() -> list[dict]:
    """Week numbers only, no calendar behind them — see
    NO_CALENDAR_SCHOOL_ID's own comment. `start`/`end` are None throughout;
    every reader of a week dict in this module and in db.py's week_board
    checks for that before doing date arithmetic, rather than this function
    inventing dates nothing backs."""
    return [
        {
            "week": n,
            "start": None,
            "end": None,
            "notes": "",
            "no_school": False,
            "closures": False,
        }
        for n in range(1, _NO_CALENDAR_WEEK_COUNT + 1)
    ]

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
_WEEK_OFF = re.compile(r"no school all week|break\s*[—-]\s*no school|winter break", re.IGNORECASE)
_ANY_CLOSURE = re.compile(r"no school", re.IGNORECASE)

_DOW = ("Mon", "Tue", "Wed", "Thu", "Fri")

_MONTH_ALT = "|".join(_MONTHS)

# "Oct 8–9", "Nov 23–27", "Mar 22–26", "Nov 11", and the cross-month "Dec 21–Jan 1".
# Used on both the bullet list at the top of the file and the per-week Notes; the
# two are redundant on purpose, and the redundancy is the point — a date has to be
# missing from BOTH to fall through.
_SPAN = re.compile(
    rf"(?P<m1>{_MONTH_ALT})\s+(?P<d1>\d{{1,2}})"
    rf"(?:\s*[-–—]\s*(?:(?P<m2>{_MONTH_ALT})\s+)?(?P<d2>\d{{1,2}}))?",
    re.IGNORECASE,
)

# Bullets that name a boundary rather than a closure. "Last day May 27" is when
# the year ENDS, not a day off — treating it as one would close the final week.
_NOT_A_CLOSURE = re.compile(r"last day|first day|school starts|return from", re.IGNORECASE)

# The human name of a closure, when the note bothers to give one:
#   "Mon Sep 7 = Labor Day (no school)"  ->  "Labor Day"
_NAMED = re.compile(r"=\s*([^(;]+)")


# "Thu–Fri Oct 8–9 may be no school" leads with the weekday, not a holiday name.
# Without this the calendar cell would read "Thu–Fri", which is both wrong and
# already obvious from the column the cell is sitting in.
_LEADING_DOW = re.compile(
    r"^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*\s*[-–—]?\s*)+", re.IGNORECASE
)


def _reason(segment: str) -> str:
    """A label worth showing in a calendar cell. Falls back to the generic rather
    than inventing one — an unnamed closure is still a closure."""
    named = _NAMED.search(segment)
    if named:
        return named.group(1).strip(" .")
    # Bullet-list form: the label is whatever precedes the first date token.
    head = _SPAN.split(segment)[0].strip(" -–—.;")
    return _LEADING_DOW.sub("", head).strip(" -–—.;") or "No school"


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


@cache
def _read(school_id: str) -> tuple[str, int, int]:
    """One school's calendar file plus the two years its dates belong to.
    Cached per school_id because every week board hits it and it changes
    once a year."""
    path = settings.calendars_dir / f"{school_id}.md"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        log.warning("school calendar not readable at %s — week board will be empty", path)
        today = datetime.now(UTC).date()
        return "", today.year, today.year

    m = _YEARS.search(text)
    fall_year, spring_year = (int(m.group(1)), int(m.group(2))) if m else (datetime.now(UTC).date().year,) * 2
    return text, fall_year, spring_year


@cache
def _file_weeks(school_id: str) -> list[dict]:
    """The hand-curated file path — everything school_weeks() used to do on
    its own. Still cached indefinitely: a calendar file changes once a year,
    same as before this function existed."""
    text, fall_year, spring_year = _read(school_id)
    if not text:
        return []

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


def school_weeks(school_id: str) -> list[dict]:
    """Every numbered week of one school's year, in order.

    Each: {week, start, end, notes, no_school, closures}
      week       int
      start/end  ISO date strings (Monday and Friday as published) — or
                 both None for NO_CALENDAR_SCHOOL_ID, see _synthetic_weeks()
      no_school  True when the WHOLE week is out
      closures   True when any day in it is out — a plan for such a week has
                 fewer than five teaching days

    Deliberately UNCACHED at this level (unlike the old single cached
    function this replaces): a teacher-submitted calendar (db.py's
    school_calendar_submissions, confirmed by peer review) can change at any
    moment, and this has to see that the moment it happens rather than after
    a process restart. The DB lookup is a single indexed row read — cheap
    enough to skip caching. The hand-curated file path underneath
    (_file_weeks) still caches, since that only ever changes once a year.

    Precedence: a CONFIRMED submission wins outright. Otherwise a PENDING
    one is still used — better for the submitter than no dates at all — but
    stays visibly unconfirmed in the UI (routes/classes.py's
    has_pending_calendar) until someone else at the same school reviews it.
    Otherwise fall back to the hand-curated file, then to dateless weeks.
    """
    if school_id == NO_CALENDAR_SCHOOL_ID:
        return _synthetic_weeks()

    # Local import: keeps the calendar module out of db's import cycle, same
    # as db.py's own local `from . import schoolcal` inside week_board().
    from . import db

    confirmed = db.get_confirmed_calendar_submission(school_id)
    if confirmed:
        return confirmed["weeks"]
    pending = db.get_pending_calendar_submission(school_id)
    if pending:
        return pending["weeks"]

    return _file_weeks(school_id)


def calendar_status(school_id: str) -> dict:
    """{has_calendar, has_pending_calendar} — used by routes/classes.py's
    GET /api/schools to tell a trustworthy calendar apart from a teacher
    submission still awaiting peer review. school_weeks() itself uses a
    pending submission as a best-effort fallback (so its own submitter can
    use it right away), which would otherwise make it indistinguishable from
    a confirmed one to a caller that only checked bool(school_weeks(...))."""
    if school_id == NO_CALENDAR_SCHOOL_ID:
        return {"has_calendar": False, "has_pending_calendar": False}

    from . import db

    confirmed = db.get_confirmed_calendar_submission(school_id)
    pending = None if confirmed else db.get_pending_calendar_submission(school_id)
    return {
        "has_calendar": bool(confirmed) or bool(_file_weeks(school_id)),
        "has_pending_calendar": bool(pending),
    }


def bulk_calendar_status(school_ids: list[str]) -> dict[str, dict]:
    """Same {has_calendar, has_pending_calendar} shape as calendar_status,
    for every school at once — two queries total, not two PER school.

    GET /api/schools used to call calendar_status in a Python loop over
    every seeded school (~300, Alabama's public high schools) — each call
    two sequential DB round-trips, so ~600 per request. On Render's free
    tier that was slow enough for the endpoint to effectively hang rather
    than merely feel slow, which is what actually broke the onboarding
    wizard's school picker in production. _file_weeks stays a per-school
    call (below) since it's file I/O, not a DB round-trip, and already
    lru_cache'd indefinitely — the DB queries were the actual cost."""
    from . import db

    confirmed_ids = db.confirmed_calendar_school_ids()
    pending_ids = db.pending_calendar_school_ids()
    out: dict[str, dict] = {}
    for school_id in school_ids:
        if school_id == NO_CALENDAR_SCHOOL_ID:
            out[school_id] = {"has_calendar": False, "has_pending_calendar": False}
            continue
        confirmed = school_id in confirmed_ids
        out[school_id] = {
            "has_calendar": confirmed or bool(_file_weeks(school_id)),
            "has_pending_calendar": False if confirmed else school_id in pending_ids,
        }
    return out


def week_for(school_id: str, day: date | None = None) -> dict | None:
    """The week containing `day` — or, if that falls in a gap, the next one to
    start. Returns None once the year is over, and also for
    NO_CALENDAR_SCHOOL_ID: with no real dates behind any week, there's no
    way to know which one "today" falls in — a teacher there picks their
    own week by number instead of the app guessing one for them."""
    if school_id == NO_CALENDAR_SCHOOL_ID:
        return None
    day = day or datetime.now(UTC).date()
    iso = day.isoformat()
    upcoming = None
    for w in school_weeks(school_id):
        if w["start"] <= iso <= w["end"]:
            return w
        if w["start"] > iso and upcoming is None:
            upcoming = w
    return upcoming


def label_for(week: dict) -> str:
    """The week_label the rest of the app already speaks — matches the format
    `units.week_number` parses and `plans.week_label` stores.

    A week with no real dates (NO_CALENDAR_SCHOOL_ID) gets just its number —
    never a fabricated date span, which is exactly the "looks right, is
    wrong" failure this module's own scope guard elsewhere exists to
    prevent."""
    if not week.get("start") or not week.get("end"):
        return f"Week {week['week']:02d}"
    start = date.fromisoformat(week["start"])
    end = date.fromisoformat(week["end"])
    span = (
        f"{start.strftime('%b')} {start.day}-{end.day}"
        if start.month == end.month
        else f"{start.strftime('%b')} {start.day}-{end.strftime('%b')} {end.day}"
    )
    return f"Week {week['week']:02d} — {span}, {end.year}"


def _dates_in(segment: str, fall_year: int, spring_year: int) -> list[date]:
    """Every date a phrase refers to, expanding "Oct 8–9" and "Dec 21–Jan 1"."""
    out: list[date] = []
    for m in _SPAN.finditer(segment):
        first = _mk_date(f"{m.group('m1')} {m.group('d1')}", fall_year, spring_year)
        if not first:
            continue
        if not m.group("d2"):
            out.append(first)
            continue
        last = _mk_date(
            f"{m.group('m2') or m.group('m1')} {m.group('d2')}", fall_year, spring_year
        )
        # A span that appears to run backwards has crossed the new year, which
        # _mk_date can't see from the month alone: "Dec 21–Jan 1" reads as
        # Dec 2026 → Jan 2026. Push the end into the following year.
        if last and last < first:
            last = last.replace(year=last.year + 1)
        if not last or (last - first).days > 30:
            out.append(first)
            continue
        out.extend(first + timedelta(days=i) for i in range((last - first).days + 1))
    return out


@cache
def closure_days(school_id: str) -> dict[str, str]:
    """Every individual day one school is closed -> why.

    Read from BOTH the bullet list at the top of the calendar file and the
    per-week Notes column, because the two disagree in useful ways: the bullets
    name the holiday ("Veterans Day Nov 11") while the notes say which weekday it
    lands on ("Wed Nov 11 = Veterans Day (no school)"). A named reason wins over
    the generic one, so a cell can say "Veterans Day" rather than "No school".

    Whole-week closures are deliberately NOT expanded here — `week["no_school"]`
    already carries those, and duplicating them would make a Fall Break week look
    like five unrelated holidays.
    """
    text, fall_year, spring_year = _read(school_id)
    if not text:
        return {}

    out: dict[str, str] = {}

    def add(segment: str) -> None:
        if _NOT_A_CLOSURE.search(segment):
            return
        reason = _reason(segment)
        for d in _dates_in(segment, fall_year, spring_year):
            iso = d.isoformat()
            # First writer wins unless it only had the generic label to offer.
            if iso not in out or out[iso].lower().startswith("no school"):
                out[iso] = reason

    for line in text.splitlines():
        line = line.strip()
        if line.startswith("- "):  # the bullet list
            for segment in line[2:].split(";"):
                if not _WEEK_OFF.search(segment):
                    add(segment)
        elif (row := _ROW.match(line)) and not _WEEK_OFF.search(row.group(4)):
            notes = row.group(4).strip(" |")
            if _ANY_CLOSURE.search(notes):
                add(notes)

    return out


def week_days(school_id: str, week: dict) -> list[dict]:
    """Monday–Friday as five records: {date, dow, is_school, note}.

    Always five, even for a week the school is shut — a calendar grid needs a
    cell per column, and "closed" is information, not absence.

    This is what lets the interface shade a holiday IN PLACE. The week row alone
    can only say "week 15 has a closure somewhere"; deriving Wednesday from that
    in the browser is the same guessing that put a lesson plan inside Fall Break.

    A week with no real dates (NO_CALENDAR_SCHOOL_ID) has no Monday to anchor
    on and no closures on file to shade in — every day comes back a plain
    teaching day with no date, rather than guessing one.
    """
    if not week.get("start") or not week.get("end"):
        return [{"date": None, "dow": _DOW[i], "is_school": True, "note": ""} for i in range(5)]
    start = date.fromisoformat(week["start"])
    end = date.fromisoformat(week["end"])
    # Anchor on the real Monday, not on `start`. Week 1 starts Wednesday and the
    # last week ends Thursday; counting five days forward from `start` would have
    # week 1 running Wed–Sun.
    monday = start - timedelta(days=start.weekday())
    closed = closure_days(school_id)

    out = []
    for i in range(5):
        d = monday + timedelta(days=i)
        iso = d.isoformat()
        if week["no_school"]:
            is_school, note = False, (week["notes"] or "No school")
        elif d < start:
            is_school, note = False, "Before the first day"
        elif d > end:
            is_school, note = False, "After the last day"
        elif iso in closed:
            is_school, note = False, closed[iso]
        else:
            is_school, note = True, ""
        out.append({"date": iso, "dow": _DOW[i], "is_school": is_school, "note": note})
    return out
