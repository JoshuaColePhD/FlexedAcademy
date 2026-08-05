import json

raw = """
June
June 3-4 - Admin Retreat
June 14-17 - CLAS Convention (Mobile)

July
July 6 - HAPPY BIRTHDAY CLARKE & HODGES!
July 7-9 - Admin Retreat
July 17 - HAPPY BIRTHDAY GINGER & ANNE-MARIE!
July 20 - FHS Summer Planning Day
July 24 - Schedules go live to teachers
July 27-28 - New Teacher Orientation
July 29 - Opening Institute
July 30 - Teacher Work day, 10th Pathways Meeting 1:00 RM 217, 9th Grade Orientation 4:30pm
July 31 - FLCN, Schedules go live to students

August
August 2 - FHS Orientation 10th-12th 2pm
August 3 - Instructional Alignment/PD Day
August 4 - Senior Sunrise 5:30am, Data Day
August 5 - First Day for Students, Practice Safety Drill
August 11 - Meet the Falcons at FHS 5:30pm
August 13 - IEPs, FHS @ Huntsville (Jamboree)
August 18 - Senior Parent Meeting, FHS Auditorium @ 6:30PM
August 19 - IEPs
August 21 - FHS @ Pinson Valley
August 28 - FHS vs Jasper (Youth Night)

September
September 2 - PST (9-11)
September 2 - IEPs
September 4 - FHS @ Muscle Shoals
September 7 - Labor Day - No School
September 8 - FLCN, Admin SPED Training at CO
September 10 - Weather Drill
September 11 - FHS @ Russellville
September 16 -IEPs
September 18 - FHS vs Decatur (Homecoming)
September 23 - Picture Day
September 26- Band - Bob Jones Competition
September 30 - IEPs

October
October 1 - PLPs Due
October 2 - FHS vs Athens (Teacher Appreciation)
October 3- Band Competition- Northeast Mississippi Community College
October 6 - PreACT (10th grade), ASVAB
October 7 - PSAT/NMSQT, Fire Drill, PST (SENIORS)
October 8 - Parent/Teacher Conferences, FHS vs E. Limestone (1st Responders)
October 9 - FLCN (Edcamp ½ day p.m.)
October 12-16 - FALL BREAK
October 16 - FHS @ Austin
October 20 - WorkKeys (Seniors)
October 21 - IEPs
October 22-Dance Service Project
October 23 - FHS vs Hartselle (Senior Night)
October 24- Band Competition-Athens
October 26 - PST (9-11)
October 27- FHS Chorus Concert 7 pm
October 29 - IEPs
October 30 - FHS @ Ft. Payne

November
November 1- All-State Chorus auditions
November 6- Dance Gala (TBD)
November 7- Theater- District Trumbauer (Decatur)
November 10 - Lockdown Drill
November 11 - Veteran’s Day Holiday - No School
November 12 - IEPs
November 13-15- Theater Musical (7 pm, 7 pm, 3 pm)
November 17- Songwriter Showcase 7 pm
November 18 - PST (9-11)
November 19- IEPs, Strings Recital FHS
November 23-27 - Thanksgiving Break

December
December 3 - IEPs, Weather Drill
December 4-5- Theater State Trumbauer
December 8- FHS FAFA Winter Showcase- 7 pm
December 10 - IEPs
December 11- FAFA Room 25 Acoustic Show
December 17 - Early Dismissal, HAPPY BIRTHDAY CAROLINE!
December 18-January 6  - WINTER BREAK

January
January 5-6 - Teachers Back
January 7 - Students Return
January 11 - Lockdown Drill
January 12 - PST (SENIORS)
January 13 - IEPs
January 14- Super Citizens Program (need auditorium) 9:30 am
January 18 - MLK Jr Holiday (No School)
January 20 - PST (9-11)
January 21- FAFA Dance Showcase 7 pm
January 21-23- AMEA Conference
January 27 - IEPs

February
February 4 - Weather Drill
February 10 - IEPs
February 11-13- Theater Thespians Festival
February 13 - Professional Development Day
February 15 - President’s Day (No School)
February 20-21- Theater Production (7 pm; 3 pm)
February 24 - IEPs
February 25- FAFA Dance Production 7 pm
February 26 - PST (9-11)
February 26- FAFA Dance Production 7 pm; FAFA Dance Festival begins
February 27- FAFA Dance Festival
February 28- FAFA Dance Festival and show at 3 pm

March
March 5- Shoals Area Honor Band
March 6-10- Dance National High School Dance Festival
March 9 - ACT (11th)
March 10 - IEPs, Fire Drill
March 11-13- Chorus AVA All-State Festival
March 12 - Data Day
March 16 - PST (SENIORS)
March 22-26 - SPRING BREAK
March 31 - IEPs

April
April 6 - ACT (11th)
April 7 - PST (9-11)
April 8- Songwriter Showcase 7 pm
April 10-11 - Falcon Beauty Pageant
April 14 - IEPs
April 16- FHS Dancing with the Stars 7 pm
April 21-24- Band All-State Honor Band in Huntsville
April 28 - IEPs
April 30 - FLCN (Pacing); Show Choir Big Show #1 7 pm

May
May 1- Show Choir Big Show #2 7 pm
May 2- Show Choir Big Show #3 2 pm
May 4- Fire Drill, Band Spring Concert
May 5 - PST (9-11)
May 6 - Senior Awards Day
May 7- FHS Got Talent 2 pm; Spring Dance Showcase 7 pm
May 8- Class of 1977 Reunion - Tour of FHS @ 10am (Assign administrator)
May 10- Spring Piano Recital- 7 pm
May 11- Super Citizen (need auditorium) 9:30 am
May 12 - IEPs, Senior Walk (Elementary Schools)
May 14- Room 25 Rock Show
May 15 - Prom @ UNA Gullott Center, 7pm
May 17- Band Banquet 6:30 pm
May 26 - IEPs
May 27 - Last Day for Students
May 28 - Graduation
May 31 - Memorial Day (No School)
"""

events = []
for line in raw.strip().split('\n'):
    if '-' in line and not line.startswith(' '):
        parts = line.split('-', 1)
        events.append({"date": parts[0].strip(), "event": parts[1].strip()})

with open('frontend/src/data/fhs_events.json', 'w') as f:
    json.dump(events, f, indent=2)
