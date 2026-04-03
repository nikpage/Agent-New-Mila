'use client'

import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { lightTheme, darkTheme } from '@/config/theme'
import type { Theme } from '@/config/theme'

interface ThemeContextValue extends Theme {
  isDark: boolean
  toggleTheme: () => void
}

const ThemeContext = createContext<ThemeContextValue>({
  ...(lightTheme as Theme),
  isDark: false,
  toggleTheme: () => {},
})

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [isDark, setIsDark] = useState(false)

  // Initialize from system preference
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    setIsDark(mq.matches)
    if (mq.matches) {
      document.body.setAttribute('data-theme', 'dark')
    }
    const handler = (e: MediaQueryListEvent) => {
      setIsDark(e.matches)
      document.body.setAttribute('data-theme', e.matches ? 'dark' : 'light')
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  const toggleTheme = useCallback(() => {
    setIsDark(prev => {
      const next = !prev
      document.body.setAttribute('data-theme', next ? 'dark' : 'light')
      return next
    })
  }, [])

  const theme = isDark ? darkTheme : lightTheme
  const value: ThemeContextValue = {
    ...(theme as Theme),
    isDark,
    toggleTheme,
  }

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export const useTheme = () => useContext(ThemeContext)
