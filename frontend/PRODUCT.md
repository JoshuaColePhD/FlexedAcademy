# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two audiences, one product:

- **Individual teachers** (primary today) — a high-school teacher signs up themselves, self-serve, personal card, to stop spending their own evenings writing weekly lesson plans. This is the audience the live app is built for and calibrated against (AP Lang, grades 9–12, Alabama Course of Study).
- **District/school buyers** (new for this page) — a department chair, curriculum coordinator, or administrator evaluating the tool for teachers under them, not for their own personal use. They need to trust the grounding claim and the standards-compliance mechanism before they'll approve or fund it, and they read the page differently than a self-serve teacher: less "try it free," more "is this defensible to put in front of my department."

## Product Purpose

FlexedAcademy drafts weekly lesson plans that are grounded in the verbatim text of real standards documents — not an LLM's memory of what a standard probably says — and delivers them as the district's own .docx format. Success is a teacher (or a department) trusting a generated plan enough to actually use it, because every standard code the plan cites traces back to a real, checkable source chunk.

## Positioning

The mechanism a competitor can't just claim: retrieval-first generation with a post-generation grounding audit. The model never answers "what does standard 14 say" from memory — it's handed the verbatim standard text first and can only cite what retrieval actually supplied. Hallucinated codes are a checkable, surfaced failure, not an invisible one. This is what a district buyer needs to hear that a generic "AI lesson planner" pitch doesn't give them.

## Operating Context

- Currently calibrated and fully tested for **AP Lang, grade 11, Alabama Course of Study** (relevance floor measured and tuned).
- Multi-subject support exists (11 Alabama Course of Study frameworks, grades 9–12) but is **not uniformly trustworthy yet** — the relevance floor is calibrated per-corpus and only proven for AP Lang; other subjects (Math, Science, PE) have not had their floors re-measured and can fail to reject off-domain queries. This is an internal engineering fact, not something the landing page should surface as a feature — the page should not overclaim multi-subject readiness.
- Output is the district's actual .docx format, not a generic template — the plan a teacher downloads matches what their district already expects to receive.
- The app itself lives at `flexedacademy.com` and the landing page is served from the same app/deploy (`/` route), not a separate marketing site — "Start a week free" is a real in-app route, not a cross-domain hop.
- Pricing is fetched live from the backend (`/api/publicPrice`), never hardcoded on the page — until Stripe is configured for a given deployment, the endpoint returns null and the price line is simply absent.

## Capabilities and Constraints

- Free trial: first week (or configured `free_allowance` weeks) free, then a recurring price fetched from the backend.
- Auth: signed cookies (PBKDF2) or Google OAuth.
- Every standard code shown in a generated plan is checkable against a real source chunk with a code and page/section citation — this is the one claim the page should make loudly; everything else is secondary.
- Explicitly **not yet true, so not to be claimed**: multi-subject readiness beyond AP Lang, third-party testimonials, customer/district logos, usage statistics, or any specific district's endorsement.

## Brand Commitments

- Name: **Flexed Academy** (also "FlexedAcademy" in code/docs).
- Built by a working Florence, Alabama high-school teacher — real and stateable, not a marketing invention.
- Visual identity: the public-facing "door" (landing/marketing surfaces) uses `--brand`, a violet that appears nowhere else in the product. Inside the app, `--accent` is the Florence City Schools district blue that is also printed on the generated .docx — that color means something operationally and must stay reserved for the app's actual UI, not be reused as a marketing color. This violet/blue split is a deliberate, existing decision (see `frontend/src/styles/tokens.css`) and should be preserved, not re-litigated, by this redesign.
- Tone: plain, factual, a little understated — the existing copy states the grounding claim once, precisely, rather than with marketing superlatives. ("A week of plans that cite their sources.")
- Logo mark: a faceted, geometric compass-star/brain mark, supplied as `frontend/public/logo-mark.png` (source: `Projects/FlexedAcademy/logo/purple_ai_logo_1785784407965.jpg`). Tried on the redesigned landing header and removed at Josh's request — the file is a flat opaque PNG (no alpha channel, converted from a JPEG), so it rendered as a hard white-cornered square against the violet ground rather than blending in. The header is text-only ("Flexed Academy") until a transparent-background version of the mark exists.

## Evidence on Hand

None yet. No testimonials, customer logos, usage numbers, or district endorsements exist and none should be fabricated or implied. The page's proof mechanism has to be the grounding claim itself (verbatim retrieval + citation + audit) explained clearly enough to be self-evidencing, plus real product screenshots if/when captured — not social proof.

## Product Principles

1. The grounding/citation mechanism is the entire pitch — every section should either build up to that claim or get out of its way.
2. Say only what's true today. Multi-subject breadth exists in the codebase but is not calibrated everywhere; the page must not claim readiness the product can't back up.
3. One page serves two readers (self-serve teacher, evaluating administrator) without becoming two pages — the district-buyer trust case (mechanism, rigor, verifiability) should sit alongside, not replace, the teacher's "start free" path.
4. No invented social proof. Absence of testimonials/logos is honest and should stay that way until real evidence exists.
5. The violet/blue color split is identity architecture, not decoration — violet is the door, blue is the room.

## Accessibility & Inclusion

No product-specific accessibility requirement has been established beyond standard web accessibility practice.
