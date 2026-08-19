import re

with open('frontend/src/pages/ChatPage.jsx', 'r') as f:
    content = f.read()

# Replace <VoiceModePanel ... /> spanning multiple lines
content = re.sub(r'<VoiceModePanel[^>]*/>', '', content, flags=re.DOTALL)
content = content.replace("import { VoiceModePanel } from '../components/VoiceModePanel'", "")

with open('frontend/src/pages/ChatPage.jsx', 'w') as f:
    f.write(content)

print("Cleaned VoiceModePanel from ChatPage.")
