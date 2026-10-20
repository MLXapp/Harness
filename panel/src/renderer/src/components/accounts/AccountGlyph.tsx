import { featuredAccount } from '../../../../shared/curated'
import { Emblem } from '../brand/Logo'

/**
 * The small square that stands for an account or a model's home in lists,
 * sheets and the model switcher. Featured accounts get a tinted monogram tile
 * (no third-party logos are drawn); models on this Mac get the MLX emblem;
 * anything else gets a neutral tile with its first letter.
 */
export function AccountGlyph({
  providerId,
  name,
  size = 20,
  local = false,
  className = '',
}: {
  /** Catalog/provider id ('deepseek', 'anthropic', 'wavespeed', a custom id…). */
  providerId?: string
  /** Fallback label for the monogram. */
  name?: string
  size?: number
  /** Model runs on this Mac (MLX engine or a local server). */
  local?: boolean
  className?: string
}) {
  const radius = Math.round(size * 0.26)
  if (local) {
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center ${className}`}
        style={{ width: size, height: size }}
        aria-hidden
      >
        <Emblem variant="box" size={size} />
      </span>
    )
  }
  const featured = providerId ? featuredAccount(providerId) : undefined
  const fallback = (name || providerId || '?').trim().charAt(0) || '?'
  const letter = (featured?.monogram ?? fallback).toUpperCase()
  const tint = featured?.tint
  return (
    <span
      className={`inline-flex shrink-0 select-none items-center justify-center font-semibold ${
        tint ? 'text-white' : 'bg-muted text-muted-foreground'
      } ${className}`}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        fontSize: Math.round(size * 0.52),
        lineHeight: 1,
        ...(tint
          ? { background: `linear-gradient(145deg, ${tint}, color-mix(in srgb, ${tint} 72%, black))` }
          : {}),
      }}
      aria-hidden
    >
      {letter}
    </span>
  )
}
