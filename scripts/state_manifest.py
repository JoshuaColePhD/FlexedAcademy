"""Load and validate one state's ingestion manifest.

A manifest is the whole state-specific half of an ingest: which official CASE
server to read, which packages, which PDF verifies each one, and — the part
that actually decides what a teacher gets — which (subject, grade) binds to
which framework.

The binding is data, authored and reviewed per state, rather than inferred at
query time from whatever `course` strings a parse happened to emit. Inference is
how "ELA" in one state silently resolves to another state's idea of ELA, and it
is what the skill means by "Do not guess a course, grade, framework, or code
mapping. Stop and report an unmapped source instead."

Validation here is structural only — a manifest that contradicts itself. Whether
a mapping points at a framework that actually produced chunks is checked in
check_state_ingest.py, against the parsed output, because that is the only place
the answer exists.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MANIFEST_DIR = Path(__file__).resolve().parent / "state_manifests"

# A course_map entry either names a source_id in this manifest, or says the
# subject grounds in the shared national corpus (AP/College Board/ACT) and has
# no state framework at all. The second is a real answer, not a gap.
NATIONAL_ONLY = "national_only"


class ManifestError(ValueError):
    """A manifest that contradicts itself. Always fatal: an ingest driven by a
    manifest nobody can trust is worse than no ingest."""


@dataclass(frozen=True)
class Source:
    source_id: str
    course: str
    framework: str
    case_id: str
    pdf: str | None = None
    url: str | None = None
    format: str = "case"
    source_type: str = "state_course_of_study"
    version: str | None = None
    retrieved_at: str | None = None
    sha256: str | None = None
    package_sha256: str | None = None


@dataclass(frozen=True)
class Binding:
    """One (subject_code, grades) -> framework decision."""
    subject_code: str
    grades: tuple[int, ...]
    source_id: str | None = None      # None iff target is national_only
    target: str | None = None


@dataclass(frozen=True)
class Manifest:
    state: str
    state_code: str
    authority: str
    case_api: str
    default_grades: str
    output: str
    pdf_dir: str | None
    license_or_usage: str | None
    sources: tuple[Source, ...]
    course_map: tuple[Binding, ...]
    unmapped: dict[str, str] = field(default_factory=dict)

    @property
    def framework_ids(self) -> frozenset[str]:
        return frozenset(s.course for s in self.sources)

    def source(self, source_id: str) -> Source:
        for s in self.sources:
            if s.source_id == source_id:
                return s
        raise ManifestError(f"{self.state_code}: no source {source_id!r}")

    def binding_for(self, subject_code: str, grade: int) -> Binding | None:
        """The framework this class grounds in, or None if nothing is bound.

        None is the fail-closed answer the caller must surface as "we don't have
        standards for this yet" — never as a reason to fall back to another
        subject's or another state's framework.
        """
        for binding in self.course_map:
            if binding.subject_code == subject_code and grade in binding.grades:
                return binding
        return None

    @property
    def is_ingestable(self) -> bool:
        """A scaffold manifest (no sources yet) is valid but not yet usable."""
        return bool(self.sources)


def parse_grades(spec: str) -> frozenset[int]:
    """"9-12", "0-12", "9,10,11" -> the grades themselves. K is 0."""
    grades: set[int] = set()
    for part in str(spec).split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            lo, _, hi = part.partition("-")
            try:
                lo_i, hi_i = int(lo), int(hi)
            except ValueError:
                raise ManifestError(f"grades: {part!r} is not a range like 9-12") from None
            if lo_i > hi_i:
                raise ManifestError(f"grades: {part!r} is backwards")
            grades.update(range(lo_i, hi_i + 1))
        else:
            try:
                grades.add(int(part))
            except ValueError:
                raise ManifestError(f"grades: {part!r} is not a grade number") from None
    if not grades:
        raise ManifestError(f"grades: {spec!r} selects nothing")
    if any(g < 0 or g > 12 for g in grades):
        raise ManifestError(f"grades: {spec!r} falls outside 0-12 (0 = Kindergarten)")
    return frozenset(grades)


def manifest_path(state_code: str) -> Path:
    return MANIFEST_DIR / f"{state_code.strip().lower()}.yaml"


def load(state_code: str) -> Manifest:
    path = manifest_path(state_code)
    if not path.is_file():
        available = sorted(p.stem.upper() for p in MANIFEST_DIR.glob("*.yaml"))
        raise ManifestError(
            f"no manifest for {state_code!r} at {path}. Have: {', '.join(available) or 'none'}"
        )
    raw = yaml.safe_load(path.read_text()) or {}

    for required in ("state", "state_code", "case_api", "output"):
        if not raw.get(required):
            raise ManifestError(f"{path.name}: missing required field {required!r}")

    declared = str(raw["state_code"]).strip().upper()
    if declared != state_code.strip().upper():
        # The filename and the contents disagreeing is how a manifest ends up
        # ingesting one state's packages under another state's code.
        raise ManifestError(
            f"{path.name}: declares state_code {declared!r} but is named for "
            f"{state_code.strip().upper()!r}"
        )

    sources: list[Source] = []
    seen_ids: set[str] = set()
    for entry in raw.get("sources") or []:
        for required in ("source_id", "course", "case_id"):
            if not entry.get(required):
                raise ManifestError(f"{path.name}: a source is missing {required!r}")
        if entry["source_id"] in seen_ids:
            raise ManifestError(f"{path.name}: duplicate source_id {entry['source_id']!r}")
        seen_ids.add(entry["source_id"])
        sources.append(Source(**{k: v for k, v in entry.items() if k in Source.__annotations__}))

    course_map: list[Binding] = []
    seen_bindings: set[tuple[str, int]] = set()
    for entry in raw.get("course_map") or []:
        subject = entry.get("subject_code")
        if not subject:
            raise ManifestError(f"{path.name}: a course_map entry has no subject_code")
        target = entry.get("target")
        source_id = entry.get("source_id")
        if target == NATIONAL_ONLY:
            source_id = None
        elif source_id is None:
            raise ManifestError(
                f"{path.name}: course_map entry {subject!r} names neither a source_id "
                f"nor target: {NATIONAL_ONLY}"
            )
        elif source_id not in seen_ids:
            raise ManifestError(
                f"{path.name}: course_map entry {subject!r} points at unknown "
                f"source_id {source_id!r}"
            )
        grades = tuple(sorted(parse_grades(",".join(str(g) for g in entry.get("grades") or []))))
        # One (subject, grade) resolving to two frameworks is not a preference to
        # break at query time, it is an unanswered question about the manifest.
        for grade in grades:
            if (subject, grade) in seen_bindings:
                raise ManifestError(
                    f"{path.name}: {subject!r} grade {grade} is bound twice"
                )
            seen_bindings.add((subject, grade))
        course_map.append(Binding(subject, grades, source_id, target))

    unmapped: dict[str, str] = {}
    for entry in raw.get("unmapped") or []:
        subject = entry.get("subject_code")
        if not subject:
            raise ManifestError(f"{path.name}: an unmapped entry has no subject_code")
        reason = (entry.get("reason") or "").strip()
        if not reason:
            # "Unmapped with no reason" is indistinguishable from an oversight,
            # which defeats the point of declaring it.
            raise ManifestError(f"{path.name}: unmapped {subject!r} gives no reason")
        if any(b.subject_code == subject for b in course_map):
            raise ManifestError(
                f"{path.name}: {subject!r} is both bound and declared unmapped"
            )
        unmapped[subject] = reason

    return Manifest(
        state=raw["state"],
        state_code=declared,
        authority=raw.get("authority", ""),
        case_api=str(raw["case_api"]).rstrip("/"),
        default_grades=str(raw.get("default_grades", "9-12")),
        output=raw["output"],
        pdf_dir=raw.get("pdf_dir"),
        license_or_usage=raw.get("license_or_usage"),
        sources=tuple(sources),
        course_map=tuple(course_map),
        unmapped=unmapped,
    )


def available_states() -> list[str]:
    return sorted(p.stem.upper() for p in MANIFEST_DIR.glob("*.yaml"))
