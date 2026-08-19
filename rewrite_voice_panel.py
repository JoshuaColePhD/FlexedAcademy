import re

with open('frontend/src/components/VoiceModePanel.jsx', 'r') as f:
    content = f.read()

# I will write a script to remove the micCaptureWorklet and Silero VAD imports and effects.
print("Length before:", len(content))
