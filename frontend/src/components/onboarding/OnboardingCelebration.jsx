import { BookOpen, Check, Sparkles, Star } from 'lucide-react'
import { useReducedMotion } from 'framer-motion'

// Bounded, decorative motion: no timers, random render values, or input blocking.
// Reduced-motion users get the same emblem and copy without the confetti.
export function OnboardingCelebration({ complete = false }) {
  const reducedMotion = useReducedMotion()
  return (
    <div className="onboarding-celebration" data-complete={complete} aria-hidden="true">
      <div className="onboarding-celebration-halo" />
      <span className="onboarding-celebration-spark"><Sparkles size={26} /></span>
      <span className="onboarding-celebration-star"><Star size={18} /></span>
      <div className="onboarding-celebration-emblem">
        {complete ? <Check size={48} strokeWidth={2.5} /> : <BookOpen size={38} strokeWidth={1.6} />}
      </div>
      {!reducedMotion && Array.from({ length: complete ? 32 : 12 }, (_, i) => {
        const angle = (i / (complete ? 32 : 12)) * Math.PI * 2
        const radius = (complete ? 105 : 70) + (i % 4) * 13
        return <i key={i} className="onboarding-confetti" style={{
          '--confetti-x': `${Math.cos(angle) * radius}px`,
          '--confetti-y': `${Math.sin(angle) * radius * 0.6}px`,
          '--confetti-turn': `${(i % 2 ? 1 : -1) * (120 + i * 23)}deg`,
          animationDelay: `${0.15 + (i % 5) * 0.07}s`,
        }} />
      })}
    </div>
  )
}
