/**
 * A centred sheet over the window: the backdrop fades, the panel fades in
 * while scaling from 0.98, and both run backwards on close before unmounting.
 * Esc closes the top-most sheet only; Return is left to the sheet's form.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import '../../styles/accounts.css'

const stack: string[] = []

export function Sheet({ open, onClose, onClosed, width = 460, labelledBy, children }: {
  open: boolean
  onClose: () => void
  /** After the close animation (unmount). */
  onClosed?: () => void
  width?: number
  labelledBy?: string
  children: ReactNode
}) {
  const id = useId()
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const closedRef = useRef(onClosed)
  closedRef.current = onClosed

  useEffect(() => {
    if (open) {
      setMounted(true)
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
    const timer = window.setTimeout(() => {
      setMounted(false)
      closedRef.current?.()
    }, 240)
    return () => window.clearTimeout(timer)
  }, [open])

  // Esc: only the top-most open sheet answers.
  useEffect(() => {
    if (!open) return
    stack.push(id)
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || stack[stack.length - 1] !== id) return
      event.stopPropagation()
      event.preventDefault()
      closeRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      const at = stack.lastIndexOf(id)
      if (at >= 0) stack.splice(at, 1)
    }
  }, [open, id])

  // Focus the first field (or the panel) when it opens; give focus back after.
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const timer = window.setTimeout(() => {
      const target = panel.current?.querySelector<HTMLElement>('[data-autofocus], input, button[data-default]')
      ;(target ?? panel.current)?.focus({ preventScroll: true })
    }, 30)
    return () => {
      window.clearTimeout(timer)
      previous?.focus?.({ preventScroll: true })
    }
  }, [open])

  if (!mounted) return null
  const state = shown && open ? 'open' : 'closed'
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" data-vmlx-surface="sheet">
      <div
        className="mlx-sheet-backdrop absolute inset-0 bg-black/40 backdrop-blur-[2px]"
        data-state={state}
        onMouseDown={() => closeRef.current()}
        aria-hidden
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        data-state={state}
        className="mlx-sheet relative flex max-h-full w-full flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-[0_24px_64px_-24px_var(--shadow-deep),0_1px_3px_var(--lg-depth)] outline-none"
        style={{ maxWidth: width }}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}

/** Header: glyph, title and a small line under it. */
export function SheetHeader({ id, icon, title, subtitle }: { id?: string; icon?: ReactNode; title: string; subtitle?: string }) {
  return (
    <div className="flex items-center gap-3 px-6 pt-6 pb-4">
      {icon}
      <div className="min-w-0">
        <h2 id={id} className="truncate text-[17px] font-semibold leading-[22px]">{title}</h2>
        {subtitle && <p className="truncate text-[12px] leading-4 text-muted-foreground">{subtitle}</p>}
      </div>
    </div>
  )
}

/** Footer row: an optional note on the left, buttons on the right. */
export function SheetFooter({ note, children }: { note?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-t border-border/70 bg-foreground/[0.02] px-6 py-4">
      <div className="min-w-0 flex-1 text-[12px] leading-4 text-muted-foreground">{note}</div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}
