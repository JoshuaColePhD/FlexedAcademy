with open('frontend/src/components/Message.jsx', 'r') as f:
    content = f.read()

time_logic = """  const timeString = useMemo(() => {
    if (!message.created_at) return ''
    try {
      return new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(message.created_at))
    } catch {
      return ''
    }
  }, [message.created_at])
"""

content = content.replace(
    "const assistantSettled = !isUser && !message.streaming && !message.isError",
    "const assistantSettled = !isUser && !message.streaming && !message.isError\n" + time_logic
)

timestamp_jsx = """        <div
          className={`mt-1 flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 ${
            isUser ? 'justify-end' : 'justify-start'
          } ${message.isError ? 'text-mark' : 'text-ink-muted'}`}
        >
          {timeString ? <span className="text-3xs tracking-wider opacity-60 mr-1">{timeString}</span> : null}"""

content = content.replace(
    """        <div
          className={`mt-1 flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 ${
            isUser ? 'justify-end' : 'justify-start'
          } ${message.isError ? 'text-mark' : 'text-ink-muted'}`}
        >""", timestamp_jsx)

with open('frontend/src/components/Message.jsx', 'w') as f:
    f.write(content)

