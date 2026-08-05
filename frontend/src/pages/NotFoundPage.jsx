import { Link } from 'react-router-dom'
import { TopBar } from '../components/TopBar'

/* There was no catch-all route, so an unknown URL rendered the shell with an
   empty middle and no way to tell something had gone wrong.

   The topbar is not decoration here: this was the one page without it, so with the
   sidebar collapsed a mistyped URL left no control to reopen the navigation and no
   theme toggle — a single link was the only way out. */
export function NotFoundPage({ shell }) {
  return (
    <div className="column">
      <TopBar
        title="Not found"
        collapsed={shell?.collapsed}
        onToggleSidebar={shell?.onToggleSidebar}
        theme={shell?.theme}
      />
      <div className="page">
        <div className="empty-state">
          <h1>No such page</h1>
          <p>That address doesn’t exist in this app.</p>
          <Link to="/chat" className="btn btn-primary">
            Back to planning
          </Link>
        </div>
      </div>
    </div>
  )
}
