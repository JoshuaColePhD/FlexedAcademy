import requests
import re

courses = [
    "algebra-1", "algebra-2", "biology", "chemistry",
    "dance", "english-2", "geometry", "music",
    "theatre", "visual-arts", "world-history"
]

for course in courses:
    resp = requests.get(f"https://pre-ap.collegeboard.org/courses/{course}")
    match = re.search(r'href="(/media/pdf/[^"]+course-guide\.pdf)"', resp.text)
    if match:
        print(f"{course}: https://pre-ap.collegeboard.org{match.group(1)}")
    else:
        print(f"{course}: NOT FOUND")
