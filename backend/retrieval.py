"""Retrieval with a relevance floor, plus a post-generation grounding audit.

KNOWN_GAPS.md sets the contract: "the pipeline never fabricates coverage it does
not have... A query about Unit 8 or 9 content should retrieve nothing from
ap_skills and the generator should say so." The old retrieve() always returned
the nearest top_k regardless of distance, so that path was unreachable.

A distance floor alone does NOT satisfy that contract, and it's worth being
precise about why. Measured against the live 164-chunk collection:

    in-domain queries .................... 0.24 - 0.61
    in-domain, jargon-heavy .............. 0.71 - 0.73
        ("Week 3 SPACE CAT analysis of Letter from Birmingham Jail")
    KNOWN-GAP queries .................... 0.52 - 0.68
        ("Unit 8 skills on style", "ACT Reading CLR 501")
    off-domain ........................... 0.82 - 0.91
        (chemistry, algebra, gibberish)

So a floor at 0.78 cleanly rejects off-domain but the known-gap queries land
*inside* it — asking for Unit 8 returns real, in-domain, wrong-for-the-question
standards at 0.52. No single threshold separates "nothing exists" from
"something adjacent exists". Hence three layers:

  1. this module's distance floor      -> kills off-domain
  2. KNOWN_GAPS in the prompt          -> kills the Unit 8 / CLR case
  3. audit_grounding() after the fact  -> catches whatever slipped through

Layer 3 is the only one that's actually verifiable rather than trusted.
"""
from __future__ import annotations

import functools
import json
import logging
from concurrent.futures import ThreadPoolExecutor
import re
from dataclasses import dataclass, field
from pathlib import Path

from .config import settings
from .errors import AppError

log = logging.getLogger("aplang.retrieval")

COLLECTION_NAME = "ap_lang_standards"

# Families that appear in our sources.
GROUNDED_FAMILIES = ("TOD", "ORG", "KLA", "SST", "USG", "PUN")
# Families cited by the curriculum reference but present in NO source document
# we hold — see KNOWN_GAPS.md "ACT Reading-specific codes not included".
UNGROUNDABLE_FAMILIES = ("CLR", "IKI")

# Order matters twice over. Alternation is leftmost-first, so the LONGEST code
# shapes must come first; and the lookarounds make a match a whole token, so a
# short alternative can never carve a fragment out of a longer code.
#
# Both mattered in practice. The old pattern read "LO.3.A.3.1" — an AP Physics
# learning objective — as the AP Lang skill "3.A", then flagged that invented
# fragment as ungrounded, while "R.WME.501" and "S.IOD.301" (the actual ACT
# codes our source publishes) matched nothing at all and sailed through
# unchecked. An audit that cannot see the corpus's own code vocabulary is not
# an audit.
_CODE_RE = re.compile(
    r"(?<![\w.])("
    # ACT standards as published in our source sheet: section letter, strand,
    # score band. e.g. E.CSE.301, R.WME.501, M.NCP.401, S.IOD.301, W.DEV.501
    r"[ERMSW]\.[A-Z]{2,4}\.\d{3}"
    # College Board: learning objectives, essential knowledge, science
    # practices, enduring understandings. e.g. LO.3.A.3.1, EK 1.2.A.1, SP 4.2
    r"|(?:LO|EK|EU|SP)[\s.]?\d+(?:\.[A-Za-z0-9]+)*"
    # Alabama CASE codes as published by ALSDE: a subject+year prefix, a grade or
    # course segment, then the standard. e.g. ELA21.11.R2, MA19.GDA.5,
    # SS24.11.3a, SCI23.9.1, CSC26.9-12.CD.3, ARTS24.HS.MU.1
    r"|[A-Z]{2,5}\d{2}(?:\.[A-Za-z0-9-]+){1,4}"
    r"|Grade\d{1,2}-\d{1,2}[a-c]?"  # legacy ALCOS parse, e.g. Grade11-22a
    r"|(?:TOD|ORG|KLA|SST|USG|PUN|CLR|IKI)\s?\d{3}"  # legacy ACT naming
    r"|R\d{1,2}"  # Alabama ELA recurring, e.g. R4
    r"|\d\.[A-C]"  # AP Lang skill, e.g. 2.A
    r")(?!\.?\w)"
)


