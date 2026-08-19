import re

with open('frontend/src/pages/ChatPage.jsx', 'r') as f:
    content = f.read()

content = re.sub(r'import { VoiceModePanel } from \'../components/VoiceModePanel\'\n', '', content)
content = re.sub(r'<VoiceModePanel[^>]+/>', '', content)

with open('frontend/src/pages/ChatPage.jsx', 'w') as f:
    f.write(content)
print("Removed VoiceModePanel from ChatPage.")
