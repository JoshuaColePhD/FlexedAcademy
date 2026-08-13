"""Build a QTI 1.2 package Canvas can import as a Classic Quiz.

QTI 1.2 (IMS Question & Test Interoperability), not 2.1 or Canvas's own "New
Quizzes" format — 1.2 is the dialect every mainstream quiz tool (Respondus,
ExamView, Canvas's own classic-quiz export) actually writes, and the one
Canvas's importer is most permissive about. The package is a zip of exactly
two files:

    imsmanifest.xml   -- declares one resource, type imsqti_xmlv1p2,
                         pointing at the assessment file below.
    <ident>.xml       -- the actual <questestinterop><assessment>, one
                         <section> holding every <item> (question) in order.

Four question types, each its own QTI item shape. The `question_type`
qtimetadata field on every item is a Canvas-specific extension, not part of
the QTI 1.2 spec itself — Canvas's importer reads it to decide how to render
and grade the item (multiple_choice_question / true_false_question /
short_answer_question / matching_question) rather than inferring it from the
item's response structure alone, and every third-party generator Canvas
successfully imports from writes it for that reason.

Built with xml.etree.ElementTree, not string templates — a teacher's own
question text can contain '&', '<', quotes, anything they typed, and an
f-string building XML around that is exactly how you ship a package Canvas's
XML parser rejects outright on one apostrophe.

NOT verified against a live Canvas import in this environment — there's no
Canvas instance reachable here. This follows the documented QTI 1.2 +
Canvas-extension shape as precisely as this codebase can, but the one real
test is importing an actual generated .zip into a Canvas course.
"""
from __future__ import annotations

import uuid
import zipfile
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree as ET

from .config import settings
from .docx_build import safe_filename
from .errors import AppError

QTI_MIME = "application/zip"

# Canvas's own vocabulary for what an item IS, read off itemmetadata rather
# than inferred from the response structure — see the module docstring.
_CANVAS_QUESTION_TYPE = {
    "multiple_choice": "multiple_choice_question",
    "true_false": "true_false_question",
    "short_answer": "short_answer_question",
    "matching": "matching_question",
}


def _new_ident(prefix: str) -> str:
    # QTI idents just have to be unique within the package and start with a
    # letter (some importers reject a leading digit) — a prefixed hex slug
    # satisfies both without needing to be meaningful.
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _material(text: str) -> ET.Element:
    mat = ET.Element("material")
    mattext = ET.SubElement(mat, "mattext", {"texttype": "text/plain"})
    mattext.text = text
    return mat


def _item_metadata(question_type: str, points: float) -> ET.Element:
    meta = ET.Element("itemmetadata")
    qtimeta = ET.SubElement(meta, "qtimetadata")
    for label, entry in (
        ("question_type", _CANVAS_QUESTION_TYPE[question_type]),
        ("points_possible", str(points)),
    ):
        field = ET.SubElement(qtimeta, "qtimetadatafield")
        ET.SubElement(field, "fieldlabel").text = label
        ET.SubElement(field, "fieldentry").text = entry
    return meta


def _outcomes(points: float) -> ET.Element:
    outcomes = ET.Element("outcomes")
    ET.SubElement(
        outcomes, "decvar",
        {"varname": "SCORE", "vartype": "Decimal", "minvalue": "0", "maxvalue": str(points)},
    )
    return outcomes


def _mc_item(ident: str, q: dict, points: float) -> ET.Element:
    item = ET.Element("item", {"ident": ident, "title": ident})
    item.append(_item_metadata("multiple_choice", points))

    presentation = ET.SubElement(item, "presentation")
    presentation.append(_material(q["prompt"]))
    response = ET.SubElement(
        presentation, "response_lid", {"ident": "response1", "rcardinality": "Single"}
    )
    render = ET.SubElement(response, "render_choice")
    choice_idents = []
    for i, choice in enumerate(q["choices"]):
        cid = f"choice_{i}"
        choice_idents.append(cid)
        label = ET.SubElement(render, "response_label", {"ident": cid})
        label.append(_material(choice))

    resprocessing = ET.SubElement(item, "resprocessing")
    resprocessing.append(_outcomes(points))
    respcondition = ET.SubElement(resprocessing, "respcondition", {"continue": "No"})
    conditionvar = ET.SubElement(respcondition, "conditionvar")
    varequal = ET.SubElement(conditionvar, "varequal", {"respident": "response1"})
    varequal.text = choice_idents[q["correct_index"]]
    setvar = ET.SubElement(respcondition, "setvar", {"action": "Set", "varname": "SCORE"})
    setvar.text = str(points)
    return item


