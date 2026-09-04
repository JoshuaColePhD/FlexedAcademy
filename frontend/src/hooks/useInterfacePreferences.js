import { useCallback, useEffect, useState } from 'react'

const FONT_SIZE_KEY = 'aplang.editor-text'
const HIGH_CONTRAST_KEY = 'aplang.high-contrast'
const AUTO_SAVE_KEY = 'aplang.auto-save'
const FONT_SIZES = ['small', 'normal', 'large']

function readFontSize() {
  try {
    const saved = localStorage.getItem(FONT_SIZE_KEY)
    return FONT_SIZES.includes(saved) ? saved : 'normal'
  } catch {
    return 'normal'
  }
}

function readHighContrast() {
  try {
    return localStorage.getItem(HIGH_CONTRAST_KEY) === 'true'
  } catch {
    return false
  }
}

function readAutoSave() {
  try {
    const saved = localStorage.getItem(AUTO_SAVE_KEY)
    return saved === null ? true : saved === 'true'
  } catch {
    return true
  }
}

/** Device-local reading preferences shared by settings and the app shell. */
export function useInterfacePreferences() {
  const [fontSize, setFontSizeState] = useState(readFontSize)
  const [highContrast, setHighContrastState] = useState(readHighContrast)
  const [autoSave, setAutoSaveState] = useState(readAutoSave)

  useEffect(() => {
    document.documentElement.dataset.editorText = fontSize
    document.documentElement.dataset.highContrast = highContrast ? 'true' : 'false'
    try {
      localStorage.setItem(FONT_SIZE_KEY, fontSize)
      localStorage.setItem(HIGH_CONTRAST_KEY, String(highContrast))
      localStorage.setItem(AUTO_SAVE_KEY, String(autoSave))
    } catch {
      // Private browsing — the preference still applies for this session.
    }
  }, [fontSize, highContrast, autoSave])

  const setFontSize = useCallback((next) => {
    if (FONT_SIZES.includes(next)) setFontSizeState(next)
  }, [])

  const setHighContrast = useCallback((next) => {
    setHighContrastState(Boolean(next))
  }, [])

  const setAutoSave = useCallback((next) => {
    setAutoSaveState(Boolean(next))
  }, [])

  return { fontSize, setFontSize, highContrast, setHighContrast, autoSave, setAutoSave }
}
