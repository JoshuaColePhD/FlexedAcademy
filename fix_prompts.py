import re

with open('backend/prompts.py', 'r') as f:
    content = f.read()

old_instruction = "- The `standards` array contains any content learning standards this lesson addresses, from the provided curriculum."
new_instruction = "- The `standards` array contains any content learning standards this lesson addresses, strictly from the provided curriculum. **CRITICAL: NEVER put ACT standards in this row. If no content standards were provided or found (e.g. for a Pre-AP class), leave this array empty. Do NOT substitute ACT standards into this row.**"

content = content.replace(old_instruction, new_instruction)

with open('backend/prompts.py', 'w') as f:
    f.write(content)

