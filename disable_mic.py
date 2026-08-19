import re

with open('frontend/src/components/VoiceModePanel.jsx', 'r') as f:
    content = f.read()

# Mock out the missing imports at the top
mocks = """
import { useVoice } from '../lib/voiceContext'
const micWorkletUrl = "";
const encodeWav = () => null;
const createSileroDetector = () => Promise.reject();
const SPEECH_ON = 1;
const SPEECH_OFF = 0;
"""

content = content.replace("import { useFocusTrap } from '../hooks/useFocusTrap'", "import { useFocusTrap } from '../hooks/useFocusTrap'\n" + mocks)

with open('frontend/src/components/VoiceModePanel.jsx', 'w') as f:
    f.write(content)
print("Added mocks.")
