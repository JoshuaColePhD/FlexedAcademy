with open('backend/prompts.py', 'r') as f:
    content = f.read()

# Fix the strict mandate for the standards field in the week generation prompt
old_mandate1 = "For EVERY teaching day (where `no_school` is false), the `standards` field is MANDATORY. You must identify the closest-fitting primary standard (e.g. ACOS or AP) from the \"--- PRIMARY COURSE STANDARDS ---\" block for EVERY day. Never leave the `standards` field blank unless there is a calendar conflict (no school)."
new_mandate1 = "For EVERY teaching day, you must identify the closest-fitting primary standard from the \"--- PRIMARY COURSE STANDARDS ---\" block. HOWEVER, if no primary course standards are provided (e.g. for a Pre-AP class), you MUST leave the `standards` field blank. NEVER put ACT standards in the `standards` field."
content = content.replace(old_mandate1, new_mandate1)

# Fix the mandate in the revision prompt
old_mandate2 = "The `standards` field is MANDATORY unless the day is marked `no_school`. You must identify the closest-fitting primary standard from the \"--- PRIMARY COURSE STANDARDS ---\" block. Never leave it blank on a teaching day."
new_mandate2 = "You must identify the closest-fitting primary standard from the \"--- PRIMARY COURSE STANDARDS ---\" block. If no primary standards were retrieved, leave the `standards` field blank. NEVER put ACT standards in the `standards` field."
content = content.replace(old_mandate2, new_mandate2)

# Also update the system guidelines block
old_guideline = "5. The `standards` field is MANDATORY for every teaching day. You must select the closest-fitting primary standard from the retrieved block for every day that has school. Do not leave it blank, and do not claim no standard fits. An empty `standards` field is only acceptable on a no-school day (a calendar conflict)."
new_guideline = "5. The `standards` field must ONLY contain primary course standards from the retrieved block. If no primary course standards were retrieved, leave it blank. NEVER put ACT standards in the `standards` field."
content = content.replace(old_guideline, new_guideline)

with open('backend/prompts.py', 'w') as f:
    f.write(content)

