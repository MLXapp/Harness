/*
 * MLX brand marks for MLX Harness (same shapes as mlx.app components/Logo.tsx).
 * Shapes are Material Design Icons "alpha-x" (Pictogrammers, Apache 2.0).
 *   box          the MLX emblem: sidebar, app icon
 *   box-outline  secondary surfaces
 *   circle-outline the MLX Token
 * Every mark is filled with the brand gradient (ink -> orange in light theme,
 * white -> orange in dark), defined once by <BrandDefs/> and driven by the
 * --brand-a / --brand-b tokens, so it follows the theme.
 */

export const MLX_PATHS = {
  x: 'M9,7L11,12L9,17H11L12,14.5L13,17H15L13,12L15,7H13L12,9.5L11,7H9Z',
  box: 'M9,7L11,12L9,17H11L12,14.5L13,17H15L13,12L15,7H13L12,9.5L11,7H9M5,3H19A2,2 0 0,1 21,5V19A2,2 0 0,1 19,21H5A2,2 0 0,1 3,19V5A2,2 0 0,1 5,3Z',
  'box-outline': 'M9,7H11L12,9.5L13,7H15L13,12L15,17H13L12,14.5L11,17H9L11,12L9,7M5,3H19A2,2 0 0,1 21,5V19A2,2 0 0,1 19,21H5A2,2 0 0,1 3,19V5A2,2 0 0,1 5,3M5,5V19H19V5H5Z',
  'circle-outline':
    'M9,7H11L12,9.5L13,7H15L13,12L15,17H13L12,14.5L11,17H9L11,12L9,7M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22A10,10 0 0,1 2,12A10,10 0 0,1 12,2M12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4Z',
} as const
export type EmblemVariant = keyof typeof MLX_PATHS

const VIEW: Record<EmblemVariant, string> = {
  x: '8.5 6.5 7 11',
  box: '3 3 18 18',
  'box-outline': '3 3 18 18',
  'circle-outline': '2 2 20 20',
}

/** The brand gradient, defined once per document. */
export function BrandDefs() {
  return (
    <svg width="0" height="0" aria-hidden focusable="false" style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}>
      <defs>
        <linearGradient id="mlx-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0.12" style={{ stopColor: 'var(--brand-a)' }} />
          <stop offset="1" style={{ stopColor: 'var(--brand-b)' }} />
        </linearGradient>
      </defs>
    </svg>
  )
}

export function Emblem({ variant = 'box', size = 26, className, title }: {
  variant?: EmblemVariant
  size?: number
  className?: string
  title?: string
}) {
  const vb = VIEW[variant]
  const [, , w, h] = vb.split(' ').map(Number)
  return (
    <svg
      width={variant === 'x' ? (size * w) / h : size}
      height={size}
      viewBox={vb}
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <path d={MLX_PATHS[variant]} style={{ fill: 'url(#mlx-g) var(--text)' }} />
    </svg>
  )
}

/** "MLX" as a wordmark: extra bold, the X at 70% opacity. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={`wordmark${className ? ' ' + className : ''}`} aria-label="MLX">
      <span aria-hidden>ML</span>
      <span className="wm-x" aria-hidden>X</span>
    </span>
  )
}
