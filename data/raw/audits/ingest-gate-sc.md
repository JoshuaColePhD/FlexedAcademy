# Ingest gate: SC

## ELA
- Status after gate: `staged`
- 2530 chunks, 0 errors, 10 warnings
- WARN (near_duplicate): grade 0: codes ['ELA.K.R.1.3', 'ELA.K.R.1.4', 'ELA.K.R.1.5'] share identical text: 'instruction of this indicator begins in fourth grade'
- WARN (near_duplicate): grade 1: codes ['ELA.1.C.1.1.c', 'ELA.1.C.2.1.c'] share identical text: 'provide a concluding statement or idea'
- WARN (near_duplicate): grade 1: codes ['ELA.1.R.1.3', 'ELA.1.R.1.4', 'ELA.1.R.1.5'] share identical text: 'instruction of this indicator begins in fourth grade'
- WARN (near_duplicate): grade 1: codes ['ELA.1.F.1.1', 'ELA.1.F.1.6', 'ELA.1.F.2.2', 'ELA.1.F.2.3', 'ELA.1.F.2.4', 'ELA.1.F.2.5', 'ELA.1.F.3.1', 'ELA.1.F.3.2', 'ELA.1.F.3.3', 'ELA.1.F.3.5'] share identical text: 'there is not an indicator for first grade'
- WARN (near_duplicate): grade 2: codes ['ELA.2.C.1.1.c', 'ELA.2.C.2.1.c'] share identical text: 'provide a concluding statement'
- WARN (near_duplicate): grade 2: codes ['ELA.2.R.1.3', 'ELA.2.R.1.4', 'ELA.2.R.1.5'] share identical text: 'instruction of this indicator begins in fourth grade'
- WARN (near_duplicate): grade 2: codes ['ELA.2.F.1.1', 'ELA.2.F.1.2', 'ELA.2.F.1.3', 'ELA.2.F.1.4', 'ELA.2.F.1.5', 'ELA.2.F.1.6', 'ELA.2.F.2.1', 'ELA.2.F.2.2', 'ELA.2.F.2.3', 'ELA.2.F.2.4', 'ELA.2.F.2.5', 'ELA.2.F.3.1', 'ELA.2.F.3.2', 'ELA.2.F.3.3', 'ELA.2.F.3.5'] share identical text: 'there is not an indicator for second grade'
- WARN (near_duplicate): grade 3: codes ['ELA.3.R.1.3', 'ELA.3.R.1.4', 'ELA.3.R.1.5'] share identical text: 'instruction of this indicator begins in fourth grade'
- WARN (near_duplicate): grade 3: codes ['ELA.3.F.1.1', 'ELA.3.F.1.2', 'ELA.3.F.1.3', 'ELA.3.F.1.4', 'ELA.3.F.1.5', 'ELA.3.F.1.6', 'ELA.3.F.1.7', 'ELA.3.F.2.1', 'ELA.3.F.2.2', 'ELA.3.F.2.3', 'ELA.3.F.2.4', 'ELA.3.F.2.5', 'ELA.3.F.3.1', 'ELA.3.F.3.2', 'ELA.3.F.3.3', 'ELA.3.F.3.4', 'ELA.3.F.3.5', 'ELA.3.F.3.6', 'ELA.3.F.3.7', 'ELA.3.F.3.8', 'ELA.3.F.4.1'] share identical text: 'there is not an indicator for third grade'
- WARN (near_duplicate): grade 5: codes ['ELA.5.C.1.1.e', 'ELA.5.C.2.1.e'] share identical text: 'provide a concluding statement or section'

