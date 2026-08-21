import React, { useEffect, useState } from 'react'
import { Command } from 'cmdk'
import { useNavigate } from 'react-router-dom'
import { Settings, ShieldCheck, History, BookOpen, Plus, Calendar, Sparkles } from 'lucide-react'
import { useActiveClass, useCalendar } from '../hooks/useAppData'
import { getContextualSuggestions } from '../lib/contextualSuggestions'

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const { activeClass } = useActiveClass()
  const { data: calendar } = useCalendar(activeClass?.id)
  const currentWeek = calendar?.weeks?.find((week) => week.is_current) || null
  const suggestions = activeClass && calendar
    ? getContextualSuggestions({
        activeClass,
        calendar,
        activeChat: currentWeek?.chat_id ? { id: currentWeek.chat_id } : null,
        conversationWeek: currentWeek?.week,
        effectiveWeek: currentWeek?.week,
        artifact: currentWeek?.has_plan || currentWeek?.status === 'built' ? { planId: 'current-plan' } : null,
        surface: 'palette',
      })
    : []

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

  const runSuggestion = (suggestion) => {
    if (suggestion.action === 'open-settings') {
      navigate('/settings')
      return
    }
    if ((suggestion.action === 'open-chat' || suggestion.action === 'review-plan') && suggestion.chatId) {
      navigate(`/c/${activeClass.id}/chat/${suggestion.chatId}`)
      return
    }
    navigate(`/c/${activeClass.id}${suggestion.weekNumber ? `?week=${suggestion.weekNumber}` : ''}`)
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

          {suggestions.length > 0 ? (
            <Command.Group heading="Suggested for this class" className="text-xs font-medium text-ink-muted px-2 py-1.5 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1.5">
              {suggestions.map((suggestion) => (
                <Command.Item
                  key={suggestion.id}
                  value={`${suggestion.label} ${suggestion.reason}`}
                  onSelect={() => runCommand(() => runSuggestion(suggestion))}
                  className="flex items-start gap-2 rounded-md px-2 py-2 text-sm text-ink cursor-pointer aria-selected:bg-paper-sunken aria-selected:text-ink"
                >
                  <Sparkles size={16} className="mt-0.5 shrink-0 text-accent" />
                  <span className="min-w-0">
                    <span className="block font-medium">{suggestion.label}</span>
                    <span className="block text-xs font-normal text-ink-muted">{suggestion.reason}</span>
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
          ) : null}

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
