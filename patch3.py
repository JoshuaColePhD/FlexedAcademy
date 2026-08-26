with open('frontend/src/pages/ChatPage.jsx', 'r') as f:
    text = f.read()

old_target = """        {classId && classId !== 'default' && classes.length > 0 ? (
          <div className="flex min-w-0 shrink items-center gap-1.5 md:gap-3">
            <ClassSwitcher
              classes={classes}
              activeClass={activeClass}
              classPath={`/c/${classId}`}
              inline
            />
            {/* WeekPicker doesn't take a className, and .chat-week itself has
                no min-width:0 of its own (it never needed to shrink before —
                it was the only thing in this row). Wrapped so it can actually
                give ground to ClassSwitcher instead of just pushing the row
                wider. */}
            <div className="min-w-0 shrink">
              <WeekPicker
                options={weekOptions}
                value={conversationWeek}
                onChange={changeWeek}
                schoolName={calendar?.school?.name}
                disabled={busy}
              />
            </div>
          </div>
        ) : null}
        <div className="ml-auto flex min-w-0 items-center gap-3">
          {calendar?.school?.name ? (
            <span className="hidden min-w-0 truncate text-xs font-medium text-ink-muted md:inline">
              {calendar.school.name}
            </span>
          ) : null}"""

new_target = """        {classId && classId !== 'default' && classes.length > 0 ? (
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

if old_target in text:
    text = text.replace(old_target, new_target)
    with open('frontend/src/pages/ChatPage.jsx', 'w') as f:
        f.write(text)
    print("Patched ChatPage successfully")
else:
    print("Could not find old_target in text!")
