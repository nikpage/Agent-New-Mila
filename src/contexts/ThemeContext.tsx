'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import { lightTheme, darkTheme } from '@/config/theme'
import type { Theme } from '@/config/theme'

const ThemeContext = createContext<Theme>(lightTheme as Theme)

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(lightTheme as Theme)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    setTheme(mq.matches ? darkTheme as Theme : lightTheme as Theme)
    const handler = (e: MediaQueryListEvent) => setTheme(e.matches ? darkTheme as Theme : lightTheme as Theme)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>
}

export const useTheme = () => useContext(ThemeContext)
