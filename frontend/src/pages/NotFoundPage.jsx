import { Link } from 'react-router-dom'

/* There was no catch-all route, so an unknown URL rendered the shell with an
   empty middle and no way to tell something had gone wrong. */
export function NotFoundPage() {
  return (
    <div className="column">
      <div className="empty-state">
        <h1>No such page</h1>
        <p>That address doesn’t exist in this app.</p>
        <Link to="/" className="btn btn-primary" style={{ marginTop: 'var(--sp-4)' }}>
          Back to planning
        </Link>
      </div>
    </div>
  )
}
