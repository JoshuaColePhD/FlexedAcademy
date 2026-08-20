from backend import retrieval
from backend.config import settings

def test():
    course = "Special_Education"
    grade = 11
    query = "Life skills transition foundational skills"
    
    print("Course variants:", retrieval.course_variants(course))
    
    res = retrieval.retrieve_raw(
        query=query,
        n=10,
        course=course,
        grade=grade,
        source_type="state_course_of_study"
    )
    print("Results:", len(res))

test()
