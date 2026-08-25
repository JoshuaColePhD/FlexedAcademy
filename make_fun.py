import re

with open('frontend/src/components/OnboardingWizard.jsx', 'r') as f:
    content = f.read()

# 1. Update StepHeader
old_step_header = """function StepHeader({ eyebrow, title, body }) {
  return (
    <div className="mb-6">
      {eyebrow ? <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-accent">{eyebrow}</p> : null}
      <h2 className="text-xl font-bold text-ink">{title}</h2>
      {body ? <p className="mt-1 text-sm text-ink-soft">{body}</p> : null}
    </div>
  )
}"""

new_step_header = """function StepHeader({ eyebrow, currentStep, totalSteps, title, body }) {
  return (
    <div className="mb-6">
      {totalSteps > 0 && currentStep > 0 ? (
        <div className="mb-4 h-1.5 w-full bg-edge rounded-full overflow-hidden">
          <motion.div 
            className="h-full bg-accent" 
            initial={{ width: 0 }}
            animate={{ width: `${(currentStep / totalSteps) * 100}%` }}
            transition={{ type: "spring", stiffness: 50, damping: 15 }}
          />
        </div>
      ) : eyebrow ? (
        <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-accent">{eyebrow}</p>
      ) : null}
      <h2 className="text-xl font-bold text-ink">{title}</h2>
      {body ? <p className="mt-1 text-sm text-ink-soft">{body}</p> : null}
    </div>
  )
}"""
content = content.replace(old_step_header, new_step_header)

# 2. Update Wizard step index calculations
content = content.replace(
    "const eyebrow = formIndex >= 0 ? `Step ${formIndex + 1} of ${formSteps.length}` : null",
    """const eyebrow = formIndex >= 0 ? `Step ${formIndex + 1} of ${formSteps.length}` : null
  const currentStep = formIndex >= 0 ? formIndex + 1 : 0
  const totalSteps = formSteps.length"""
)

# Replace all `<StepHeader eyebrow={eyebrow}` with `<StepHeader eyebrow={eyebrow} currentStep={currentStep} totalSteps={totalSteps}` in the wizard body.
# Actually I'll just replace them individually because they are passed down to step components.
content = content.replace("eyebrow={eyebrow}", "eyebrow={eyebrow} currentStep={currentStep} totalSteps={totalSteps}")
# Wait, some components expect eyebrow but not currentStep/totalSteps. Let's update the props of the step components.

def update_step_props(step_name):
    global content
    content = content.replace(f"function {step_name}({{ eyebrow,", f"function {step_name}({{ eyebrow, currentStep, totalSteps,")
    # update the internal StepHeader call
    content = re.sub(
        r'<StepHeader\s*\n\s*eyebrow=\{eyebrow\}\s*\n',
        '<StepHeader\n        eyebrow={eyebrow}\n        currentStep={currentStep}\n        totalSteps={totalSteps}\n',
        content
    )

content = content.replace("function SchoolStep({\n  eyebrow,", "function SchoolStep({\n  eyebrow,\n  currentStep,\n  totalSteps,")
content = content.replace("function ClassStep({\n  eyebrow,", "function ClassStep({\n  eyebrow,\n  currentStep,\n  totalSteps,")
content = content.replace("function DocumentsStep({ eyebrow,", "function DocumentsStep({ eyebrow, currentStep, totalSteps,")
content = content.replace("function TipsStep({ eyebrow,", "function TipsStep({ eyebrow, currentStep, totalSteps,")

content = content.replace(
    """<StepHeader
        eyebrow={eyebrow}
        title="Where are we teaching?"
        body="Sets your school calendar — which weeks are teaching weeks and which days are closed."
      />""",
    """<StepHeader
        eyebrow={eyebrow}
        currentStep={currentStep}
        totalSteps={totalSteps}
        title="Let’s get you on the map. Where are you teaching this year?"
        body="This pulls in your school's calendar so you don't have to map out teaching weeks from scratch."
      />"""
)

