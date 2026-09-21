/* Fast, grounded composer completions.
 *
 * Ghost text must feel immediate and must never make an opaque network request
 * for every keystroke. These candidates therefore use only context the teacher
 * can already see or has explicitly supplied: the chat's week, saved class
 * materials, and files currently attached to this turn. A small ranked set is
 * more useful than one global canned prompt and cannot invent a topic from an
 * older conversation.
 */

const documentLabel = {
  pacing_guide: 'pacing guide',
  syllabus: 'syllabus',
  curriculum_map: 'curriculum map',
}

const normalized = (value) => String(value || '').trim().toLocaleLowerCase()

const readableWeek = (week) => {
  const number = week?.week ?? week?.week_number ?? week?.number
  return number == null ? 'this week' : `Week ${String(number).padStart(2, '0')}`
}

const materialLabels = (documents = []) => [...new Set(
  documents
    .map((document) => documentLabel[document?.kind])
    .filter(Boolean)
)]

const joinLabels = (labels) => {
  if (labels.length === 1) return labels[0]
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`
  return `${labels.slice(0, -1).join(', ')}, and ${labels.at(-1)}`
}

const candidate = (id, prompt, priority) => ({ id, prompt, priority })

export function composerGhostCandidates({ week, documents = [], attachments = [], hasPlan = false, hasArtifact = false, planOpen = false, days = [], modelSuggestion = '' } = {}) {
  const weekLabel = readableWeek(week)
  const materials = materialLabels(documents)
  const freshMaterial = attachments.find((attachment) => attachment?.filename)?.filename
  const candidates = []
  const revising = hasPlan || hasArtifact || planOpen

  // This arrives asynchronously after the class context changes (never while
  // a teacher is typing). It is generated from the current week plus retrieved
  // class sources and fresh attachment text, so it can name a real unit, text,
  // or skill instead of merely naming a document type.
  // The suggestion endpoint describes a week to build, not an edit to the
  // document currently open. Keep that older prompt out of the editing surface.
  if (modelSuggestion && !planOpen) {
    candidates.push(candidate('grounded-context', modelSuggestion, 0))
  }

  // A newly attached file is the clearest current intent, so it always wins.
  // Mention its supplied filename, not extracted content: ghost text should
  // orient the request without pretending we have already interpreted a file.
  if (freshMaterial) {
    candidates.push(candidate(
      `attachment:${freshMaterial}`,
      `Use ${freshMaterial} to ${planOpen ? 'revise' : 'plan'} ${weekLabel}.`,
      1
    ))
  }

  if (planOpen) {
    const teachingDays = (Array.isArray(days) ? days : []).filter((day) =>
      !day?.no_school && !day?.pending && !day?.incomplete && ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].includes(day?.name)
    )
    const day = teachingDays.find((item) => item.name === 'Wednesday') || teachingDays[0]
    candidates.push(candidate('edit-support', day ? `Add support for ${day.name}'s lesson.` : 'Add support to this lesson.', 2))
    candidates.push(candidate('edit-check', 'Add a quick check for understanding.', 2))
  }

  if (materials.length) {
    candidates.push(candidate(
      `materials:${materials.join('|')}`,
      `${revising ? 'Revise' : 'Plan'} ${weekLabel} using the ${joinLabels(materials)}.`,
      2
    ))
  }

  candidates.push(candidate(
    revising ? `revise:${weekLabel}` : `plan:${weekLabel}`,
    revising ? `Revise the lesson plan for ${weekLabel}.` : `Plan ${weekLabel}.`,
    3
  ))

  candidates.push(planOpen
    ? candidate('edit-activity', 'Make the activity more engaging.', 4)
    : candidate('write-week', 'Write a lesson for this week.', 4))

  return candidates
}

export function pickComposerGhost(value = '', context = {}) {
  const query = normalized(value)
  const candidates = composerGhostCandidates(context)
  if (!query) return candidates[0] || null
  return candidates.find((item) => normalized(item.prompt).startsWith(query)) || null
}
