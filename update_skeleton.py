import re

with open("frontend/src/components/ArtifactRail.jsx", "r") as f:
    content = f.read()

# Define the new skeleton component
new_skeleton = """
function AccordionSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-4 w-full select-none">
      {[
        {
          title: "Week Overview",
          desc: "Core objectives, daily breakdown, and standards for this week will appear here."
        },
        {
          title: "Materials & Resources",
          desc: "Worksheets, reading texts, and slide decks generated for this plan."
        },
        {
          title: "Assessments",
          desc: "Quizzes, rubrics, and exit tickets tied to this week's instruction."
        }
      ].map((card, i) => (
        <div 
          key={i} 
          className="bg-paper-sunken border border-edge rounded-2xl p-5 flex flex-col gap-3 transition-opacity duration-300"
        >
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-ink">{card.title}</span>
            <ChevronDown size={16} className="text-ink-muted" />
          </div>
          <p className="text-[13px] text-ink-muted/80 leading-relaxed pr-4">
            {card.desc}
          </p>
        </div>
      ))}
    </div>
  );
}
"""

# We need to replace the old AgentSkeleton with this new one.
# First, remove AgentSkeleton definition
agent_skeleton_pattern = re.compile(r'function AgentSkeleton\(\).*?\}\n', re.DOTALL)
content = agent_skeleton_pattern.sub(new_skeleton, content)

# Also replace `<AgentSkeleton />` with `<AccordionSkeleton />` in the render
content = content.replace("<AgentSkeleton />", "<AccordionSkeleton />")

with open("frontend/src/components/ArtifactRail.jsx", "w") as f:
    f.write(content)

print("Replaced skeleton successfully")
