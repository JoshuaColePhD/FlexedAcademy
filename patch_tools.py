import re

with open("frontend/src/components/AppShell.jsx", "r") as f:
    content = f.read()

# Extract workspace tools block
tools_match = re.search(r'(<div className="mt-6 border-t border-edge/50 pt-4">\s*<p className="eyebrow px-4 pb-2">Workspace Tools</p>.*?)</div>\s*</div>\s*</nav>', content, re.DOTALL)
if tools_match:
    tools_block = tools_match.group(1)
    
    # Remove it from the bottom
    content = content.replace(tools_block, "")
    
    # We also need to fix the indentation or just wrap it properly.
    # The original has px-4, we can leave it as is or change to px-2 to match the new container.
    tools_block_clean = tools_block.replace('mt-6 border-t border-edge/50 pt-4', 'mt-4 mb-2').replace('px-4 pb-2', 'px-2 pb-1')
    
    # Insert it under the New plan button
    target_insert = """            <kbd className="font-mono text-2xs">⌘K</kbd>
          </Link>
        </motion.div>
      </div>"""
      
    replacement_insert = f"""            <kbd className="font-mono text-2xs">⌘K</kbd>
          </Link>
        </motion.div>
        
        {tools_block_clean}</div>
      </div>"""
      
    if target_insert in content:
        content = content.replace(target_insert, replacement_insert)
        with open("frontend/src/components/AppShell.jsx", "w") as f:
            f.write(content)
        print("Moved Workspace Tools to top")
    else:
        print("Failed to find insert target")
else:
    print("Failed to find tools block")
