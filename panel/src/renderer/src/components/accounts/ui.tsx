/**
 * Small building blocks for Accounts, the Connect sheets and setup, sized to
 * the Mac: 13px controls, buttons at least 28px tall, 10–12px radii.
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import * as Dropdown from '@radix-ui/react-dropdown-menu'
import { AlertTriangle, Check, Loader2, MoreHorizontal, X } from 'lucide-react'

/** `key` for counts other than one, `keyOne` for exactly one (locales without plurals repeat the text). */
export function countKey(key: string, count: number): string {
  return count === 1 ? `${key}One` : key
}

type Variant = 'primary' | 'secondary' | 'plain' | 'destructive'
type Size = 'md' | 'lg' | 'xl'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 disabled:bg-primary/40',
  secondary: 'bg-foreground/[0.06] text-foreground ring-1 ring-inset ring-border hover:bg-foreground/[0.1]',
  plain: 'text-foreground hover:bg-foreground/[0.06]',
  destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
}
const SIZES: Record<Size, string> = {
  md: 'h-7 px-3 rounded-[7px]',
  lg: 'h-8 px-3.5 rounded-[8px]',
  xl: 'h-9 px-5 rounded-[9px] font-semibold',
}

export const Btn = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }>(
  ({ variant = 'secondary', size = 'lg', className = '', type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={`inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap text-[13px] font-medium leading-[18px] transition-[background-color,color,box-shadow,opacity,transform] duration-200 ease-mlx focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...props}
    />
  ),
)
Btn.displayName = 'Btn'

export function Spinner({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return <Loader2 className={`animate-spin ${className}`} aria-hidden />
}

/** Grouped list: a rounded card whose rows are separated by hairlines. */
export function Group({ title, action, children, footer }: { title?: string; action?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="space-y-2">
      {(title || action) && (
        <div className="flex min-h-7 items-center gap-2 px-1">
          {title && <h3 className="flex-1 text-[15px] font-semibold leading-5">{title}</h3>}
          {action}
        </div>
      )}
      <div className="overflow-hidden rounded-[12px] border border-border bg-card divide-y divide-border/70">{children}</div>
      {footer && <div className="px-1 text-[12px] leading-4 text-muted-foreground">{footer}</div>}
    </section>
  )
}

/** One status line: icon + text, coloured by tone. */
export function StatusLine({ tone, children }: { tone: 'checking' | 'ok' | 'error' | 'warn'; children: ReactNode }) {
  const icon = tone === 'checking'
    ? <Spinner />
    : tone === 'ok'
      ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />
      : tone === 'error'
        ? <X className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />
        : <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
  const color = tone === 'ok' ? 'text-success' : tone === 'error' ? 'text-destructive' : tone === 'warn' ? 'text-warning' : 'text-muted-foreground'
  return (
    <span className={`flex items-start gap-1.5 text-[13px] leading-[18px] ${color}`}>
      <span className="mt-[2px] shrink-0">{icon}</span>
      <span className="min-w-0">{children}</span>
    </span>
  )
}

/** "Best", "Best value", "Fast" (11px is the floor, badges only). */
export function Badge({ children, tone = 'accent' }: { children: ReactNode; tone?: 'accent' | 'neutral' | 'ok' | 'warn' }) {
  const tones = {
    accent: 'bg-primary/15 text-[color:var(--link)]',
    neutral: 'bg-foreground/[0.07] text-muted-foreground',
    ok: 'bg-success/15 text-success',
    warn: 'bg-warning/15 text-warning',
  }
  return (
    <span className={`inline-flex h-[18px] shrink-0 items-center rounded-full px-2 text-[11px] font-semibold leading-none ${tones[tone]}`}>
      {children}
    </span>
  )
}

/** "…" menu (Radix dropdown; opens with a fade and a small zoom). */
export function MoreMenu({ label, items }: {
  label: string
  items: Array<{ label: string; onSelect: () => void; destructive?: boolean } | 'separator'>
}) {
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-muted-foreground transition-colors duration-200 hover:bg-foreground/[0.07] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 data-[state=open]:bg-foreground/[0.07] data-[state=open]:text-foreground"
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden />
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          align="end"
          sideOffset={4}
          className="z-[60] min-w-[180px] rounded-[10px] border border-border bg-popover p-1 text-popover-foreground shadow-[0_12px_32px_-12px_var(--shadow-deep)] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 duration-200"
        >
          {items.map((item, i) => item === 'separator'
            ? <Dropdown.Separator key={`sep-${i}`} className="my-1 h-px bg-border" />
            : (
              <Dropdown.Item
                key={item.label}
                onSelect={item.onSelect}
                className={`flex h-7 cursor-default select-none items-center rounded-[6px] px-2.5 text-[13px] outline-none transition-colors data-[highlighted]:bg-primary data-[highlighted]:text-primary-foreground ${item.destructive ? 'text-destructive' : ''}`}
              >
                {item.label}
              </Dropdown.Item>
            ))}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  )
}

/** The MLX Harness app icon, drawn (white squircle, gradient X), so it needs no image asset. */
export function AppIconTile({ size = 72 }: { size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.225,
        background: 'linear-gradient(180deg, #ffffff, #f0f0f3)',
        boxShadow: '0 10px 24px -12px rgba(0,0,0,0.45), 0 0 0 0.5px rgba(0,0,0,0.12)',
      }}
      aria-hidden
    >
      <svg width={size * 0.36} height={size * 0.56} viewBox="8.5 6.5 7 11">
        <defs>
          <linearGradient id="mlx-app-icon-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#1f1f1f" />
            <stop offset="1" stopColor="#ef8a00" />
          </linearGradient>
        </defs>
        <path d="M9,7L11,12L9,17H11L12,14.5L13,17H15L13,12L15,7H13L12,9.5L11,7H9Z" fill="url(#mlx-app-icon-g)" />
      </svg>
    </span>
  )
}
