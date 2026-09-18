// Source records come from several curriculum providers. Keep their official
// wording in storage, but do not surface old district-specific labels in the
// product UI: they imply FlexEd is limited to one locality or template.
export function displaySourceDocument(sourceDocument) {
  const source = String(sourceDocument || '').trim()
  if (!source) return 'Source document'

  if (/^alabama course of study(?::\s*ela)?(?:\s*\([^)]*\))?$/i.test(source)) {
    return 'English language arts standards'
  }
  if (/florence city schools/i.test(source)) {
    return 'Lesson-plan source'
  }

  return source
}
