/* A fully specified first request does not need a model call just to decide
 * that it is a lesson-plan request. Keep this conservative: a vague
 * "make a lesson plan" still goes through the question path. */

export function isClearlySpecifiedPlanRequest(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  if (normalized.length < 18 || normalized.length > 12000) return false

  const asksForPlan =
    (/\b(?:make|create|build|generate|design|prepare)\b/i.test(normalized) &&
      /\b(?:lesson plans?|weekly plan|plan for the week|week of lessons?)\b/i.test(normalized)) ||
    /\bplan\s+week\s+\d+/i.test(normalized) ||
    /\b(?:build|create|generate|write)\s+(?:the\s+)?(?:complete\s+)?week\b/i.test(normalized) ||
    (/\bweek\s+\d+\b/i.test(normalized) &&
      /\b(?:monday|mon(?:day)?[\s,–-]+fri(?:day)?)\b/i.test(normalized))

  if (!asksForPlan) return false

  return (
    /\b(?:on|about|around|covering|focused? on|using|through|for)\s+(?!(?:a|an|the|my|this|students?|learners?)\b)[a-z0-9]/i.test(
      normalized
    ) ||
    /\b(?:chapter|unit|novel|article|argument|grammar|fractions?|ecosystems?|quadratic|vertex|rhetorical|satire|gatsby|cask|tone|voice)\b/i.test(
      normalized
    )
  )
}
