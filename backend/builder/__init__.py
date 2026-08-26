"""Document-generation code: Florence's hand-written builder, the shared
docx/OOXML helpers, and the generic declarative-spec renderer used by
automated builder-codegen for other schools.

build_lesson_plan.py itself is still loaded by file path at runtime
(docx_build.builder()), never as `backend.builder.build_lesson_plan` — see
that module's own comment on why.
"""
