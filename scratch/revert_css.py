import re

with open('frontend/src/styles/components.css', 'r') as f:
    css = f.read()

# Revert btn-new-plan-text (unused anyway, but I'll put it back)
css = re.sub(
    r'\.btn-new-plan-text \{.*?\.btn-new-plan-text:hover \{.*?\}',
    """
.btn-new-plan-text {
  font-family: "Newsreader", serif;
  font-size: var(--fs-md);
  color: var(--accent);
  background: transparent;
  border: none;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  cursor: pointer;
  padding: 0;
  transition: opacity var(--t-fast) var(--ease), transform var(--t-fast) var(--ease-spring);
  font-weight: 500;
  font-style: italic;
  width: 100%;
}
.btn-new-plan-text:hover {
  opacity: 0.8;
  transform: translateX(4px);
}
""".strip(),
    css,
    flags=re.DOTALL
)

# Revert input / select
css = re.sub(
    r'\.input,\s*\.select \{.*?\.input::placeholder \{.*?\}',
    """
.input,
.select {
  width: 100%;
  font-family: var(--font-ui);
  font-size: var(--fs-sm);
  color: var(--ink-strong);
  background: var(--paper-raised);
  border: 1px solid var(--rule);
  border-radius: var(--r-sm);
  padding: var(--sp-2) var(--sp-3);
  transition: border-color var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease);
}
.input:focus,
.select:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-ring);
}
.input::placeholder {
  color: var(--ink-muted);
}
""".strip(),
    css,
    flags=re.DOTALL
)

# Revert sidebar-nav
css = re.sub(
    r'\.sidebar-nav \{.*?\}',
    """
.sidebar-nav {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: var(--sp-2);
}
""".strip(),
    css,
    flags=re.DOTALL
)

with open('frontend/src/styles/components.css', 'w') as f:
    f.write(css)

with open('frontend/src/styles/my-class.css', 'r') as f:
    mc = f.read()

mc = mc.replace('background-color: var(--paper-canvas);', 'background-color: var(--page-bg);')
mc = mc.replace(""".settings-card {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--r-xl);
  padding: var(--sp-6);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  box-shadow: var(--shadow-sm);""", """.settings-card {
  background: var(--surface-float);
  border: 1px solid var(--border-soft);
  border-radius: var(--rd-lg);
  padding: var(--sp-6);
  backdrop-filter: blur(12px);
  box-shadow: var(--shadow-sm);""")

mc = mc.replace(""".settings-card h2 {
  font-family: var(--font-display);
  font-size: var(--fs-xl);
  color: var(--ink-strong);
  margin-bottom: var(--sp-2);
  border-bottom: 1px solid var(--rule-hair);
  padding-bottom: var(--sp-3);
}""", """.settings-card h2 {
  font-family: 'Newsreader', serif;
  font-size: 1.4rem;
  color: var(--ink-strong);
  margin-bottom: var(--sp-2);
  border-bottom: 1px solid var(--border-subtle);
  padding-bottom: var(--sp-3);
}""")

mc = mc.replace(""".action-bar {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: var(--sp-4);
  margin-top: var(--sp-8);
  padding-top: var(--sp-6);
  border-top: 1px solid var(--rule-hair);
}""", """.action-bar {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: var(--sp-4);
  margin-top: var(--sp-8);
  padding-top: var(--sp-6);
  border-top: 1px solid var(--border-soft);
}""")

with open('frontend/src/styles/my-class.css', 'w') as f:
    f.write(mc)