def _tf_item(ident: str, q: dict, points: float) -> ET.Element:
    # QTI has no dedicated true/false construct — Canvas's own true/false
    # items are a two-option multiple choice under the hood, distinguished
    # from a real MC item only by the question_type metadata field, and by
    # the choice idents being the fixed pair Canvas's importer expects.
    item = ET.Element("item", {"ident": ident, "title": ident})
    item.append(_item_metadata("true_false", points))

    presentation = ET.SubElement(item, "presentation")
    presentation.append(_material(q["prompt"]))
    response = ET.SubElement(
        presentation, "response_lid", {"ident": "response1", "rcardinality": "Single"}
    )
    render = ET.SubElement(response, "render_choice")
    for cid, text in (("true", "True"), ("false", "False")):
        label = ET.SubElement(render, "response_label", {"ident": cid})
        label.append(_material(text))

    resprocessing = ET.SubElement(item, "resprocessing")
    resprocessing.append(_outcomes(points))
    respcondition = ET.SubElement(resprocessing, "respcondition", {"continue": "No"})
    conditionvar = ET.SubElement(respcondition, "conditionvar")
    varequal = ET.SubElement(conditionvar, "varequal", {"respident": "response1"})
    varequal.text = "true" if q["correct_bool"] else "false"
    setvar = ET.SubElement(respcondition, "setvar", {"action": "Set", "varname": "SCORE"})
    setvar.text = str(points)
    return item


def _short_answer_item(ident: str, q: dict, points: float) -> ET.Element:
    item = ET.Element("item", {"ident": ident, "title": ident})
    item.append(_item_metadata("short_answer", points))

    presentation = ET.SubElement(item, "presentation")
    presentation.append(_material(q["prompt"]))
    response = ET.SubElement(
        presentation, "response_str", {"ident": "response1", "rcardinality": "Single"}
    )
    render = ET.SubElement(response, "render_fib")
    ET.SubElement(render, "response_label", {"ident": "answer1"})

    resprocessing = ET.SubElement(item, "resprocessing")
    resprocessing.append(_outcomes(points))
    # One respcondition per accepted answer, each independently able to
    # award full credit — "continue: Yes" on all but conceptually irrelevant
    # here since only one can ever match a single submitted string, but
    # "No" would stop checking the REST of the accepted list on the first
    # miss within the same condition block, which respcondition doesn't
    # actually do per-varequal anyway; kept explicit per Canvas's own export
    # shape for short-answer items with multiple accepted strings.
    for answer in q["accepted_answers"]:
        respcondition = ET.SubElement(resprocessing, "respcondition", {"continue": "Yes"})
        conditionvar = ET.SubElement(respcondition, "conditionvar")
        varequal = ET.SubElement(conditionvar, "varequal", {"respident": "response1", "case": "No"})
        varequal.text = answer
        setvar = ET.SubElement(respcondition, "setvar", {"action": "Set", "varname": "SCORE"})
        setvar.text = str(points)
    return item