# ---------------------------------------------------------------------------
# ACT companion scoping
#
# ACT standards are ingested per subject area (01b_ingest_act_standards.py maps
# the sheet's Section onto courses): English/Reading/Writing -> AP_Lang + ELA,
# Math -> Math, Science -> Science. Every ACT chunk therefore already carries a
# course.
#
# retrieve_raw used to drop the course filter for the ACT strata on the theory
# that "ACT is cross-course". It is not. The corpus holds 724 ELA-side ACT
# chunks against 212 Math and 72 Science, and a lesson-plan query is prose
# either way, so the ELA side won the nearest-neighbour race for every subject.
# Measured symptom: an AP Physics 1 week whose ACT Alignment row cited R.WME.501
# (ACT *Reading* — word meanings in a passage) on three of five days.
#
# A physics week's ACT companion is ACT Science, or it is nothing. The mapping
# below is deterministic on purpose: course names here are free text (any AP
# course the teacher types becomes its own `course` value), so this matches on
# what the name says rather than trusting an embedding to notice the subject.
# ---------------------------------------------------------------------------

# The `course` value the ACT chunks live under, per companion area.
ACT_ELA = "AP_Lang"
ACT_MATH = "Math"
ACT_SCIENCE = "Science"

_ACT_COURSE_PATTERNS: tuple[tuple[str, str], ...] = (
    # Order matters: first match wins. "AP Computer Science A" must not read as
    # science, and "AP Environmental Science" must not read as ELA via "AP".
    (r"computer science|comp\s*sci|\bcsp?\b|programming|coding", ""),
    (r"physics|chemistry|biology|anatomy|geolog|astronom|environmental|"
     r"\bscience\b|\bsci\b", ACT_SCIENCE),
    (r"math|algebra|geometry|calculus|statistic|precalc|pre-calc|trig|"
     r"quantitative", ACT_MATH),
    (r"english|language arts|\bela\b|\blang\b|literature|\blit\b|composition|"
     r"reading|writing|rhetoric", ACT_ELA),
)


def act_course_for(subject_code: str | None) -> str | None:
    """Which ACT subject area is a legitimate companion for this course.

    Returns the ACT chunks' `course` value, or None when the ACT has no test
    section for this subject (social studies, the arts, PE, world languages,
    health, computer science, counseling). None means the generator gets no
    COMPANION ACT STANDARDS block at all and must leave act_alignment empty —
    an empty row is correct output where a borrowed ELA code is not.
    """
    name = (subject_code or "").replace("_", " ").lower()
    if not name:
        return None
    for pattern, act_course in _ACT_COURSE_PATTERNS:
        if re.search(pattern, name):
            return act_course or None
    return None


def _norm_code(code: str) -> str:
    return re.sub(r"\s+", " ", code).strip().upper()


# ---------------------------------------------------------------------------
# Scope guard
#
# The corpus is Grade 11 ALCOS + AP Lang Units 1-7 + ACT English/Writing. A
# query naming a different grade is NOT catchable by distance: "Grade 9 ELA
# standards" scores 0.411 against this corpus — nearer than most genuinely
# in-domain queries — precisely because it IS ELA standards, just the wrong
# grade's. KNOWN_GAPS.md spells out why that's the dangerous case rather than a
# harmless one: "each grade re-uses standard numbers 1-30, so grade must always
# be part of a chunk's identity, never the bare number." So Grade 9 standard 14
# would silently answer with Grade 11's standard 14.
#
# Deterministic guard, not a threshold.
# ---------------------------------------------------------------------------

CORPUS_GRADE = 11

