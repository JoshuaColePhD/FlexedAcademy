import re

with open("frontend/src/styles/base.css", "r") as f:
    content = f.read()

target = """    /* Curved like other panels */
    border: 1px solid var(--edge);
    border-radius: var(--radius-2xl);
    box-shadow: var(--shadow-sm);
    background: var(--paper);
    padding: var(--sp-4) 14px;
    /* Same reasoning as .app-rail's own shadow, mirrored — this panel sits
       on the chat's OTHER side, so the step-down reads on its left edge
       instead of its right. */
    box-shadow: -5px 0 12px rgb(var(--neo-dark-rgb) / 0.35);"""

replacement = """    /* Unified flat layout */
    border-left: 1px solid rgba(var(--edge-rgb), 0.5);
    padding: var(--sp-4) 14px;"""

if target in content:
    content = content.replace(target, replacement)
    with open("frontend/src/styles/base.css", "w") as f:
        f.write(content)
    print("Updated base.css")
else:
    print("Could not find exact block in base.css")