def _matching_item(ident: str, q: dict, points: float) -> ET.Element:
    # Canvas's matching item is N independent response_lids under one item —
    # one per left-hand term, each rendering every right-hand answer as its
    # own choice list — not a single combined response. Each pairing is
    # worth an equal share of the item's total points, added rather than
    # set, since more than one can be right independently of the others.
    item = ET.Element("item", {"ident": ident, "title": ident})
    item.append(_item_metadata("matching", points))

    presentation = ET.SubElement(item, "presentation")
    presentation.append(_material(q["prompt"]))
    pairs = q["pairs"]
    answer_idents = [f"match_{i}" for i in range(len(pairs))]
    response_idents = [f"response_{i}" for i in range(len(pairs))]

    for i, pair in enumerate(pairs):
        response = ET.SubElement(
            presentation, "response_lid", {"ident": response_idents[i], "rcardinality": "Single"}
        )
        response.append(_material(pair["term"]))
        render = ET.SubElement(response, "render_choice")
        # Every term offers the FULL list of right-hand answers, in the
        # pairs' own order — a real matching question, not N separate
        # multiple-choice questions that happen to share a prompt.
        for j, other in enumerate(pairs):
            label = ET.SubElement(render, "response_label", {"ident": answer_idents[j]})
            label.append(_material(other["match"]))

    resprocessing = ET.SubElement(item, "resprocessing")
    resprocessing.append(_outcomes(points))
    per_pair = round(points / len(pairs), 4)
    for i in range(len(pairs)):
        respcondition = ET.SubElement(resprocessing, "respcondition", {"continue": "Yes"})
        conditionvar = ET.SubElement(respcondition, "conditionvar")
        varequal = ET.SubElement(conditionvar, "varequal", {"respident": response_idents[i]})
        varequal.text = answer_idents[i]
        setvar = ET.SubElement(respcondition, "setvar", {"action": "Add", "varname": "SCORE"})
        setvar.text = str(per_pair)
    return item


_BUILDERS = {
    "multiple_choice": _mc_item,
    "true_false": _tf_item,
    "short_answer": _short_answer_item,
    "matching": _matching_item,
}

POINTS_PER_QUESTION = 1.0


def _assessment_xml(quiz: dict, assessment_ident: str) -> bytes:
    root = ET.Element(
        "questestinterop",
        {
            "xmlns": "http://www.imsglobal.org/xsd/ims_qtiasiv1p2",
        },
    )
    assessment = ET.SubElement(root, "assessment", {"ident": assessment_ident, "title": quiz["title"]})
    section = ET.SubElement(assessment, "section", {"ident": "root_section"})

    for q in quiz["questions"]:
        build = _BUILDERS.get(q["type"])
        if build is None:  # pragma: no cover — validate_quiz already rejected this
            raise AppError("qti_unknown_type", f"Unknown question type {q['type']!r}.")
        section.append(build(_new_ident("item"), q, POINTS_PER_QUESTION))

    return b'<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root, encoding="utf-8")


def _manifest_xml(manifest_ident: str, assessment_ident: str, assessment_filename: str) -> bytes:
    NS = "http://www.imsglobal.org/xsd/imscp_v1p1"
    root = ET.Element(
        "manifest",
        {
            "identifier": manifest_ident,
            "xmlns": NS,
            "xmlns:imsmd": "http://www.imsglobal.org/xsd/imsmd_v1p2",
            "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
        },
    )
    ET.SubElement(root, "organizations")
    resources = ET.SubElement(root, "resources")
    resource = ET.SubElement(
        resources, "resource",
        {"identifier": assessment_ident, "type": "imsqti_xmlv1p2"},
    )
    ET.SubElement(resource, "file", {"href": assessment_filename})
    return b'<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root, encoding="utf-8")


def quiz_output_path(plan: dict, quiz_id: str) -> Path:
    """plans/<course-slug>/quizzes/Week_11_Oct_19-23__<id8>.zip

    Mirrors docx_build.plan_output_path's own naming — same course-slug
    directory, same week-name-plus-id8 stem — just under a quizzes/
    subdirectory and a .zip extension, so a plan's docx and its quiz(zes)
    sit side by side rather than in two unrelated trees."""
    course = safe_filename(str(plan.get("course") or "Course"), "Course")
    week = safe_filename(str(plan.get("week_of") or "Week"), "Week")
    return Path(settings.plans_dir) / course / "quizzes" / f"{week}__{quiz_id[:8]}.zip"


def build_qti_zip(quiz: dict, out_path: Path) -> Path:
    """Writes the QTI 1.2 package to `out_path`. Caller has already run
    schema.validate_quiz — this assumes every question is structurally
    sound and raises AppError only for something that shouldn't be
    reachable past that check."""
    assessment_ident = _new_ident("assessment")
    manifest_ident = _new_ident("manifest")
    assessment_filename = f"{assessment_ident}.xml"

    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("imsmanifest.xml", _manifest_xml(manifest_ident, assessment_ident, assessment_filename))
        zf.writestr(assessment_filename, _assessment_xml(quiz, assessment_ident))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(buf.getvalue())
    return out_path
