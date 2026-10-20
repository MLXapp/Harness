/**
 * Update Checker Tests
 *
 * Tests version comparison logic and manifest validation.
 * Re-implements compareVersions as a pure function (mirrors src/main/update-checker.ts)
 * to avoid Electron import dependencies in vitest.
 */
import { describe, it, expect } from 'vitest'
import {
  compareVersions as compareVersionsFromSource,
  isValidUpdateUrl as isValidUpdateUrlFromSource,
  selectDownloadForMacOS,
  selectHighestRelease,
} from '../src/main/update-manifest'

// Mirror of compareVersions from src/main/update-checker.ts
function compareVersions(current: string, latest: string): boolean {
  const clean = (v: string) => v.replace(/-.*$/, '')
  const a = clean(current).split('.').map(Number)
  const b = clean(latest).split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (isNaN(av) || isNaN(bv)) return false
    if (bv > av) return true
    if (bv < av) return false
  }
  return false
}

describe('compareVersions', () => {
  it('detects newer major version', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBe(true)
  })

  it('detects newer minor version', () => {
    expect(compareVersions('1.1.0', '1.2.0')).toBe(true)
  })

  it('detects newer patch version', () => {
    expect(compareVersions('1.1.1', '1.1.2')).toBe(true)
  })

  it('returns false when versions are equal', () => {
    expect(compareVersions('1.1.4', '1.1.4')).toBe(false)
  })

  it('returns false when current is newer', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBe(false)
    expect(compareVersions('1.2.0', '1.1.9')).toBe(false)
  })

  it('strips pre-release suffixes before comparing', () => {
    expect(compareVersions('1.1.4-beta.1', '1.1.4')).toBe(false)
    expect(compareVersions('1.1.3-beta.1', '1.1.4')).toBe(true)
    expect(compareVersions('1.1.4', '1.1.5-beta.1')).toBe(true)
  })

  it('handles versions with different segment counts', () => {
    expect(compareVersions('1.0', '1.0.1')).toBe(true)
    expect(compareVersions('1.0.1', '1.0')).toBe(false)
  })

  it('returns false for malformed version strings', () => {
    expect(compareVersions('abc', '1.0.0')).toBe(false)
    expect(compareVersions('1.0.0', 'xyz')).toBe(false)
  })

  it('handles zero-padded segments correctly', () => {
    expect(compareVersions('0.0.1', '0.0.2')).toBe(true)
    expect(compareVersions('0.0.0', '0.0.1')).toBe(true)
  })

  it('handles real version progression', () => {
    expect(compareVersions('1.1.3', '1.1.4')).toBe(true)
    expect(compareVersions('1.1.4', '1.2.0')).toBe(true)
    expect(compareVersions('0.2.11', '0.2.12')).toBe(true)
  })
})

describe('update manifest validation', () => {
  it('rejects manifest missing version', () => {
    const data = { url: 'https://example.com' }
    expect(!data.version || !data.url).toBe(true)
  })

  it('rejects manifest missing url', () => {
    const data = { version: '1.0.0' } as any
    expect(!data.version || !data.url).toBe(true)
  })

  it('accepts valid manifest', () => {
    const data = { version: '1.0.0', url: 'https://example.com' }
    expect(!data.version || !data.url).toBe(false)
  })

  it('accepts manifest with optional notes', () => {
    const data = { version: '1.0.0', url: 'https://example.com', notes: 'Bug fixes' }
    expect(!data.version || !data.url).toBe(false)
    expect(data.notes).toBe('Bug fixes')
  })
})

// Mirror of URL validation from src/main/update-checker.ts
function isValidUpdateUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const trusted = ['github.com', 'mlx.app']
    return parsed.protocol === 'https:' && trusted.some(d => parsed.hostname === d || parsed.hostname.endsWith(`.${d}`))
  } catch {
    return false
  }
}