_GRADE_RE = re.compile(
    r"\bgrade\s*(\d{1,2})\b|\b(\d{1,2})\s*(?:st|nd|rd|th)\s+grade\b", re.IGNORECASE
)


def out_of_scope_grades(query: str, corpus_grade: int = 11) -> list[int]:
    """Grades named in the query that this corpus cannot answer for."""
    found = set()
    for a, b in _GRADE_RE.findall(query):
        raw = a or b
        if raw and raw.isdigit():
            found.add(int(raw))
    return sorted(g for g in found if g != corpus_grade)


def scope_error(query: str, grades: list[int], corpus_grade: int = 11) -> AppError:
    listed = ", ".join(str(g) for g in grades)
    return AppError(
        "out_of_scope_grade",
        f"This corpus only covers Grade {corpus_grade}; the request names Grade {listed}.",
        status=422,
        hint=(
            f"Only Grade {corpus_grade} standards were parsed. "
            f"Because every grade re-uses standard numbers 1-30, answering from Grade "
            f"{corpus_grade} would look right and be wrong. Drop the grade from the "
            f"request, or add that grade to source_docs."
        ),
        extra={"named_grades": grades, "corpus_grade": corpus_grade},
    )


# Standards retrieval is pgvector over the `chunks` table (see retrieve_raw).
# A Chroma `get_collection()` used to live here; the Postgres rewrite removed its
# `def` line but left the body behind as an unreachable block after scope_error's
# return — which also meant the missing `settings.chroma_path` never surfaced.

# Query vectors come from the OpenAI embeddings API now (see backend/embeddings.py).
# Re-exported under the old name so callers and scripts don't need to change.
from .embeddings import EMBED_DIMS, EMBED_MODEL, embed_queries, embed_query  # noqa: E402,F401

def load_chunks() -> list[dict]:
    """The full chunk records, straight from the *chunks.json files.

    Richer than Chroma's metadata (which flattens lists to ' | '-joined strings
    and drops Nones) and needs no embedding model — which is what makes the
    Standards browser instant.

    Globs every `*chunks.json` beside chunks.json, matching what
    scripts/02_embed_store.py embeds. Reading only chunks.json meant the browser
    showed 164 AP Lang chunks while the vector store held every Alabama subject,
    so the Standards page and the generator disagreed about what the corpus was.
    """
    primary = Path(settings.chunks_path)
    paths = sorted(primary.parent.glob("*chunks.json"))
    if not paths:
        raise AppError(
            "chunks_missing",
            "No *chunks.json files were found.",
            hint="Run: python scripts/01_parse_chunks.py "
                 "and python scripts/01d_ingest_alcos_case.py",
        )
    out: list[dict] = []
    for path in paths:
        with open(path, encoding="utf-8") as f:
            out.extend(json.load(f))
    return out


@functools.lru_cache(maxsize=1)
def chunks_by_code() -> dict[str, dict]:
    return {_norm_code(c["code"]): c for c in load_chunks()}


# ---------------------------------------------------------------------------
# Grounded retrieval
# ---------------------------------------------------------------------------


@dataclass
class RetrievalResult:
    chunks: list[dict] = field(default_factory=list)
    rejected: list[dict] = field(default_factory=list)
    floor: float = 0.0

    @property
    def empty(self) -> bool:
        return not self.chunks

    @property
    def thin(self) -> bool:
        return 0 < len(self.chunks) < settings.retrieval_thin_threshold

    @property
    def codes(self) -> set[str]:
        """The citable standard codes retrieved — what audit_grounding checks against.

        Read from metadata, not from the Chroma id. Ids are
        `{course}:{grade}:{code}` so that one standard covering grades 9-12 can be
        stored once per grade; using the id here would put "ELA:11:ELA21.11.R2" in
        the allowed set while the plan cites "ELA21.11.R2", and every correctly
        grounded citation would be flagged as ungrounded.
        """
        out = set()
        for c in self.chunks:
            code = (c.get("metadata") or {}).get("code") or c["id"]
            out.add(_norm_code(str(code)))
        return out

    def closest_rejected(self) -> dict | None:
        return self.rejected[0] if self.rejected else None


