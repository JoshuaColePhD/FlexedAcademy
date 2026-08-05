import re

with open('frontend/src/styles/components.css', 'r') as f:
    css = f.read()

# Patch btn-new-plan-text
new_btn = """
.btn-new-plan-text {
  font-family: var(--font-ui);
  font-size: var(--fs-sm);
  color: var(--accent-on);
  background: var(--accent-gradient);
  border: none;
  border-radius: var(--r-full);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  cursor: pointer;
  padding: var(--sp-2) var(--sp-4);
  transition: transform var(--t-fast) var(--ease-spring), box-shadow var(--t-fast) var(--ease);
  font-weight: var(--fw-semibold);
  box-shadow: var(--shadow-sm);
}
.btn-new-plan-text:hover {
  transform: translateY(-1px);
  box-shadow: var(--shadow-md);
}
"""
css = re.sub(
    r'\.btn-new-plan-text \{.*?\.btn-new-plan-text:hover \{.*?\}',
    new_btn.strip(),
    css,
    flags=re.DOTALL
)

# Patch input / select
new_input = """
.input,
.select {
  width: 100%;
  font-family: var(--font-ui);
  font-size: var(--fs-sm);
  color: var(--ink-strong);
  background: var(--paper-canvas);
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  padding: var(--sp-2) var(--sp-3);
  transition: border-color var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
}
.input:hover,
.select:hover {
  background: var(--paper-raised);
}
.input:focus,
.select:focus {
  outline: none;
  background: var(--paper-raised);
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-ring);
}
.input::placeholder {
  color: var(--ink-muted);
}
"""
css = re.sub(
    r'\.input,\s*\.select \{.*?\.input::placeholder \{.*?\}',
    new_input.strip(),
    css,
    flags=re.DOTALL
)

# Patch sidebar-nav
new_nav = """
.sidebar-nav {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: var(--sp-2);
  border-top: 1px solid var(--rule-hair);
  margin-top: var(--sp-2);
}
"""
css = re.sub(
    r'\.sidebar-nav \{.*?\}',
    new_nav.strip(),
    css,
    flags=re.DOTALL
)

with open('frontend/src/styles/components.css', 'w') as f:
    f.write(css)

