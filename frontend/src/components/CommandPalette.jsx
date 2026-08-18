import React, { useEffect, useState } from 'react'
import { Command } from 'cmdk'
import { useNavigate } from 'react-router-dom'
import { Settings, ShieldCheck, History, BookOpen, Plus, Calendar } from 'lucide-react'

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    const down = (e) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((open) => !open)
      }
    }
    document.addEventListener('keydown', down)
    return () => document.removeEventListener('keydown', down)
  }, [])

  const runCommand = (command) => {
    setOpen(false)
    command()
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Global Command Menu"
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-ink/30 backdrop-blur-sm sm:px-6 md:px-0"
    >
      <div className="w-full max-w-xl overflow-hidden rounded-xl bg-paper shadow-2xl border border-edge neo-world">
        <Command.Input
          autoFocus
          placeholder="What do you need to do?"
          className="w-full border-b border-edge bg-transparent px-4 py-4 text-sm text-ink outline-none placeholder:text-ink-faint"
        />
        <Command.List className="max-h-[60vh] overflow-y-auto p-2 scroll-smooth">
          <Command.Empty className="py-6 text-center text-sm text-ink-muted">
            No results found.
          </Command.Empty>

          <Command.Group heading="Navigation" className="text-xs font-medium text-ink-muted px-2 py-1.5 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1.5">
            <Command.Item
              onSelect={() => runCommand(() => navigate('/'))}
              className="flex items-center gap-2 rounded-md px-2 py-2 text-sm text-ink cursor-pointer aria-selected:bg-paper-sunken aria-selected:text-ink"
            >
              <BookOpen size={16} /> My Classes
            </Command.Item>
            <Command.Item
              onSelect={() => runCommand(() => navigate('/history'))}
              className="flex items-center gap-2 rounded-md px-2 py-2 text-sm text-ink cursor-pointer aria-selected:bg-paper-sunken aria-selected:text-ink"
            >
              <History size={16} /> Recent History
            </Command.Item>
            <Command.Item
              onSelect={() => runCommand(() => navigate('/settings'))}
              className="flex items-center gap-2 rounded-md px-2 py-2 text-sm text-ink cursor-pointer aria-selected:bg-paper-sunken aria-selected:text-ink"
            >
              <Settings size={16} /> Settings
            </Command.Item>
            <Command.Item
              onSelect={() => runCommand(() => navigate('/admin'))}
              className="flex items-center gap-2 rounded-md px-2 py-2 text-sm text-ink cursor-pointer aria-selected:bg-paper-sunken aria-selected:text-ink"
            >
              <ShieldCheck size={16} /> Admin Dashboard
            </Command.Item>
          </Command.Group>

          <Command.Separator className="my-1 h-px bg-edge" />

          <Command.Group heading="Actions" className="text-xs font-medium text-ink-muted px-2 py-1.5 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1.5">
            <Command.Item
              onSelect={() => runCommand(() => navigate('/'))}
              className="flex items-center gap-2 rounded-md px-2 py-2 text-sm text-ink cursor-pointer aria-selected:bg-paper-sunken aria-selected:text-ink"
            >
              <Plus size={16} /> New Lesson Plan
            </Command.Item>
            <Command.Item
              onSelect={() => runCommand(() => navigate('/settings'))}
              className="flex items-center gap-2 rounded-md px-2 py-2 text-sm text-ink cursor-pointer aria-selected:bg-paper-sunken aria-selected:text-ink"
            >
              <Calendar size={16} /> Upload School Calendar
            </Command.Item>
          </Command.Group>
        </Command.List>
      </div>
    </Command.Dialog>
  )
}