# Every query below is an ANN search with a metadata filter, and Postgres applies
# that filter AFTER the HNSW index has already chosen its candidates. When the
# filter is selective, the candidate list contains none of the matching rows and
# the query returns FEWER results than asked for — often zero — with no error.
#
# Measured on the live 26,555-row corpus, plain HNSW:
#
#     source_type='ap_skills'      (22 rows)  -> 0 results.  ALWAYS.
#     source_type='act_recurring'  ( 7 rows)  -> 0 results.  ALWAYS.
#
# ap_skills is the stratum that exists specifically to stop the model inventing
# AP skill codes (see STRATA below). It has been returning nothing at all, for
# every request, for every course — so the AP row was being filled from the
# model's memory exactly as the STRATA comment feared, and the fix that was
# supposed to prevent it was never running.
#
# pgvector 0.8's iterative scan is the supported answer: keep pulling candidates
# from the index until enough rows survive the filter. relaxed_order lets it
# return results slightly out of distance order, which costs nothing here — the
# caller re-sorts by distance anyway. max_scan_tuples is raised past the table
# size so a filter matching only a handful of rows can still find them.
#
# Cost measured against Supabase: none discernible. All of these queries are
# ~170-200ms either way; the time is the network round trip, not the scan.
_ITERATIVE_SCAN = (
    "SET LOCAL hnsw.iterative_scan = relaxed_order; "
    "SET LOCAL hnsw.max_scan_tuples = 100000; "
)


def retrieve_raw(
    query: str,
    n: int,
    course: str,
    grade: int,
    source_type: str | None = None,
    query_vector: list[float] | None = None,
) -> list[dict]:
    # `query_vector` lets the caller embed once and search many times. Without
    # it this embedded on every call, and retrieve_grounded calls it five times
    # per query — so the same string went to the embeddings API five times over.
    if query_vector is None:
        query_vector = embed_query(query)
    from . import db
    
    sql = "SELECT id, document, metadata, embedding <=> %s::vector AS distance FROM chunks WHERE 1=1"
    params = [query_vector]
    
    if source_type == "act_standards":
        # Course-scoped, not cross-course — see act_course_for(). A course with
        # no ACT section gets no ACT standards rather than the nearest ELA one.
        act_course = act_course_for(course)
        if act_course is None:
            return []
        sql += " AND metadata->>'source_type' = %s AND metadata->>'course' = %s"
        params.extend([source_type, act_course])
    elif source_type == "act_recurring":
        # R1-R7 are Alabama's ELA Recurring Standards for Grades 9-12 (see
        # scripts/01_parse_chunks.py._parse_recurring, which notes the
        # source_type is "a schema label, not a claim about ACT"). They are
        # ingested under AP_Lang only and they are ELA standards, so they belong
        # to ELA-family courses and nowhere else. Unscoped, R6 — grammar,
        # mechanics and usage — was landing in a physics plan.
        if act_course_for(course) != ACT_ELA:
            return []
        sql += " AND metadata->>'source_type' = %s"
        params.append(source_type)
    else:
        sql += " AND metadata->>'course' = %s"
        params.append(course)
        
        # The OR condition
        sql += " AND ((metadata->>'grade')::int = %s OR metadata->>'source_type' IN ('college_board', 'ap_skills'))"
        params.append(grade)
        
        if source_type:
            sql += " AND metadata->>'source_type' = %s"
            params.append(source_type)
            
    sql += " ORDER BY embedding <=> %s::vector LIMIT %s"
    params.extend([query_vector, n])

    rows = db._rows(_ITERATIVE_SCAN + sql, tuple(params))
    
    out = []
    for r in rows:
        out.append({
            "id": r["id"],
            "document": r["document"],
            "metadata": r["metadata"],
            "distance": float(r["distance"])
        })
    return out


