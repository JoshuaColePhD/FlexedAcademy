import re

with open('frontend/src/pages/ChatPage.jsx', 'r') as f:
    content = f.read()

content = content.replace('voice.resetSpoken()', '')
content = content.replace('voice.getSpoken()', '""')
content = content.replace('voice.enqueue(', 'voice.sendContextEvent(')
content = content.replace('voice.speak(', 'voice.sendContextEvent(')

with open('frontend/src/pages/ChatPage.jsx', 'w') as f:
    f.write(content)
print("ChatPage fixed.")
