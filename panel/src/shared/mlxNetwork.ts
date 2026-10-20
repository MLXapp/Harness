/**
 * MLX Network tie-in: shapes and pure helpers shared by the main process
 * (which does the HTTP calls) and the Network view.
 *
 * Sources (mlx.app, public):
 *   GET https://mlx.app/api/world/network?totals=1
 *     → { chain, at, totals: { macs, online, working, tps, tokensToday,
 *         countries, cities, placed, freeNodes, freeTflops, freeMemGB } }
 *   GET https://mlx.app/api/account/<name>/mining
 *     → { at, locked, pending, rate, active, macs, state }
 *       locked / pending: MLX in base units (6 decimals) as strings;
 *       rate: MLX per second (number); state: mining | paused | waiting | idle
 */

export const MLX_SITE = 'https://mlx.app'
export const MLX_NETWORK_TOTALS_URL = `${MLX_SITE}/api/world/network?totals=1`
export const MLX_DOWNLOAD_URL = `${MLX_SITE}/download`
export const MLX_RISKS_URL = `${MLX_SITE}/risks`
export const MLX_WORLD_URL = 'https://world.mlx.app'
export const MLX_MAC_BUNDLE_ID = 'app.mlx.mac'
/** MLX amounts have 6 decimals. */
export const MLX_DECIMALS = 6

export function miningUrl(walletName: string): string {
  return `${MLX_SITE}/api/account/${encodeURIComponent(walletName)}/mining`
}

export interface NetworkTotals {
  macs: number
  online: number
  working: number
  tps: number
  tokensToday: number
  /** Present when the network reports it. */
  countries?: number
  freeNodes?: number
}
export interface NetworkSnapshot { chain: string; at: number; totals: NetworkTotals }

export type MiningState = 'mining' | 'paused' | 'waiting' | 'idle'
export interface WalletMining {
  at: number
  /** base units (bigint as string) */
  locked: string
  pending: string
  /** MLX per second */
  rate: number
  active: boolean
  macs: number
  state: MiningState
}

export type FetchResult<T> = { ok: true; data: T } | { ok: false; error: string; status?: number }

/** MLX Node (bundle id app.mlx.mac) on this Mac. */
export interface MlxAppStatus {
  /** Only true on macOS when an installed app with bundle id app.mlx.mac is found. */
  installed: boolean
  running: boolean
  path?: string
  version?: string
  /** This MLX Harness build carries a copy it can install. */
  bundled?: boolean
  bundledVersion?: string
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const count = (v: unknown): number | undefined => (finite(v) && v >= 0 ? v : undefined)

/** Accept only a well-formed totals payload; anything else is an error, never zeros. */
export function parseNetworkTotals(raw: unknown): NetworkSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const t = r.totals as Record<string, unknown> | undefined
  if (!t || typeof t !== 'object') return null
  const macs = count(t.macs), online = count(t.online), working = count(t.working), tps = count(t.tps), tokensToday = count(t.tokensToday)
  if (macs === undefined || online === undefined || working === undefined || tps === undefined || tokensToday === undefined) return null
  const totals: NetworkTotals = { macs, online, working, tps, tokensToday }
  const countries = count(t.countries)
  if (countries !== undefined) totals.countries = countries
  const freeNodes = count(t.freeNodes)
  if (freeNodes !== undefined) totals.freeNodes = freeNodes
  return { chain: typeof r.chain === 'string' ? r.chain : '', at: finite(r.at) ? r.at : Date.now(), totals }
}

const UNITS_RE = /^\d{1,30}$/
const STATES: readonly MiningState[] = ['mining', 'paused', 'waiting', 'idle']

export function parseWalletMining(raw: unknown): WalletMining | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.locked !== 'string' || !UNITS_RE.test(r.locked)) return null
  if (typeof r.pending !== 'string' || !UNITS_RE.test(r.pending)) return null
  if (!finite(r.rate) || r.rate < 0 || !finite(r.at)) return null
  const state = STATES.includes(r.state as MiningState) ? (r.state as MiningState) : (r.active ? 'mining' : 'idle')
  return {
    at: r.at,
    locked: r.locked,
    pending: r.pending,
    rate: r.rate,
    active: r.active === true,
    macs: count(r.macs) ?? 0,
    state,
  }
}

/**
 * Wallet names on MLX are `<name>.mlx`: 2-32 lowercase letters, digits and
 * hyphens, starting and ending with a letter or digit (lib/chain/types.ts
 * NAME_RE on mlx.app). Accepts "luca", "Luca.mlx" or "luca.mlx"; returns the
 * full name or null.
 */
export function normalizeWalletName(input: string): string | null {
  const bare = input.trim().toLowerCase().replace(/\.mlx$/, '')
  if (bare.length < 2 || !/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(bare)) return null
  return `${bare}.mlx`
}

/** Base units → MLX as a number (display only). */
export function unitsToMlx(units: string): number {
  if (!UNITS_RE.test(units)) return NaN
  const padded = units.padStart(MLX_DECIMALS + 1, '0')
  const whole = padded.slice(0, -MLX_DECIMALS)
  const frac = padded.slice(-MLX_DECIMALS)
  return Number(`${whole}.${frac}`)
}

/** MLX always shows 6 decimals (as on mlx.app). */
export function formatMlx(mlx: number, locale?: string): string {
  if (!Number.isFinite(mlx)) return '–'
  return mlx.toLocaleString(locale, { minimumFractionDigits: MLX_DECIMALS, maximumFractionDigits: MLX_DECIMALS })
}
