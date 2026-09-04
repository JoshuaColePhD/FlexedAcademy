# State Adapter Reference

Use this as the minimum design for a new state's source manifest and parser.
It is a checklist, not a requirement that every state use the same file format.

## Manifest fields

Record one entry per authoritative framework, course, or source package:

```yaml
state: "<state name>"
state_code: "<two-letter code>"
ingestion_contract_version: 1
sources:
  - source_id: "<stable internal name>"
    authority: "<official publisher>"
    url: "<official URL or repository path>"
    format: "case|json|xml|xlsx|pdf|html"
    framework: "<framework name>"
    source_type: "state_course_of_study|companion"
    courses: ["<canonical course identity>"]
    grades: ["<grade or grade band>"]
    version: "<publisher version or publication date>"
    retrieved_at: "<UTC timestamp>"
    sha256: "<hash of exact source snapshot>"
    package_sha256: "<hash of containing package, when applicable>"
    license_or_usage: "<terms or review note>"
```

The manifest must make it possible to answer: which official source produced
this chunk, which version was used, and why was it assigned to this course and
grade?

## Normalized chunk contract

Each emitted chunk should contain:

```json
{
  "id": "<state>:<framework>:<course>:<grade>:<code>",
  "document": "<exact standard wording>",
  "metadata": {
    "state": "<state code>",
    "framework": "<framework>",
    "course": "<canonical course identity>",
    "grade": 11,
    "code": "<publisher code>",
    "source_type": "state_course_of_study",
    "source_id": "<manifest source_id>",
    "source_version": "<publisher version>",
    "source_snapshot_sha256": "<hash>",
    "source_ingested_at": "<UTC timestamp>"
  }
}
```

Use a stable canonical course identity for filtering, but preserve the original
publisher course name in an additional metadata field when it differs. Keep
grade as structured metadata; do not infer grade from the text after parsing.

## Adapter acceptance checks

Before embeddings, the adapter should produce a report containing:

- source entries discovered, accepted, rejected, and unmapped;
- counts by framework, course, grade, and source type;
- missing or malformed codes;
- empty or suspiciously short documents;
- duplicate IDs and differing-text collisions;
- source-fidelity samples or deterministic wording checks;
- all warnings and the final pass/fail decision.

For a PDF adapter, retain the exact PDF hash and page or section location when
available. For a structured adapter, retain the package or export hash and the
record identifier supplied by the publisher.

## What belongs in the shared path

The state adapter owns source discovery, parsing, course/grade mapping, and
state-specific fidelity rules. The shared path owns:

- content-addressed embedding caching;
- model and dimension metadata;
- uniquely named staging tables;
- post-load indexes;
- validated atomic cutover;
- live row and retrieval checks.

Do not copy the Alabama parser into a new state and edit it until it happens to
work. Start with the manifest, document the source shape, and add only the
parser logic the new source requires.