## Math
- Status after gate: `staged`
- 1092 chunks, 0 errors, 24 warnings
- WARN (elective_code_collision): code 'MPS.PS.1' means different things in 'Algebra 1' vs 'Geometry with Statistics' (chunk 411 vs 363) — course granularity is too coarse here
- WARN (elective_code_collision): code '8.PAFR.2.1' means different things in 'Grade 7 & 8 Compacted Math' vs 'Grade 8' (chunk 798 vs 726) — course granularity is too coarse here
- WARN (elective_code_collision): code '7.PAFR.2.2' means different things in 'Grade 7 & 8 Compacted Math' vs 'Grade 7' (chunk 803 vs 266) — course granularity is too coarse here
- WARN (elective_code_collision): code '8.PAFR.1.6' means different things in 'Grade 7 & 8 Compacted Math' vs 'Grade 8' (chunk 810 vs 728) — course granularity is too coarse here
- WARN (elective_code_collision): code '8.MGSR.3.5' means different things in 'Grade 7 & 8 Compacted Math' vs 'Grade 8' (chunk 845 vs 744) — course granularity is too coarse here
- WARN (elective_code_collision): code '7.MGSR.1.1' means different things in 'Grade 7 & 8 Compacted Math' vs 'Grade 7' (chunk 879 vs 289) — course granularity is too coarse here
- WARN (elective_code_collision): code '7.DPSR.1.3' means different things in 'Grade 7 & 8 Compacted Math' vs 'Grade 7' (chunk 897 vs 297) — course granularity is too coarse here
- WARN (elective_code_collision): code 'GS.PAFR.1.1' means different things in 'Eighth Grade & Geometry Compacted Math ' vs 'Geometry with Statistics' (chunk 1049 vs 309) — course granularity is too coarse here
- WARN (elective_code_collision): code 'GS.MGSR.5.3' means different things in 'Eighth Grade & Geometry Compacted Math ' vs 'Geometry with Statistics' (chunk 1057 vs 324) — course granularity is too coarse here
- WARN (elective_code_collision): code 'GS.MGSR.4.3' means different things in 'Eighth Grade & Geometry Compacted Math ' vs 'Geometry with Statistics' (chunk 1059 vs 328) — course granularity is too coarse here

## Science
- Status after gate: `staged`
- 223 chunks, 0 errors, 2 warnings
- WARN (near_duplicate): grade 99: codes ['C-PS4-4', 'P-PS4-4'] share identical text: 'evaluate the validity and reliability of claims in published materials of the effects that different'
- WARN (coverage_out_of_family): 223 records is far below this state's other subjects (median 1092). CSP may not publish the same breadth for this course; verify against the official state source before treating it as complete.

## Social_Studies
- Status after gate: `staged`
- 979 chunks, 0 errors, 10 warnings
- WARN (near_duplicate): grade 7: codes ['7.3.2.ER', '7.4.2.ER', '7.5.2.ER', '7.6.2.ER'] share identical text: 'identify climate and vegetation regions and the spatial distributions and patterns of natural resour'
- WARN (near_duplicate): grade 9: codes ['NT.3.3', 'OT.3.3'] share identical text: 'explain the design, function, and significance of architecture and religious artifacts found in plac'
- WARN (near_duplicate): grade 10: codes ['NT.3.3', 'OT.3.3'] share identical text: 'explain the design, function, and significance of architecture and religious artifacts found in plac'
- WARN (near_duplicate): grade 11: codes ['NT.3.3', 'OT.3.3'] share identical text: 'explain the design, function, and significance of architecture and religious artifacts found in plac'
- WARN (near_duplicate): grade 12: codes ['NT.3.3', 'OT.3.3'] share identical text: 'explain the design, function, and significance of architecture and religious artifacts found in plac'
- WARN (near_duplicate): grade 9: codes ['NT.2.5', 'OT.2.5'] share identical text: 'analyze a complex set of ideas or sequence of events, and explain how specific characters, events, o'
- WARN (near_duplicate): grade 10: codes ['NT.2.5', 'OT.2.5'] share identical text: 'analyze a complex set of ideas or sequence of events, and explain how specific characters, events, o'
- WARN (near_duplicate): grade 11: codes ['NT.2.5', 'OT.2.5'] share identical text: 'analyze a complex set of ideas or sequence of events, and explain how specific characters, events, o'
- WARN (near_duplicate): grade 12: codes ['NT.2.5', 'OT.2.5'] share identical text: 'analyze a complex set of ideas or sequence of events, and explain how specific characters, events, o'
- WARN (near_duplicate): grade 9: codes ['NT.2.4', 'OT.2.4'] share identical text: 'analyze how complex text structures in biblical texts contribute to the development of plot, setting'
