import os

file_path = "frontend/src/pages/ChatPage.jsx" # wait, composer is in frontend/src/components/Composer.jsx
file_path = "frontend/src/components/Composer.jsx"
if os.path.exists(file_path):
    with open(file_path, "r") as f:
        content = f.read()

    # 1. Update placeholder
    content = content.replace("placeholder = 'What are you teaching?',", "placeholder = 'What are you teaching? (Press ⌘K for actions)',")
    
    # 2. Add drag and drop state and handlers
    state_block = "const [isAttaching, setIsAttaching] = useState(false)\n  const [isDragging, setIsDragging] = useState(false)"
    content = content.replace("const [isAttaching, setIsAttaching] = useState(false)", state_block)
    
    drag_handlers = """
  const handleDragOver = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  const handleDragLeave = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  const handleDrop = async (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    setIsAttaching(true)
    try {
      const data = await api.extractText(file)
      setAttachments((prev) => [...prev, data])
      toast.success(`Attached ${data.filename}`, `${data.chars.toLocaleString()} characters`)
    } catch (err) {
      toast.error(`Could not read ${file.name}`, err.hint || err.message)
    } finally {
      setIsAttaching(false)
    }
  }

  const hasContent = value.trim().length > 0 || attachments.length > 0
"""
    content = content.replace("const hasContent = value.trim().length > 0 || attachments.length > 0", drag_handlers)

    # 3. Add drag events and overlay to the wrapper div
    wrapper_target = """<div
        className={`composer-shell relative flex w-full flex-col overflow-hidden border border-edge bg-paper-raised transition-all ${
          voiceModeActive ? 'rounded-3xl' : 'rounded-xl'
        }`}
        ref={wrapperRef}
      >"""
    
    wrapper_replacement = """<div
        className={`composer-shell relative flex w-full flex-col overflow-hidden border border-edge bg-paper-raised transition-all ${
          voiceModeActive ? 'rounded-3xl' : 'rounded-xl'
        } ${isDragging ? 'ring-2 ring-accent' : ''}`}
        ref={wrapperRef}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDragging && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-paper-raised/90 backdrop-blur-sm rounded-inherit">
            <p className="text-sm font-semibold text-accent-text flex items-center gap-2">
              <Upload size={16} /> Drop file to attach
            </p>
          </div>
        )}"""
    
    content = content.replace(wrapper_target, wrapper_replacement)

    # Ensure Upload icon is imported from lucide-react
    if "Upload" not in content and "lucide-react" in content:
        content = content.replace("import {", "import { Upload,", 1)

    with open(file_path, "w") as f:
        f.write(content)

print("Composer updated with drag-and-drop and Cmd+K hint.")
