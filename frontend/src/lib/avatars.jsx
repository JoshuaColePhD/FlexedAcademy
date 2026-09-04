// Real emoji, not Lucide icon glyphs — that was the actual intent of the
// "Profile Icon" picker (SettingsPage.jsx's AvatarSelect) from the start;
// it shipped rendering these as monochrome SVG icons instead. `id` values
// are unchanged so every teacher's already-stored `user.avatar` selection
// (a plain id string) keeps meaning the same thing — this is a rendering
// fix, not a re-pick.
export const AVATAR_OPTIONS = [
  { id: 'cat', emoji: '🐱', label: 'Cat', bg: 'bg-orange-500' },
  { id: 'dog', emoji: '🐶', label: 'Dog', bg: 'bg-amber-600' },
  { id: 'rocket', emoji: '🚀', label: 'Rocket', bg: 'bg-blue-500' },
  { id: 'ghost', emoji: '👻', label: 'Ghost', bg: 'bg-purple-500' },
  { id: 'coffee', emoji: '☕', label: 'Coffee', bg: 'bg-amber-800' },
  { id: 'star', emoji: '⭐', label: 'Star', bg: 'bg-yellow-400' },
  { id: 'heart', emoji: '❤️', label: 'Heart', bg: 'bg-pink-500' },
  { id: 'moon', emoji: '🌙', label: 'Moon', bg: 'bg-indigo-600' },
  { id: 'sun', emoji: '☀️', label: 'Sun', bg: 'bg-yellow-500' },
  { id: 'anchor', emoji: '⚓', label: 'Anchor', bg: 'bg-cyan-600' },
  { id: 'bug', emoji: '🐛', label: 'Bug', bg: 'bg-emerald-500' },
  { id: 'sparkles', emoji: '✨', label: 'Sparkles', bg: 'bg-fuchsia-500' },
  { id: 'smile', emoji: '😊', label: 'Smile', bg: 'bg-yellow-400' },
  { id: 'flower2', emoji: '🌸', label: 'Flower', bg: 'bg-rose-400' },
  { id: 'zap', emoji: '⚡', label: 'Zap', bg: 'bg-yellow-500' },
  { id: 'book', emoji: '📚', label: 'Books', bg: 'bg-indigo-500' },
  { id: 'panda', emoji: '🐼', label: 'Panda', bg: 'bg-slate-500' },
  { id: 'owl', emoji: '🦉', label: 'Owl', bg: 'bg-violet-500' },
  { id: 'fox', emoji: '🦊', label: 'Fox', bg: 'bg-orange-500' },
  { id: 'mushroom', emoji: '🍄', label: 'Mushroom', bg: 'bg-red-500' },
  { id: 'palette', emoji: '🎨', label: 'Palette', bg: 'bg-pink-500' },
  { id: 'globe', emoji: '🌎', label: 'Globe', bg: 'bg-sky-500' },
  { id: 'leaf', emoji: '🌿', label: 'Leaf', bg: 'bg-green-500' },
  { id: 'music', emoji: '🎵', label: 'Music', bg: 'bg-purple-500' },
  { id: 'telescope', emoji: '🔭', label: 'Telescope', bg: 'bg-blue-600' },
]

export function getInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return 'FE'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
}

export function getAvatar(id) {
  return AVATAR_OPTIONS.find((a) => a.id === id) || null
}
