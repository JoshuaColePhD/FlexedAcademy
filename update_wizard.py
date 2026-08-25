import re

with open('frontend/src/components/OnboardingWizard.jsx', 'r') as f:
    content = f.read()

# 1. Add imports
content = content.replace(
    "import { SchoolSelect } from './SchoolSelect'",
    "import { SchoolSelect } from './SchoolSelect'\nimport { PendingCalendarReview } from './PendingCalendarReview'\nimport { CalendarPreview } from './CalendarPreview'"
)

# 2. Modify SchoolStep component
# Find the start of SchoolStep
school_step_start = content.find("function SchoolStep({")
school_step_end = content.find("function ClassStep({", school_step_start)
school_step_content = content[school_step_start:school_step_end]

# Modify the template block
old_template_block = """      {schoolNeedsTemplate ? (
        <div className="mt-4 rounded-lg border border-edge bg-paper-sunken p-4 text-sm text-ink-soft">
          <p>
            <span className="font-medium text-ink">No lesson-plan template on file yet</span> for this
            school. If you have a blank one (a Word doc or PDF), upload it and we’ll train the AI to
            export in your district’s exact format.
          </p>"""

new_template_block = """      {school ? (
        <div className="mt-4 rounded-lg border border-edge bg-paper-sunken p-4 text-sm text-ink-soft">
          {schoolNeedsTemplate ? (
            <p>
              <span className="font-medium text-ink">No lesson-plan template on file yet</span> for this
              school. If you have a blank one (a Word doc or PDF), upload it and we’ll train the AI to
              export in your district’s exact format.
            </p>
          ) : (
            <p>
              <span className="font-medium text-ink">A standard lesson-plan template is already on file</span> for this
              school. You will automatically use this standard template, but you can upload your own below to override it for your classes.
            </p>
          )}"""

school_step_content = school_step_content.replace(old_template_block, new_template_block)

# Add Calendar review block before the dialog actions
actions_start = school_step_content.find('<div className="dialog-actions mt-6">')

calendar_block = """
      {school && schools.find(s => s.id === school)?.has_pending_calendar ? (
        <div className="mt-6">
          <h3 className="text-sm font-medium text-ink mb-2">Verify School Calendar</h3>
          <PendingCalendarReview schoolId={school} />
        </div>
      ) : school && schools.find(s => s.id === school)?.has_calendar ? (
        <div className="mt-6">
          <h3 className="text-sm font-medium text-ink mb-2">School Calendar</h3>
          <ConfirmedCalendarReview schoolId={school} />
        </div>
      ) : null}
"""

school_step_content = school_step_content[:actions_start] + calendar_block + school_step_content[actions_start:]

content = content[:school_step_start] + school_step_content + content[school_step_end:]

# Add ConfirmedCalendarReview component at the end of the file
confirmed_calendar_component = """
function ConfirmedCalendarReview({ schoolId }) {
  const { data: submission, isLoading } = useQuery({
    queryKey: ['schoolCalendarConfirmed', schoolId],
    queryFn: () => api.getConfirmedSchoolCalendar(schoolId),
    enabled: !!schoolId,
    retry: false,
  })

  if (isLoading) return <p className="mt-2 text-xs text-ink-muted">Loading calendar...</p>
  if (!submission || !submission.weeks) return null

  return (
    <div className="mt-2 max-w-sm rounded-lg bg-ok/10 p-3 text-xs">
      <p className="font-medium text-ok mb-2">Confirmed by your colleagues</p>
      <CalendarPreview weeks={submission.weeks} />
    </div>
  )
}
"""

content += confirmed_calendar_component

with open('frontend/src/components/OnboardingWizard.jsx', 'w') as f:
    f.write(content)