# A lesson plan needs a course standard, an ACT alignment, and an AP skill — the
# district template has a row for each. A single top-k ranking routinely returned
# five ALCOS chunks and no AP skills at all, and the model then filled the AP row
# from memory (one run invented "2.C", a code 01_parse_chunks.py notes does not
# exist). Retrieving per source type means the codes it needs are actually on the
# table, which prevents the fabrication rather than just flagging it afterwards.
STRATA = ("ap_skills", "state_course_of_study", "act_standards", "act_recurring")


def retrieve_grounded(
    query: str,
    subject_code: str = "AP_Lang",
    grade: int = 11,
    top_k: int | None = None,
    max_distance: float | None = None,
    extra_queries: list[str] | None = None,
) -> RetrievalResult:
    top_k = top_k or settings.retrieval_top_k
    floor = settings.floor_for(subject_code) if max_distance is None else max_distance

    searches = [query, *(extra_queries or [])]
    best: dict[str, dict] = {}

    def consider(hits: list[dict]) -> None:
        for c in hits:
            # Keyed on the standard CODE, not the chunk id.
            #
            # Chunk ids are "{course}:{grade}:{code}", and ACT standards are
            # ingested once per course partition — E.CSE.301 exists 8 times with
            # 8 different ids and identical text. The ACT strata deliberately
            # skip course/grade filtering (ACT is cross-course), so every copy
            # comes back, and keying on id kept all of them: a single standard
            # could take every slot in top_k and crowd out the rest of the
            # week's grounding. Same code in one scoped query is the same
            # standard, so keep the nearest and drop the rest.
            meta = c.get("metadata") or {}
            key = _norm_code(str(meta["code"])) if meta.get("code") else c["id"]
            prev = best.get(key)
            if prev is None or c["distance"] < prev["distance"]:
                best[key] = c

    # Every vector we will need, in ONE embeddings call, before any searching.
    # This used to be 30 sequential API round trips for 6 distinct strings —
    # 58% of retrieval, and retrieval was 68% of the whole generation.
    vectors = embed_queries(searches)

    # Sequential on purpose. These are 30 independent reads and running them
    # concurrently is the obvious move — but db._rows takes a single global lock
    # around a single shared connection, so threads here only queue on that lock
    # and the code would claim a parallelism it does not have. Measured: ~1.3s
    # for all 30, which is not where the time goes.
    #
    # (The shared connection is worth revisiting for its own sake: it serialises
    #  every request against every other request, which matters once more than
    #  one teacher is using this at a time. That's a connection pool, not a
    #  thread pool, and it belongs in db.py.)
    jobs = [(q, max(top_k * 3, top_k), None) for q in searches]
    jobs += [(q, top_k, st) for q in searches for st in STRATA]

    for q, n, source_type in jobs:
        try:
            consider(
                retrieve_raw(
                    q,
                    n=n,
                    course=subject_code,
                    grade=grade,
                    source_type=source_type,
                    query_vector=vectors[q],
                )
            )
        except Exception as e:
            log.warning("retrieval failed for %s/%s: %s", q[:40], source_type, e)

    raw = sorted(best.values(), key=lambda c: c["distance"])

    survivors = [c for c in raw if c["distance"] <= floor]
    

    keep = survivors[:top_k]
    kept_ids = {c["id"] for c in keep}
    for source_type in STRATA:
        best_stratum = next(
            (c for c in survivors if (c.get("metadata") or {}).get("source_type") == source_type),
            None,
        )
        if best_stratum and best_stratum["id"] not in kept_ids:
            keep.append(best_stratum)
            kept_ids.add(best_stratum["id"])
    # Distance ascending: nearest first. There is no rerank_score any more.
    keep.sort(key=lambda c: c["distance"])

    drop = [{"id": c["id"], "distance": c["distance"]} for c in raw if c["distance"] > floor][:3]

    log.info(
        "retrieval query_len=%d kept=%d floor=%.2f best=%.3f",
        len(query),
        len(keep),
        floor,
        raw[0]["distance"] if raw else -1,
    )
    return RetrievalResult(chunks=keep, rejected=drop, floor=floor)


