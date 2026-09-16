import { createContext } from 'react'

export const WorkspaceRailContext = createContext({
  collapsed: false,
  docked: true,
  drawerOpen: false,
  documentReading: false,
  toggle: null,
  setDocumentReading: () => {},
})
