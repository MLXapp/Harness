import { createContext, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from 'react'

/**
 * MLX Harness follows the system appearance by default. The user can pin Light
 * or Dark in Preferences; the choice is stored per machine.
 *
 * The resolved theme is written to <html> as class `light` or `dark`
 * (Tailwind's `dark:` variant and the MLX tokens read it). Before React runs,
 * styles/console-tokens.css already follows prefers-color-scheme, so the first
 * paint is right without a script.
 */
export type ThemePreference = 'system' | 'light' | 'dark'
const STORAGE_KEY = 'mlx-studio-theme'

function readPreference(): ThemePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch { /* restricted storage */ }
  return 'system'
}

const darkQuery = () => window.matchMedia('(prefers-color-scheme: dark)')

function apply(resolved: 'light' | 'dark') {
  const root = document.documentElement
  root.classList.toggle('dark', resolved === 'dark')
  root.classList.toggle('light', resolved === 'light')
  root.dataset.theme = resolved
  root.style.colorScheme = resolved
}

interface ThemeContextValue {
  preference: ThemePreference
  resolved: 'light' | 'dark'
  setPreference: (p: ThemePreference) => void
}

const ThemeContext = createContext<ThemeContextValue>({
  preference: 'system',
  resolved: 'light',
  setPreference: () => {},
})

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference)
  const [systemDark, setSystemDark] = useState(() => darkQuery().matches)
  const resolved: 'light' | 'dark' = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference

  useEffect(() => {
    const mq = darkQuery()
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  useLayoutEffect(() => { apply(resolved) }, [resolved])

  const setPreference = (p: ThemePreference) => {
    setPreferenceState(p)
    try { localStorage.setItem(STORAGE_KEY, p) } catch { /* restricted storage */ }
  }

  return (
    <ThemeContext.Provider value={{ preference, resolved, setPreference }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext)
}
