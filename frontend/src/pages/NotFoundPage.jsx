import { Link } from 'react-router-dom'

/* There was no catch-all route, so an unknown URL rendered the shell with an
   empty middle and no way to tell something had gone wrong.

   The TopBar this used to render is gone: it existed to re-open a collapsed
   sidebar, which was a workaround for prop-drilled shell state. The rail is
   always there on desktop and the tab bar is always there on a phone, so a
   mistyped URL can no longer strand anyone. */
export function NotFoundPage() {
  return (
    <div className="column">
      <div className="page">
        <div className="empty-state">
          <h1>No such page</h1>
          <p>That address doesn’t exist in this app.</p>
          {/* Was "/chat", which is not a route — so the only way off the 404
              page was back to the 404 page. */}
          <Link to="/" className="btn btn-primary">
            Back to planning
          </Link>
        </div>
      </div>
    </div>
  )
}
