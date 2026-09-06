# Ingest gate: MD

## ELA
- Status after gate: `staged`
- 1116 chunks, 0 errors, 10 warnings
- WARN (near_duplicate): grade 3: codes ['W.3.1.d', 'W.3.2.d'] share identical text: 'provide a concluding statement or section'
- WARN (near_duplicate): grade 3: codes ['RI.3.7', 'RI.3.9'] share identical text: 'use information gained from illustrations (e.g., maps, photographs) and the words in a text to demon'
- WARN (near_duplicate): grade 3: codes ['RI.3.1', 'RL.3.1'] share identical text: 'ask and answer questions to demonstrate understanding of a text, referring explicitly to the text as'
- WARN (near_duplicate): grade 4: codes ['RI.4.1', 'RL.4.1'] share identical text: 'refer to details and examples in a text when explaining what the text says explicitly and when drawi'
- WARN (near_duplicate): grade 5: codes ['RI.5.1', 'RL.5.1'] share identical text: 'quote accurately from a text when explaining what the text says explicitly and when drawing inferenc'
- WARN (near_duplicate): grade 99: codes ['W.PK.10', 'W.PK.4'] share identical text: '(begins in grade 3.)'
- WARN (near_duplicate): grade 99: codes ['RI.PK.10', 'RL.PK.10'] share identical text: 'actively engage in-group reading activities with purpose and understanding'
- WARN (near_duplicate): grade 0: codes ['RI.K.10', 'RL.K.10'] share identical text: 'actively engage in-group reading activities with purpose and understanding'
- WARN (near_duplicate): grade 0: codes ['RI.K.7', 'RI.K.9'] share identical text: 'with prompting and support, describe the relationship between illustrations and the text in which th'
- WARN (near_duplicate): grade 1: codes ['W.1.10', 'W.1.4'] share identical text: '(begins in grade 3.)'

## Math
- Status after gate: `staged`
- 1414 chunks, 0 errors, 30 warnings
- WARN (elective_code_collision): code 'A.REI.B.4.b' means different things in 'Algebra II' vs 'Algebra I' (chunk 850 vs 720) — course granularity is too coarse here
- WARN (elective_code_collision): code 'A.APR.B.3' means different things in 'Algebra II' vs 'Algebra I' (chunk 858 vs 734) — course granularity is too coarse here
- WARN (elective_code_collision): code 'N.Q.A.2' means different things in 'Algebra II' vs 'Algebra I' (chunk 871 vs 752) — course granularity is too coarse here
- WARN (elective_code_collision): code 'S.ID.B.6' means different things in 'Statistics' vs 'Algebra I' (chunk 916 vs 676) — course granularity is too coarse here
- WARN (elective_code_collision): code 'G.GMD.B' means different things in 'Precalculus' vs 'Geometry' (chunk 977 vs 766) — course granularity is too coarse here
- WARN (elective_code_collision): code 'F.IF.A.3' means different things in 'Precalculus' vs 'Algebra I' (chunk 1017 vs 707) — course granularity is too coarse here
- WARN (elective_code_collision): code 'A.SSE.B.4' means different things in 'Precalculus' vs 'Algebra II' (chunk 1031 vs 860) — course granularity is too coarse here
- WARN (elective_code_collision): code 'F.TF.B.5' means different things in 'Precalculus' vs 'Algebra II' (chunk 1123 vs 822) — course granularity is too coarse here
- WARN (elective_code_collision): code 'F.BF.A.1' means different things in 'Precalculus' vs 'Algebra I' (chunk 1160 vs 693) — course granularity is too coarse here
- WARN (elective_code_collision): code 'F.IF.C.9' means different things in 'Precalculus' vs 'Algebra I' (chunk 1163 vs 696) — course granularity is too coarse here

## Science
- Status after gate: `staged`
- 676 chunks, 0 errors, 0 warnings

## Social_Studies
- Status after gate: `staged`
- 113 chunks, 0 errors, 1 warnings
- WARN (coverage_out_of_family): 113 records is far below this state's other subjects (median 1116). CSP may not publish the same breadth for this course; verify against the official state source before treating it as complete.
