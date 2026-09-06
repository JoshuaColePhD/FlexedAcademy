# Alabama Standards: Common Standards Project vs. Supabase
Compares every standard the Common Standards Project (CSP) API reports for Alabama against what's currently ingested into `public.chunks` (metadata->>'state' = 'AL'), course by course.

## Summary

| Course | CSP count | Supabase count | Matched by code | % matched | Description mismatches | Method |
|---|---|---|---|---|---|---|
| AP_Lang | 0 | 164 | — | — | — | description-only |
| Arts | 3044 | 4519 | — | — | — | description-only |
| Counseling | 121 | 611 | — | — | — | description-only |
| DLCS | 270 | 400 | — | — | — | description-only |
| ELA | 943 | 944 | — | — | — | description-only |
| Health | 309 | 603 | — | — | — | description-only |
| Math | 1947 | 2000 | — | — | — | description-only |
| Math_AWF | 0 | 219 | — | — | — | description-only |
| PE | 1472 | 1582 | 856 | 58.2 | 0 | code-based |
| Science | 457 | 1124 | — | — | — | description-only |
| Social_Studies | 1109 | 1867 | 1005 | 90.6 | 0 | code-based |
| World_Languages | 0 | 5832 | — | — | — | description-only |

## AP_Lang
- CSP: 0 standards
- Supabase: 164 standards
- No CSP statement codes available for this set — compared by normalized description text.
- 0 descriptions match verbatim (0.0% of CSP's set); 0 only in CSP; 164 only in Supabase.

## Arts
> ℹ️ CSP's `statementNotation` for this subject uses a different, generic numbering than ALSDE's official published code (e.g. CSP's `HSI.CN.11.20` vs. our `AE24.MA.MS2.16`) — compared by description text instead of code.
- CSP: 3044 standards
- Supabase: 4519 standards
- No CSP statement codes available for this set — compared by normalized description text.
- 1488 descriptions match verbatim (97.7% of CSP's set); 35 only in CSP; 13 only in Supabase.

## Counseling
> ⚠️ CSP's current record is 'Counseling and Guidance (2003-)'; we ingested 'Comprehensive School Counseling (2024-2026)' directly from ALSDE. Expect near-total mismatch by design.
> ℹ️ CSP's `statementNotation` for this subject uses a different, generic numbering than ALSDE's official published code (e.g. CSP's `C:A1.6` vs. our `CSC26.6-8.FW.3`) — compared by description text instead of code.
- CSP: 121 standards
- Supabase: 611 standards
- No CSP statement codes available for this set — compared by normalized description text.
- 4 descriptions match verbatim (3.3% of CSP's set); 117 only in CSP; 184 only in Supabase.

## DLCS
> ⚠️ CSP's current record for this subject is the 2018- revision; we ingested the 2025 revision directly from ALSDE. Expect near-total mismatch by design.
> ℹ️ CSP's `statementNotation` for this subject uses a different, generic numbering than ALSDE's official published code (e.g. CSP's `6.19` vs. our `DLCS25.4.11`) — compared by description text instead of code.
- CSP: 270 standards
- Supabase: 400 standards
- No CSP statement codes available for this set — compared by normalized description text.
- 5 descriptions match verbatim (1.9% of CSP's set); 265 only in CSP; 260 only in Supabase.

## ELA
> ℹ️ CSP's `statementNotation` for this subject uses a different, generic numbering than ALSDE's official published code (e.g. CSP's `6.VL.28` vs. our `ELA21.7.18A`) — compared by description text instead of code.
- CSP: 943 standards
- Supabase: 944 standards
- No CSP statement codes available for this set — compared by normalized description text.
- 762 descriptions match verbatim (92.7% of CSP's set); 60 only in CSP; 60 only in Supabase.

## Health
> 🔎 Many CSP-only entries are PDF-extraction artifacts: CSP's description text runs the standard together with its worked "Examples:" text and mid-word line-wrap breaks, so the same standard reads as different text even when substantively identical.
> ℹ️ CSP's `statementNotation` for this subject uses a different, generic numbering than ALSDE's official published code (e.g. CSP's `7.1.4.B` vs. our `HE19.1.4.2`) — compared by description text instead of code.
- CSP: 309 standards
- Supabase: 603 standards
- No CSP statement codes available for this set — compared by normalized description text.
- 156 descriptions match verbatim (51.0% of CSP's set); 150 only in CSP; 176 only in Supabase.

## Math
> 🔎 A large share of CSP-only entries come from course-specific Mathematics (2019-) standard sets — Career Mathematics (2015) and Algebra with Finance (2017) — that don't appear to be mapped into our ingested `Math` course at all (they may only be covered separately by `Math_AWF`, or missing entirely).
> ℹ️ CSP's `statementNotation` for this subject uses a different, generic numbering than ALSDE's official published code (e.g. CSP's `6.PR.A.3` vs. our `MA19.7A.32`) — compared by description text instead of code.
- CSP: 1947 standards
- Supabase: 2000 standards
- No CSP statement codes available for this set — compared by normalized description text.
- 684 descriptions match verbatim (67.4% of CSP's set); 331 only in CSP; 192 only in Supabase.

## Math_AWF
> ⚠️ This is a superseded course on both sides (ours: 2015 rev; CSP: 2014-2017). CSP has no `statementNotation` codes for this set — compared by description text only.
- CSP: 0 standards
- Supabase: 219 standards
- No CSP statement codes available for this set — compared by normalized description text.
- 0 descriptions match verbatim (0.0% of CSP's set); 0 only in CSP; 71 only in Supabase.

## PE
- CSP: 1472 standards
- Supabase: 1582 standards
- 856/1472 CSP codes (58.2%) found in Supabase by code; 616 CSP codes missing from Supabase; 0 Supabase codes not present in CSP's export.
- Of matched codes, 0 have a description that differs from CSP's text.

**Sample codes CSP has that Supabase doesn't:**
- `PE19.BK1.5.D` (Beginning Kinesiology - Level 1): BK-5.4 Values Physical Activity: _Social interaction_
- `PE19.BK1.5.C` (Beginning Kinesiology - Level 1): BK-5.3 Values Physical Activity: _Self-expression and enjoyment_
- `PE19.BK1.5.B` (Beginning Kinesiology - Level 1): BK-5.2 Values Physical Activity: _Challenge_
- `PE19.BK1.5.A` (Beginning Kinesiology - Level 1): BK-5.1 Values Physical Activity: _Health_
- `PE19.BK1.5` (Beginning Kinesiology - Level 1): Anchor Standard 5: Values Physical Activity: _The physically literate individual recognizes the value of physical activi
- `PE19.BK1.4.E` (Beginning Kinesiology - Level 1): BK-4.5 Personal and Social Behavior: _Safety_
- `PE19.BK1.4.D` (Beginning Kinesiology - Level 1): BK-4.4 Personal and Social Behavior: _Working with others_
- `PE19.BK1.4.C` (Beginning Kinesiology - Level 1): BK-4.3 Personal and Social Behavior: _Working with others_

## Science
> ℹ️ CSP's `statementNotation` for this subject uses a different, generic numbering than ALSDE's official published code (e.g. CSP's `1.3` vs. our `SC23.PS.2`) — compared by description text instead of code.
- CSP: 457 standards
- Supabase: 1124 standards
- No CSP statement codes available for this set — compared by normalized description text.
- 371 descriptions match verbatim (81.2% of CSP's set); 86 only in CSP; 27 only in Supabase.

## Social_Studies
> 🔎 Nearly every description mismatch here is CSP stripping the italic markdown (`*Einsatzgruppen*`, `*Wyatt v. Stickney*`) that we apply around book titles, case names, and foreign terms — a formatting difference, not a content one.
- CSP: 1109 standards
- Supabase: 1867 standards
- 1005/1109 CSP codes (90.6%) found in Supabase by code; 104 CSP codes missing from Supabase; 4 Supabase codes not present in CSP's export.
- Of matched codes, 0 have a description that differs from CSP's text.

**Sample codes CSP has that Supabase doesn't:**
- `SS24.USG.13d` (Grade 12: United States Government): Analyze and interpret the concept of tribal sovereignty, its historical background, and its significance for Native Amer
- `SS24.USG.LSG` (Grade 12: United States Government): Local and State Government
- `SS24.USG.CCR` (Grade 12: United States Government): Citizenship and Civic Responsibilities
- `SS24.USG.IPP` (Grade 12: United States Government): Key Institutions and Political Participation
- `SS24.USG.BG` (Grade 12: United States Government): Branches of Government
- `SS24.USG.AG` (Grade 12: United States Government): Foundations of American Government
- `SS24.E.GE` (Grade 12: Economics): Global Economy
- `SS24.E.GIE` (Grade 12: Economics): Government in Economics

## World_Languages
> ⚠️ CSP's current record is the 2006- revision (Languages Other Than English); we ingested the 2017 revision directly from ALSDE. CSP also has no `statementNotation` codes for this set at all, so no code-level diff is possible — compared by description text only.
- CSP: 0 standards
- Supabase: 5832 standards
- No CSP statement codes available for this set — compared by normalized description text.
- 0 descriptions match verbatim (0.0% of CSP's set); 0 only in CSP; 662 only in Supabase.
