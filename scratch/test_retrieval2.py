from backend import retrieval
from backend.config import settings
import json

def test():
    course = "Special_Education"
    grade = 11
    query = "Course: Special_Education, Grade: 11 - What subject or course should Week 4 cover? Life skills/transition What is the main topic, standard, or skill for the week? Build foundational skills What level of support should be emphasized? Mostly grade-level with accommodations"
    
    try:
        res = retrieval.retrieve_grounded(
            query=query,
            subject_code=course,
            grade=grade
        )
        print("Empty:", res.empty)
        if res.empty:
            print("Rejected:", len(res.rejected))
            print("Floor:", res.floor)
    except Exception as e:
        print("Error:", repr(e))

test()
