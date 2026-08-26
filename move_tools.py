import re

with open("frontend/src/components/AppShell.jsx", "r") as f:
    content = f.read()

# Extract the New Plan block
new_plan_match = re.search(r'(<div className="px-2 pb-1 pt-1">.*?</div>\n)', content, re.DOTALL)
# Extract the Workspace Tools block
tools_match = re.search(r'(\n      <div className="mt-4 mb-2">.*?</div>\n)', content, re.DOTALL)

if new_plan_match and tools_match:
    new_plan_block = new_plan_match.group(1)
    tools_block = tools_match.group(1)
    
    # We replace the entire section that contains both blocks
    section_match = re.search(re.escape(new_plan_block) + r'\s*' + re.escape(tools_block), content)
    if section_match:
        # Swap them. We might want to fix the margins.
        # Workspace Tools has `mt-4 mb-2`. If it's at the top, maybe `mt-2 mb-2`.
        # New Plan has `px-2 pb-1 pt-1`. If it's below Workspace Tools, it needs no top margin.
        tools_block_adjusted = tools_block.replace('className="mt-4 mb-2"', 'className="mt-2 mb-2"')
        
        replacement = tools_block_adjusted + "\n      " + new_plan_block
        content = content.replace(section_match.group(0), replacement)
        
        with open("frontend/src/components/AppShell.jsx", "w") as f:
            f.write(content)
        print("Successfully swapped New Plan and Workspace Tools")
    else:
        print("Could not find adjacent blocks")
else:
    print("Could not find individual blocks")

