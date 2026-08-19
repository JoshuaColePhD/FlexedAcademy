import re

with open('frontend/src/pages/ChatPage.jsx', 'r') as f:
    content = f.read()

handler = """
  // Proactively mutate UI from WebRTC data channel events!
  useEffect(() => {
    const handler = async (e) => {
      if (e.detail.name === 'update_lesson_plan') {
        const { day_index, field, content } = e.detail.args
        if (artifact?.planId && artifact?.plan?.days) {
          const newDays = [...artifact.plan.days]
          if (newDays[day_index]) {
            newDays[day_index] = { ...newDays[day_index], [field]: content }
            setArtifact(prev => ({ ...prev, plan: { ...prev.plan, days: newDays } }))
            try {
              await api.updateDay(artifact.planId, day_index, { field, content })
            } catch (err) {
               console.error("Failed to save day update", err)
            }
          }
        }
      }
    }
    window.addEventListener('voice:tool_call', handler)
    return () => window.removeEventListener('voice:tool_call', handler)
  }, [artifact])
"""

content = content.replace('  /* The clarification the conversation is currently waiting on, if any.', handler + '\n  /* The clarification the conversation is currently waiting on, if any.')

with open('frontend/src/pages/ChatPage.jsx', 'w') as f:
    f.write(content)
print("Added tool handler.")