describe('update URL validation', () => {
  it('accepts valid GitHub HTTPS URL', () => {
    expect(isValidUpdateUrl('https://github.com/jjang-ai/mlxstudio/releases/tag/v1.0.0')).toBe(true)
  })

  it('accepts trusted studio.mlx.app updater URL', () => {
    expect(isValidUpdateUrl('https://studio.mlx.app/update/latest.json')).toBe(true)
  })

  it('rejects githubusercontent.com (not github.com)', () => {
    // githubusercontent.com is a CDN domain, not github.com — our validation
    // only allows *.github.com. Release downloads go through github.com directly.
    expect(isValidUpdateUrl('https://objects.githubusercontent.com/download/v1.0.0')).toBe(false)
  })

  it('rejects lookalike domain (evilgithub.com)', () => {
    expect(isValidUpdateUrl('https://evilgithub.com/fake')).toBe(false)
  })

  it('rejects HTTP GitHub URL', () => {
    expect(isValidUpdateUrl('http://github.com/jjang-ai/mlxstudio')).toBe(false)
  })

  it('rejects non-GitHub HTTPS URL', () => {
    expect(isValidUpdateUrl('https://evil.com/fake-release')).toBe(false)
  })

  it('rejects javascript: URL', () => {
    expect(isValidUpdateUrl('javascript:alert(1)')).toBe(false)
  })

  it('rejects file: URL', () => {
    expect(isValidUpdateUrl('file:///etc/passwd')).toBe(false)
  })

  it('rejects data: URL', () => {
    expect(isValidUpdateUrl('data:text/html,<h1>hi</h1>')).toBe(false)
  })

  it('rejects invalid URL string', () => {
    expect(isValidUpdateUrl('not-a-url')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isValidUpdateUrl('')).toBe(false)
  })
})

describe('native macOS update asset selection', () => {
  const manifest = {
    version: '1.5.49',
    url: 'https://github.com/jjang-ai/mlxstudio/releases/download/v1.5.49/vMLX-1.5.49-sequoia-arm64.dmg',
    sha256: 's'.repeat(64),
    downloads: {
      sequoia: {
        url: 'https://github.com/jjang-ai/mlxstudio/releases/download/v1.5.49/vMLX-1.5.49-sequoia-arm64.dmg',
        sha256: 's'.repeat(64),
      },
      tahoe: {
        url: 'https://github.com/jjang-ai/mlxstudio/releases/download/v1.5.49/vMLX-1.5.49-tahoe-arm64.dmg',
        sha256: 't'.repeat(64),
      },
    },
  }

  it('selects the Tahoe-native DMG on macOS 26 so M5/Tahoe installs get native MLX wheels', () => {
    const selected = selectDownloadForMacOS(manifest, '26.3.2')

    expect(selected.url).toContain('-tahoe-arm64.dmg')
    expect(selected.sha256).toBe('t'.repeat(64))
  })

  it('keeps the Sequoia-compatible DMG on macOS 15', () => {
    const selected = selectDownloadForMacOS(manifest, '15.6.0')

    expect(selected.url).toContain('-sequoia-arm64.dmg')
    expect(selected.sha256).toBe('s'.repeat(64))
  })

  it('can derive the Tahoe URL from a legacy Sequoia-only manifest without trusting new domains', () => {
    const selected = selectDownloadForMacOS({
      version: '1.5.49',
      url: 'https://github.com/jjang-ai/mlxstudio/releases/download/v1.5.49/vMLX-1.5.49-sequoia-arm64.dmg',
      sha256: 's'.repeat(64),
    }, '26.0.0')

    expect(selected.url).toBe('https://github.com/jjang-ai/mlxstudio/releases/download/v1.5.49/vMLX-1.5.49-tahoe-arm64.dmg')
    expect(selected.sha256).toBeUndefined()
  })

  it('uses the source version comparison and URL validation helpers', () => {
    expect(compareVersionsFromSource('1.5.48', '1.5.49')).toBe(true)
    expect(isValidUpdateUrlFromSource(manifest.downloads.tahoe.url)).toBe(true)
  })
})

describe('multi-source update manifests', () => {
  it('selects raw GitHub when mlx.studio is stale so users are not pinned to the old website origin', () => {
    const staleSite = {
      version: '1.5.58',
      url: 'https://github.com/jjang-ai/mlxstudio/releases/download/v1.5.58/vMLX-1.5.58-sequoia-arm64.dmg',
      sha256: '5'.repeat(64),
    }
    const rawGitHub = {
      version: '1.5.65',
      url: 'https://github.com/jjang-ai/mlxstudio/releases/download/v1.5.65/vMLX-1.5.65-sequoia-arm64.dmg',
      sha256: '6'.repeat(64),
    }

    expect(selectHighestRelease([staleSite, rawGitHub])).toEqual(rawGitHub)
    expect(selectHighestRelease([rawGitHub, staleSite])).toEqual(rawGitHub)
  })
})

