export interface ReleaseAsset {
  url: string
  sha256?: string
}

/** Where MLX Studio releases are published (the updater feed lives in that repo). */
export const RELEASES_PAGE = 'https://github.com/MLXapp/studio/releases'
export const LATEST_MANIFEST_URL = 'https://raw.githubusercontent.com/MLXapp/studio/main/latest.json'

export interface LatestRelease {
  version: string
  /** Empty until a build has been published for this version. */
  url: string
  sha256?: string
  notes?: string
  tahoeUrl?: string
  tahoeSha256?: string
  downloads?: {
    sequoia?: ReleaseAsset
    tahoe?: ReleaseAsset
  }
}

function parseVersion(v: string): number[] {
  const clean = v.replace(/-.*$/, '')
  return clean.split('.').map(Number)
}

export function versionCompare(a: string, b: string): number {
  const av = parseVersion(a)
  const bv = parseVersion(b)
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const ai = av[i] ?? 0
    const bi = bv[i] ?? 0
    if (isNaN(ai) || isNaN(bi)) return 0
    if (ai > bi) return 1
    if (ai < bi) return -1
  }
  return 0
}

export function compareVersions(current: string, latest: string): boolean {
  return versionCompare(latest, current) > 0
}

export function isValidUpdateUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const trusted = ['github.com', 'mlx.app']
    return parsed.protocol === 'https:' && trusted.some(d => parsed.hostname === d || parsed.hostname.endsWith(`.${d}`))
  } catch {
    return false
  }
}

function macOSMajorVersion(systemVersion?: string): number | null {
  const major = Number(String(systemVersion || '').split('.')[0])
  return Number.isFinite(major) ? major : null
}

function currentMacOSVersion(): string | undefined {
  const getter = (process as unknown as { getSystemVersion?: () => string }).getSystemVersion
  return typeof getter === 'function' ? getter() : undefined
}

export function selectDownloadForMacOS(
  release: LatestRelease,
  systemVersion = currentMacOSVersion(),
): LatestRelease {
  const major = macOSMajorVersion(systemVersion)
  if (major === null || major < 26) {
    const sequoia = release.downloads?.sequoia
    return sequoia?.url ? { ...release, url: sequoia.url, sha256: sequoia.sha256 ?? release.sha256 } : release
  }

  const tahoe = release.downloads?.tahoe
  if (tahoe?.url) {
    return { ...release, url: tahoe.url, sha256: tahoe.sha256 }
  }
  if (release.tahoeUrl) {
    return { ...release, url: release.tahoeUrl, sha256: release.tahoeSha256 }
  }
  if (release.url.includes('-sequoia-arm64.dmg')) {
    return {
      ...release,
      url: release.url.replace('-sequoia-arm64.dmg', '-tahoe-arm64.dmg'),
      sha256: undefined,
    }
  }
  return release
}

export function selectHighestRelease(results: LatestRelease[]): LatestRelease | null {
  let data: LatestRelease | null = null
  for (const r of results) {
    if (data === null || versionCompare(r.version, data.version) > 0) {
      data = r
    }
  }
  return data
}

/**
 * Read one manifest. A manifest needs a version; the download URL is optional
 * because a version can be announced in latest.json before its DMG is
 * published. Returns null for anything that is not a manifest.
 */
export function parseLatestRelease(raw: unknown): LatestRelease | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.version !== 'string' || !/^\d+\.\d+(\.\d+)?/.test(r.version)) return null
  return { ...(r as unknown as LatestRelease), url: typeof r.url === 'string' ? r.url : '' }
}

export type UpdateDecision =
  | { kind: 'current' }
  | { kind: 'no-download'; version: string }
  | { kind: 'untrusted'; version: string; url: string }
  | { kind: 'available'; release: LatestRelease }

/**
 * Decide what to tell the user. Only a newer version with a trusted HTTPS
 * download is announced; a newer version without a download yet stays quiet.
 */
export function decideUpdate(
  release: LatestRelease,
  currentVersion: string,
  systemVersion?: string,
): UpdateDecision {
  if (!compareVersions(currentVersion, release.version)) return { kind: 'current' }
  const hasDownload = !!(release.url || release.downloads?.sequoia?.url || release.downloads?.tahoe?.url || release.tahoeUrl)
  if (!hasDownload) return { kind: 'no-download', version: release.version }
  const selected = selectDownloadForMacOS(release, systemVersion)
  if (!selected.url) return { kind: 'no-download', version: release.version }
  if (!isValidUpdateUrl(selected.url)) return { kind: 'untrusted', version: release.version, url: selected.url }
  return { kind: 'available', release: selected }
}
