import { Cat, Dog, Rocket, Ghost, Coffee, Star, Heart, Moon, Sun, Anchor, Bug, Sparkles, Smile, Flower2, Zap } from 'lucide-react'

export const AVATAR_OPTIONS = [
  { id: 'cat', icon: Cat, label: 'Cat', bg: 'bg-orange-500', color: 'text-white' },
  { id: 'dog', icon: Dog, label: 'Dog', bg: 'bg-amber-600', color: 'text-white' },
  { id: 'rocket', icon: Rocket, label: 'Rocket', bg: 'bg-blue-500', color: 'text-white' },
  { id: 'ghost', icon: Ghost, label: 'Ghost', bg: 'bg-purple-500', color: 'text-white' },
  { id: 'coffee', icon: Coffee, label: 'Coffee', bg: 'bg-amber-800', color: 'text-white' },
  { id: 'star', icon: Star, label: 'Star', bg: 'bg-yellow-400', color: 'text-white' },
  { id: 'heart', icon: Heart, label: 'Heart', bg: 'bg-pink-500', color: 'text-white' },
  { id: 'moon', icon: Moon, label: 'Moon', bg: 'bg-indigo-600', color: 'text-white' },
  { id: 'sun', icon: Sun, label: 'Sun', bg: 'bg-yellow-500', color: 'text-white' },
  { id: 'anchor', icon: Anchor, label: 'Anchor', bg: 'bg-cyan-600', color: 'text-white' },
  { id: 'bug', icon: Bug, label: 'Bug', bg: 'bg-emerald-500', color: 'text-white' },
  { id: 'sparkles', icon: Sparkles, label: 'Sparkles', bg: 'bg-fuchsia-500', color: 'text-white' },
  { id: 'smile', icon: Smile, label: 'Smile', bg: 'bg-yellow-400', color: 'text-ink' },
  { id: 'flower2', icon: Flower2, label: 'Flower', bg: 'bg-rose-400', color: 'text-white' },
  { id: 'zap', icon: Zap, label: 'Zap', bg: 'bg-yellow-500', color: 'text-white' }
]

export function getAvatar(id) {
  return AVATAR_OPTIONS.find((a) => a.id === id) || null
}
