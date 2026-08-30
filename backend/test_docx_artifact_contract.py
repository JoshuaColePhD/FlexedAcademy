"""Regression tests for the lesson-plan document artifact contract."""

from zipfile import ZipFile

from backend import docx_build


def _write_docx(path):
    with ZipFile(path, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types />")
        archive.writestr("word/document.xml", "<document />")


def test_valid_docx_requires_the_word_package_members(tmp_path):
    path = tmp_path / "plan.docx"
    _write_docx(path)

    assert docx_build.is_valid_docx(path)


def test_json_error_body_is_not_a_docx(tmp_path):
    path = tmp_path / "download.json"
    path.write_text('{"error":{"code":"docx_missing"}}', encoding="utf-8")

    assert not docx_build.is_valid_docx(path)


def test_corrupt_docx_is_not_marked_ready(tmp_path):
    path = tmp_path / "plan.docx"
    with ZipFile(path, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types />")
        archive.writestr("word/document.xml", "<document />")
    path.write_bytes(path.read_bytes()[:-3])

    assert not docx_build.is_valid_docx(path)