content = content.replace(
    """<StepHeader
        eyebrow={eyebrow}
        title={<span>Confirm {cls.name || 'your class'}</span>}
        body="The course decides which standards get retrieved. Change it any time from My Classes."
      />""",
    """<StepHeader
        eyebrow={eyebrow}
        currentStep={currentStep}
        totalSteps={totalSteps}
        title={<span>What are we teaching? Let's get {cls.name || 'this class'} set up.</span>}
        body="The course tells the AI which standards to pull. You can always change this later."
      />"""
)

content = content.replace(
    """<StepHeader
        eyebrow={eyebrow}
        title="Ground it in your materials"
        body="A pacing guide, syllabus, or curriculum map lets plans follow YOUR sequence and units, not a generic one. Optional — add these anytime from My Classes."
      />""",
    """<StepHeader
        eyebrow={eyebrow}
        currentStep={currentStep}
        totalSteps={totalSteps}
        title="Ground it in your materials"
        body="Got a syllabus, pacing guide, or curriculum map? Toss it here so your plans follow YOUR sequence, not a generic one. Optional — add these anytime from My Classes."
      />"""
)

content = content.replace(
    """<StepHeader eyebrow={eyebrow} title="Getting the most out of FlexEd" />""",
    """<StepHeader eyebrow={eyebrow} currentStep={currentStep} totalSteps={totalSteps} title="Getting the most out of FlexEd" />"""
)

# 3. Add motion.div to template and calendar in SchoolStep
content = content.replace(
    """      {school ? (
        <div className="mt-4 rounded-lg border border-edge bg-paper-sunken p-4 text-sm text-ink-soft">""",
    """      {school ? (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mt-4 rounded-lg border border-edge bg-paper-sunken p-4 text-sm text-ink-soft">"""
)

content = content.replace(
    """              <span className="font-medium text-ink">No lesson-plan template on file yet</span> for this
              school. If you have a blank one (a Word doc or PDF), upload it and we’ll train the AI to
              export in your district’s exact format.""",
    """              <span className="font-medium text-ink">Got a rigid district lesson plan format?</span> Toss it here, and the AI will handle the formatting for you."""
)

content = content.replace(
    """              <span className="font-medium text-ink">A standard lesson-plan template is already on file</span> for this
              school. You will automatically use this standard template, but you can upload your own below to override it for your classes.""",
    """              <span className="font-medium text-ink">A standard lesson-plan template is already on file</span> for this
              school. You will automatically use this standard template, but you can upload your own below to override it for your classes."""
)

content = content.replace(
    """                onChange={(e) => {
                  setTemplateUrl(e.target.value)
                  if (e.target.value) setTemplateFile(null)
                }}
              />
            </div>
          </div>
        </div>
      ) : null}""",
    """                onChange={(e) => {
                  setTemplateUrl(e.target.value)
                  if (e.target.value) setTemplateFile(null)
                }}
              />
            </div>
          </div>
        </motion.div>
      ) : null}"""
)

content = content.replace(
    """      {school && schools.find(s => s.id === school)?.has_pending_calendar ? (
        <div className="mt-6">
          <h3 className="text-sm font-medium text-ink mb-2">Verify School Calendar</h3>
          <PendingCalendarReview schoolId={school} />
        </div>
      ) : school && schools.find(s => s.id === school)?.has_calendar ? (
        <div className="mt-6">
          <h3 className="text-sm font-medium text-ink mb-2">School Calendar</h3>
          <ConfirmedCalendarReview schoolId={school} />
        </div>
      ) : null}""",
    """      {school && schools.find(s => s.id === school)?.has_pending_calendar ? (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mt-6">
          <h3 className="text-sm font-medium text-ink mb-2">Look at that! A colleague already did the heavy lifting and set up the calendar. Look right to you?</h3>
          <PendingCalendarReview schoolId={school} />
        </motion.div>
      ) : school && schools.find(s => s.id === school)?.has_calendar ? (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mt-6">
          <h3 className="text-sm font-medium text-ink mb-2">School Calendar</h3>
          <ConfirmedCalendarReview schoolId={school} />
        </motion.div>
      ) : null}"""
)

with open('frontend/src/components/OnboardingWizard.jsx', 'w') as f:
    f.write(content)

