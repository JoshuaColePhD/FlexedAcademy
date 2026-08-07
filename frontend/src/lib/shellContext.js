import { createContext, useContext } from 'react'

/* One fact the shell and the page both need: is the document open?
 *
 * ChatPage owns the answer (it is the thing that expands the artifact). AppShell
 * needs it to tighten the nav rail from 264px to 216px, because three columns
 * plus a document leaves the sheet too narrow otherwise and the nav is the
 * column with slack in it.
 *
 * A context rather than a prop because AppShell renders its children through a
 * <Routes>, so there is no place to thread a prop; and rather than a CSS
 * variable stamped on documentElement, because a page reaching up to restyle
 * the shell is the kind of action-at-a-distance nobody finds later.
 *
 * Default false, so any component outside a provider (ClassPage, the auth
 * screens) reads "no document open" rather than crashing.
 */
export const ShellContext = createContext({ docOpen: false, setDocOpen: () => {} })

export const useShell = () => useContext(ShellContext)
