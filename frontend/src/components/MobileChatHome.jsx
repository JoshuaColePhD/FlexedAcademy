import { Rail } from './AppShell'
import { ClassSwitcher } from './ClassSwitcher'
import { useActiveClass } from '../hooks/useAppData'

/* The phone landing screen — chats list, Workspace Tools, Settings, same
 * content as the desktop sidebar (Rail), full-screen instead of docked.
 *
 * Why this exists: a phone teacher used to land straight in an empty chat
 * (ChatPage's own Greeting), with no way back to a chat already in
 * progress short of the browser's own back button — the sidebar that
 * would normally show "your recent chats" only ever docks at >=1024px or
 * opens as a hamburger drawer, and that drawer's own trigger is
 * deliberately hidden on the chat route (AppShell.jsx), since there was
 * never anywhere for it to open OVER. ChatPage now renders this instead of
 * its own Greeting whenever `isPhone && !chatId && mobileShowHome` — see
 * its own comment on that state for the "New plan" round-trip this
 * implies (picking a chat row navigates away entirely and needs no
 * further handling; "New plan" would otherwise navigate to a URL ChatPage
 * is already sitting on, which does nothing, so it's intercepted instead).
 */
export function MobileChatHome({ onNavigate }) {
  const { classId, classes, activeClass } = useActiveClass()

  return (
    // fa-rise: mounts fresh every time ChatPage swaps in this early return
    // (see ChatPage's own comment by mobileShowHome) — this is a real
    // unmount/remount of a whole screen, not a prop change on one already
    // on screen, so the same entrance motion Greeting.jsx uses for its own
    // arrival plays here too instead of the screen just appearing.
    <div className="flex h-full w-full flex-col bg-paper fa-rise">
      <Rail
        onNavigate={onNavigate}
        // ClassSwitcher already knows how to present zero/one/many classes
        // on its own (hidden, a plain label, or the real picker) — same
        // convention as its inline use in ChatPage's own header, not
        // re-decided here.
        headerExtra={<ClassSwitcher classes={classes} activeClass={activeClass} classPath={`/c/${classId}`} />}
        // Nothing else is competing for room on this screen the way the
        // desktop dock and phone drawer have to share space with a chat
        // pane right next to them — grow the rows themselves, not just
        // their invisible .tap-target hitbox.
        spacious
      />
    </div>
  )
}
