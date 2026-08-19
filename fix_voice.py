import re

with open('frontend/src/components/VoiceModePanel.jsx', 'r') as f:
    content = f.read()

# Remove unresolved imports
content = re.sub(r'import\s+micWorkletUrl\s+from\s+[^;]+;', '', content)
content = re.sub(r'import\s+{\s*encodeWav\s*}\s+from\s+[^;]+;', '', content)
content = re.sub(r'import\s+{\s*createSileroDetector.*?}\s+from\s+[^;]+;', '', content)

# Write back
with open('frontend/src/components/VoiceModePanel.jsx', 'w') as f:
    f.write(content)

# Fix OnboardingWizard.jsx typo
with open('frontend/src/components/OnboardingWizard.jsx', 'r') as f:
    onb = f.read()
onb = onb.replace('<button\n          <button', '<button')
with open('frontend/src/components/OnboardingWizard.jsx', 'w') as f:
    f.write(onb)

print("Fixed imports and syntax error.")
