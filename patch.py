import re

with open('frontend/src/pages/ChatPage.jsx', 'r') as f:
    text = f.read()

# Add imports
text = text.replace("import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'", "import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'")
text = text.replace("import { ClassSwitcher } from '../components/ClassSwitcher'", "import { ClassSwitcher } from '../components/ClassSwitcher'\nimport { Tooltip } from '../components/Tooltip'")

# Replace the entire header block starting from {classId && classId !== 'default' ... up to the end of the calendar logic
header_regex = re.compile(r"(\{classId && classId !== 'default' && classes\.length > 0 \? \(\n\s*<div className=\"flex min-w-0 shrink items-center gap-1\.5 md:gap-3\">\n\s*<ClassSwitcher[\s\S]*?disabled=\{busy\}\n\s*/>\n\s*</div>\n\s*</div>\n\s*\) : null\}\n\s*<div className=\"ml-auto flex min-w-0 items-center gap-3\">\n\s*\{calendar\?\.school\?\.name \? \(\n\s*<span className=\"hidden min-w-0 truncate text-xs font-medium text-ink-muted md:inline\">\n\s*\{calendar\.school\.name\}\n\s*</span>\n\s*\) : null\})")

new_header = """{classId && classId !== 'default' && classes.length > 0 ? (
          <div className="flex min-w-0 shrink items-center gap-1.5 md:gap-3">
            <div className="flex items-center gap-2 shrink min-w-0">
              <ClassSwitcher
                classes={classes}
                activeClass={activeClass}
                classPath={`/c/${classId}`}
                inline
              />
              {!hasPacingGuide ? (
                <Tooltip
                  interactive
                  position="bottom"
                  content={
                    <span>
                      No pacing guide on file.{' '}
                      <Link
                        to={`/c/${classId}/settings`}
                        className="underline transition-colors hover:text-white"
                      >
                        Upload one
                      </Link>
                    </span>
                  }
                >
                  <div className="h-2 w-2 shrink-0 cursor-default rounded-full bg-red-500" aria-hidden="true" />
                </Tooltip>
              ) : null}
            </div>
          </div>
        ) : null}
        <div className="ml-auto flex min-w-0 items-center gap-3">
          {classId && classId !== 'default' && classes.length > 0 ? (
            <div className="min-w-0 shrink">
              <WeekPicker
                options={weekOptions}
                value={conversationWeek}
                onChange={changeWeek}
                schoolName={calendar?.school?.name}
                disabled={busy}
              />
            </div>
          ) : null}
          {calendar?.school?.name ? (
            !calendar.school.has_calendar ? (
              <Tooltip
                interactive
                position="bottom"
                content={
                  <span>
                    No calendar on file.{' '}
                    <Link
                      to={`/c/${classId}/settings`}
                      className="underline transition-colors hover:text-white"
                    >
                      Upload one in settings
                    </Link>
                  </span>
                }
              >
                <div className="hidden min-w-0 cursor-default items-center gap-2 md:flex">
                  <span className="truncate text-xs font-medium text-ink-muted">
                    {calendar.school.name}
                  </span>
                  <div 
                    className="h-2 w-2 shrink-0 rounded-full bg-red-500"
                    aria-hidden="true"
                  />
                </div>
              </Tooltip>
            ) : (
              <span className="hidden min-w-0 truncate text-xs font-medium text-ink-muted md:inline">
                {calendar.school.name}
              </span>
            )
          ) : null}"""

if header_regex.search(text):
    text = header_regex.sub(new_header, text)
    with open('frontend/src/pages/ChatPage.jsx', 'w') as f:
        f.write(text)
    print("Patched ChatPage successfully")
else:
    print("Could not find regex match")
