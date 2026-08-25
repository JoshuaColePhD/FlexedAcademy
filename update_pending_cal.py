with open('frontend/src/components/PendingCalendarReview.jsx', 'r') as f:
    content = f.read()

content = content.replace("import { useState } from 'react'", "import { useState } from 'react'\nimport { motion } from 'framer-motion'")

old_buttons = """        <div className="mt-2 flex gap-2">
          <button
            type="button"
            disabled={deciding}
            onClick={() => decide('confirm')}
            className="btn text-2xs disabled:cursor-not-allowed disabled:opacity-50"
          >
            Looks right
          </button>
          <button
            type="button"
            disabled={deciding}
            onClick={() => decide('reject')}
            className="btn text-2xs disabled:cursor-not-allowed disabled:opacity-50"
          >
            Doesn't match
          </button>
        </div>"""

new_buttons = """        <div className="mt-3 flex gap-2">
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            type="button"
            disabled={deciding}
            onClick={() => decide('confirm')}
            className="btn btn-primary text-2xs font-semibold disabled:cursor-not-allowed disabled:opacity-50 shadow-sm"
          >
            Looks right
          </motion.button>
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            type="button"
            disabled={deciding}
            onClick={() => decide('reject')}
            className="btn text-2xs disabled:cursor-not-allowed disabled:opacity-50"
          >
            Doesn't match
          </motion.button>
        </div>"""

content = content.replace(old_buttons, new_buttons)

with open('frontend/src/components/PendingCalendarReview.jsx', 'w') as f:
    f.write(content)