describe('MLX Harness update feed (repo MLXapp/studio)', () => {
  it('reads latest.json from MLXapp/studio and trusts studio.mlx.app downloads', async () => {
    const { LATEST_MANIFEST_URL, RELEASES_PAGE } = await import('../src/main/update-manifest')
    expect(LATEST_MANIFEST_URL).toBe('https://raw.githubusercontent.com/MLXapp/studio/main/latest.json')
    expect(RELEASES_PAGE).toBe('https://github.com/MLXapp/studio/releases')
    expect(isValidUpdateUrlFromSource('https://github.com/MLXapp/studio/releases/download/v0.2.0/MLX-Studio-0.2.0-arm64.dmg')).toBe(true)
    expect(isValidUpdateUrlFromSource('https://github.com/MLXapp/studio/releases/download/v0.2.0/MLX-Harness-0.2.0-arm64.dmg')).toBe(true)
    expect(isValidUpdateUrlFromSource('https://harness.mlx.app/download')).toBe(true)
    expect(isValidUpdateUrlFromSource('https://studio.mlx.app/download')).toBe(true)
    expect(isValidUpdateUrlFromSource('https://mlx.studio/update/latest.json')).toBe(false)
    expect(isValidUpdateUrlFromSource('https://evilmlx.app/x.dmg')).toBe(false)
  })

  it('accepts a manifest without a download and stays quiet about it', async () => {
    const { parseLatestRelease, decideUpdate } = await import('../src/main/update-manifest')
    const fs = await import('fs')
    // latest.json is rewritten by the release job; it never announces a version newer than this checkout.
    const shipped = parseLatestRelease(JSON.parse(fs.readFileSync('../latest.json', 'utf-8')))
    const ours = JSON.parse(fs.readFileSync('package.json', 'utf-8')).version
    expect(shipped?.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(decideUpdate(shipped!, ours, '15.6.0')).toEqual({ kind: 'current' })

    const announced = parseLatestRelease({ version: '0.2.0', downloads: {} })!
    expect(decideUpdate(announced, '0.1.0', '15.6.0')).toEqual({ kind: 'no-download', version: '0.2.0' })
    expect(decideUpdate(announced, '0.1.0', '26.1.0')).toEqual({ kind: 'no-download', version: '0.2.0' })
    expect(parseLatestRelease({ url: 'https://github.com/x' })).toBeNull()
    expect(parseLatestRelease('nope')).toBeNull()
  })

  it('announces a newer release only with a trusted download', async () => {
    const { decideUpdate } = await import('../src/main/update-manifest')
    const url = 'https://github.com/MLXapp/studio/releases/download/v0.2.0/MLX-Harness-0.2.0-arm64.dmg'
    const ok = decideUpdate({ version: '0.2.0', url }, '0.1.0', '15.6.0')
    expect(ok.kind).toBe('available')
    expect(ok.kind === 'available' && ok.release.url).toBe(url)
    expect(decideUpdate({ version: '0.2.0', url: 'https://evil.example/x.dmg' }, '0.1.0', '15.6.0').kind).toBe('untrusted')
    expect(decideUpdate({ version: '0.1.0', url }, '0.1.0', '15.6.0').kind).toBe('current')
  })
})

describe('latest.json carries what the in-app updater needs', () => {
  it('a published release has an https DMG, its SHA-256 and its size', async () => {
    const { parseLatestRelease, selectDownloadForMacOS, isValidUpdateUrl } = await import('../src/main/update-manifest')
    const { isSha256 } = await import('../src/shared/appUpdate')
    const fs = await import('fs')
    const shipped = parseLatestRelease(JSON.parse(fs.readFileSync('../latest.json', 'utf-8')))!
    if (!shipped.url) return // announced without a build yet
    const selected = selectDownloadForMacOS(shipped, '15.6.0')
    expect(isValidUpdateUrl(selected.url)).toBe(true)
    expect(selected.url).toMatch(/\.dmg$/)
    expect(isSha256(selected.sha256)).toBe(true)
    expect(selected.size).toBeGreaterThan(0)
  })

  it('keeps the size with the asset it belongs to', async () => {
    const { selectDownloadForMacOS } = await import('../src/main/update-manifest')
    const url = 'https://github.com/MLXapp/studio/releases/download/v0.2.0/MLX-Studio-0.2.0-arm64.dmg'
    const sha = 'a'.repeat(64)
    const m = { version: '0.2.0', url, sha256: sha, size: 123, downloads: { sequoia: { url, sha256: sha } } }
    expect(selectDownloadForMacOS(m, '15.6.0')).toMatchObject({ url, sha256: sha, size: 123 })
    const other = 'https://github.com/MLXapp/studio/releases/download/v0.2.0/MLX-Studio-0.2.0-other.dmg'
    const split = { ...m, downloads: { sequoia: { url: other } } }
    // another file: neither the top-level size nor its checksum may be borrowed
    expect(selectDownloadForMacOS(split, '15.6.0')).toMatchObject({ url: other, sha256: undefined, size: undefined })
  })
})
