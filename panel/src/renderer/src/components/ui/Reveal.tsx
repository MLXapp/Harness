import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * Opens and closes its content by animating height (and opacity), so nothing
 * appears or disappears with a jump. Content stays mounted until the close
 * transition ends. `appear` animates the first mount open as well.
 */
export function Reveal({ open, appear = true, children, onClosed, className }: {
  open: boolean
  appear?: boolean
  children: ReactNode
  onClosed?: () => void
  className?: string
}) {
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(open && !appear)
  const closedCallback = useRef(onClosed)
  closedCallback.current = onClosed

  useEffect(() => {
    if (open) {
      setMounted(true)
      // Two frames: the closed state must be painted before opening.
      let second = 0
      const first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => setShown(true))
      })
      return () => {
        cancelAnimationFrame(first)
        cancelAnimationFrame(second)
      }
    }
    setShown(false)
    // Fallback when no transition runs (hidden ancestor, reduced motion).
    const timer = window.setTimeout(() => {
      setMounted(false)
      closedCallback.current?.()
    }, 600)
    return () => window.clearTimeout(timer)
  }, [open])

  if (!mounted) return null
  return (
    <div
      className={`mlx-disclose${className ? ` ${className}` : ''}`}
      data-open={shown ? 'true' : 'false'}
      aria-hidden={!open}
      onTransitionEnd={(event) => {
        if (event.target !== event.currentTarget || open || event.propertyName !== 'grid-template-rows') return
        setMounted(false)
        closedCallback.current?.()
      }}
    >
      <div className="mlx-disclose-inner">{children}</div>
    </div>
  )
}
