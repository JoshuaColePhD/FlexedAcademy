with open("frontend/src/components/ArtifactRail.jsx", "r") as f:
    content = f.read()

target = """      ) : (
        <div className="flex flex-col gap-6 p-4 w-full opacity-60 pointer-events-none select-none">
          {/* Wireframe Header */}
          <div className="flex flex-col gap-3 border-b border-edge/50 pb-5">
            <div className="h-6 w-1/3 border-2 border-edge border-dashed rounded-md animate-pulse" />
            <div className="h-10 w-3/4 border-2 border-edge rounded-lg animate-pulse" />
          </div>
          
          {/* Wireframe Section 1 */}
          <div className="flex flex-col gap-3">
            <div className="h-6 w-1/4 border-2 border-edge border-dashed rounded-md animate-pulse mb-1" />
            <div className="h-4 w-full border border-edge rounded animate-pulse" />
            <div className="h-4 w-[90%] border border-edge rounded animate-pulse" />
            <div className="h-4 w-[75%] border border-edge rounded animate-pulse" />
          </div>

          {/* Wireframe Cards */}
          <div className="grid grid-cols-2 gap-3 mt-2">
            <div className="h-24 border-2 border-edge border-dashed rounded-xl flex items-center justify-center animate-pulse">
              <div className="h-8 w-8 border border-edge rounded-md" />
            </div>
            <div className="h-24 border-2 border-edge border-dashed rounded-xl flex items-center justify-center animate-pulse">
              <div className="h-8 w-8 border border-edge rounded-md" />
            </div>
          </div>
          
          {/* Wireframe Section 2 */}
          <div className="flex flex-col gap-3 mt-2">
            <div className="h-6 w-1/3 border-2 border-edge border-dashed rounded-md animate-pulse mb-1" />
            <div className="h-4 w-full border border-edge rounded animate-pulse" />
            <div className="h-4 w-[85%] border border-edge rounded animate-pulse" />
          </div>
        </div>
      )}"""

replacement = """      ) : (
        <AccordionSkeleton />
      )}"""

if target in content:
    content = content.replace(target, replacement)
else:
    print("Failed to find target block")
    exit(1)

# Add component to end
accordion_component = """

function AccordionSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-4 w-full select-none opacity-60 pointer-events-none">
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
            <span className="text-[13px] font-semibold text-ink">{card.title}</span>
            <ChevronDown size={14} className="text-ink-muted" />
          </div>
          <p className="text-[12px] text-ink-muted/90 leading-relaxed pr-4">
            {card.desc}
          </p>
        </div>
      ))}
    </div>
  );
}
"""

content += accordion_component

with open("frontend/src/components/ArtifactRail.jsx", "w") as f:
    f.write(content)

print("Replaced with AccordionSkeleton")
