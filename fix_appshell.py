import re

with open('frontend/src/components/AppShell.jsx', 'r') as f:
    content = f.read()

import_str = "import { VoiceModePanel } from './VoiceModePanel'"
if import_str not in content:
    content = content.replace("import { AccountMenu } from './AccountMenu'", "import { AccountMenu } from './AccountMenu'\n" + import_str)

voice_panel = """
        <div className="px-2 pb-2">
          <VoiceModePanel />
        </div>
        <AccountMenu />
"""
if '<VoiceModePanel />' not in content:
    content = content.replace('<AccountMenu />', voice_panel)

with open('frontend/src/components/AppShell.jsx', 'w') as f:
    f.write(content)

print("Added VoiceModePanel to AppShell.")
