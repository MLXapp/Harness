import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export const CHROME_END_ID = 'mlx-chrome-end'

/**
 * Renders its children into the right end of the window's top strip
 * (AppHeader), so a page's few controls share the 52px bar with the tabs
 * instead of stacking a second bar under it. Falls back to rendering in place
 * when there is no header (tests, previews of a single component).
 */
export function ChromeEnd({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(() =>
    typeof document === 'undefined' ? null : document.getElementById(CHROME_END_ID))
  useEffect(() => {
    if (!target) setTarget(document.getElementById(CHROME_END_ID))
  }, [target])
  if (!target) return <>{children}</>
  return createPortal(children, target)
}