def format_context(result: RetrievalResult) -> str:
    """What the generator reads.

    The bracketed label is the standard's own code, not the Chroma id — this is
    the string we want the model to copy into the plan, and it is the string
    audit_grounding will look for afterwards.
    """
    primary_parts = []
    act_parts = []
    
    for i, c in enumerate(result.chunks, 1):
        meta = c.get("metadata") or {}
        code = meta.get("code") or c["id"]
        source_type = meta.get("source_type", "")
        meta_str = " | ".join(f"{k}: {v}" for k, v in meta.items() if v not in (None, ""))
        
        chunk_str = (
            f"Standard [{code}] (distance {c['distance']:.3f}):\n"
            f"Text: {c['document']}\nMetadata: {meta_str}\n"
        )
        
        # Only genuine ACT standards go in the ACT block. `act_recurring` is a
        # schema label for Alabama's ELA Recurring Standards R1-R7, not ACT
        # content; routing it here on a substring match is what put "R6 —
        # conventions of grammar, mechanics and usage" in an ACT Alignment row,
        # sourced to alcos_ela.pdf. It is a primary state standard.
        if source_type == "act_standards":
            act_parts.append(chunk_str)
        else:
            primary_parts.append(chunk_str)
            
    out = []
    if primary_parts:
        out.append("--- PRIMARY COURSE STANDARDS ---")
        out.extend(primary_parts)
    if act_parts:
        out.append("--- COMPANION ACT STANDARDS ---")
        out.extend(act_parts)
        
    return "\n".join(out)


def no_grounded_standards_error(query: str, result: RetrievalResult) -> AppError:
    closest = result.closest_rejected()
    if closest:
        hint = (
            f"Closest match was {closest['id']} at distance {closest['distance']:.2f}, "
            f"above the {result.floor:.2f} relevance floor. Try naming the skill — "
            f'e.g. "rhetorical situation", "line of reasoning", "synthesis", "tone".'
        )
    else:
        hint = "The standards index returned nothing at all. Has scripts/02_embed_store.py been run?"
    return AppError(
        "no_grounded_standards",
        "No standard in the source documents is relevant enough to ground this request.",
        status=422,
        hint=hint,
        extra={"rejected": result.rejected, "floor": result.floor},
    )


# ---------------------------------------------------------------------------
# Layer 3 — post-generation grounding audit
# ---------------------------------------------------------------------------


def audit_grounding(plan: dict, allowed: set[str]) -> list[str]:
    """Flag every standard code the plan cites that retrieval didn't supply.

    Warnings, not errors: the canonical example-week.json itself cites CLR 501,
    and a teacher may legitimately reference something by hand. But an
    ungroundable family gets called out by name, because that's a fabrication
    the docs explicitly predict.
    """
    warnings: list[str] = []
    known = chunks_by_code()

    for day in plan.get("days", []):
        if day.get("no_school"):
            continue
        name = day.get("name", "?")
        cited: list[str] = []
        for fld in ("standards", "act_alignment"):
            cited += _CODE_RE.findall(str(day.get(fld, "")))

        for raw_code in dict.fromkeys(cited):  # de-dupe, keep order
            code = _norm_code(raw_code)
            family = code.split()[0] if " " in code else code
            if family in UNGROUNDABLE_FAMILIES:
                warnings.append(
                    f"{name} cites {raw_code}, which is not in any source document we hold. "
                    f"The {family} family is ACT Reading; our ACT source covers "
                    f"English/Writing only (see Known Gaps)."
                )
            elif code not in allowed and code not in known:
                warnings.append(
                    f"{name} cites {raw_code}, which does not appear in the standards corpus at all."
                )
            elif code not in allowed:
                warnings.append(
                    f"{name} cites {raw_code}, which exists in the corpus but was not "
                    f"among the standards retrieved for this request."
                )
    return warnings
