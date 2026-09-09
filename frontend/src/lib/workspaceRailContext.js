import { createContext } from 'react'

export const WorkspaceRailContext = createContext({
  collapsed: false,
  documentReading: false,
  toggle: null,
  setDocumentReading: () => {},
})
