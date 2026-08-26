import re

with open("frontend/src/components/ArtifactRail.jsx", "r") as f:
    content = f.read()

# 1. Import CheckSquare
content = content.replace("  ChevronRight,\n  Download,", "  CheckSquare,\n  ChevronRight,\n  Download,")

# 2. Add the AgentSkeleton component at the end of the file
skeleton_component = """

function AgentSkeleton() {
  const [mousePos, setMousePos] = useState({ x: -1000, y: -1000 });

  const handleMouseMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setMousePos({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  };

  const handleMouseLeave = () => {
    setMousePos({ x: -1000, y: -1000 });
  };

  return (
    <div 
      className="relative flex flex-col w-full h-full select-none overflow-hidden group"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {/* Background logo watermark */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-0">
        <CheckSquare size={200} className="text-edge/30" />
      </div>

      {/* Dynamic Cursor Spotlight */}
      <div 
        className="pointer-events-none absolute inset-0 z-0 transition-opacity duration-300 opacity-0 group-hover:opacity-100"
        style={{
          background: `radial-gradient(400px circle at ${mousePos.x}px ${mousePos.y}px, rgba(var(--accent-rgb), 0.08), transparent 40%)`
        }}
      />

      <div className="relative z-10 flex flex-col h-full pl-6 pt-10">
        {/* The Vertical "Wire" */}
        <div className="absolute left-[35px] top-12 bottom-20 w-[2px] bg-edge/40 border-l border-dashed border-edge" />
        
        {/* Nodes */}
        {[
          { label: "Understand curriculum", width: "w-3/4", delay: "delay-0" },
          { label: "Draft week structure", width: "w-1/2", delay: "delay-[150ms]" },
          { label: "Align standards", width: "w-5/6", delay: "delay-[300ms]" },
          { label: "Generate assignments", width: "w-2/3", delay: "delay-[500ms]" },
          { label: "Finalize lesson plan", width: "w-1/2", delay: "delay-[700ms]" }
        ].map((node, i) => (
          <div key={i} className={`flex items-start gap-6 mb-12 opacity-60 animate-pulse ${node.delay}`}>
            {/* The Node Dot */}
            <div className="relative z-10 w-3.5 h-3.5 rounded-full bg-paper border-2 border-edge mt-1 shadow-[0_0_8px_rgba(var(--neo-light-rgb),0.5)]" />
            
            {/* The Node Content (Wireframe blocks) */}
            <div className="flex flex-col gap-3 flex-1 pt-0.5">
              <div className="h-5 w-1/3 border border-edge border-dashed rounded-md bg-paper-sunken/40" />
              <div className={`h-3 ${node.width} border border-edge rounded bg-paper-sunken/30`} />
              {i % 2 === 0 && <div className="h-3 w-[85%] border border-edge rounded bg-paper-sunken/30" />}
            </div>
          </div>
        ))}
      </div>
      
      {/* Floating suggestion pill */}
      <div className="absolute bottom-8 left-0 right-0 flex justify-center pointer-events-none z-10">
        <div className="bg-paper-sunken/60 backdrop-blur-md border border-edge/80 shadow-sm text-xs text-ink-muted px-5 py-2.5 rounded-full font-medium tracking-wide neo-inset">
          Awaiting instructions...
        </div>
      </div>
    </div>
  );
}
"""

content += skeleton_component

# 3. Replace the old wireframe with <AgentSkeleton />
target_wireframe_start = '<div className="flex flex-col gap-6 p-4 w-full opacity-60 pointer-events-none select-none">'
target_wireframe_end = """          </div>
        </div>
      )}

      {/* Quizzes over this plan"""

# Use regex to find and replace the wireframe block
pattern = re.compile(re.escape(target_wireframe_start) + r'.*?' + r'\s+</div>\s+\)\}\s+\{\/\* Quizzes over this plan', re.DOTALL)

replacement = """<AgentSkeleton />
      )}

      {/* Quizzes over this plan"""

if pattern.search(content):
    content = pattern.sub(replacement, content)
    with open("frontend/src/components/ArtifactRail.jsx", "w") as f:
        f.write(content)
    print("Patched ArtifactRail.jsx successfully")
else:
    print("Could not find wireframe block")

