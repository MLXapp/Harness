import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  MLX_NODE_APP_NAME,
  MLX_NODE_BUNDLED_DIR,
  MLX_NODE_BUNDLED_ZIP,
  MLX_NODE_REQUIREMENT,
  isInstalledLocation,
  planMlxNodeInstall,
  shouldMarkMlxNodeOffered,
  shouldOfferMlxNode,
  type MlxNodeInstallFacts,
} from '../src/shared/mlxNode'

const mac: MlxNodeInstallFacts = {
  platform: 'darwin',
  installedPath: null,
  bundled: true,
  systemAppsWritable: true,
  userAppsWritable: true,
  userAppsDir: '/Users/luca/Applications',
}

describe('MLX Node install decision', () => {
  it('opens an installed MLX Node instead of installing over it', () => {
    expect(planMlxNodeInstall({ ...mac, installedPath: '/Applications/MLX.app' }))
      .toEqual({ action: 'open', path: '/Applications/MLX.app' })
    // even when this build carries no copy, or nothing is writable
    expect(planMlxNodeInstall({ ...mac, installedPath: '/Applications/MLX Node.app', bundled: false, systemAppsWritable: false, userAppsWritable: false }))
      .toEqual({ action: 'open', path: '/Applications/MLX Node.app' })
  })

  it('installs the bundled copy into /Applications as "MLX Node.app"', () => {
    expect(planMlxNodeInstall(mac)).toEqual({ action: 'install', dir: '/Applications', dest: '/Applications/MLX Node.app' })
    expect(MLX_NODE_APP_NAME).toBe('MLX Node.app')
  })

  it('falls back to ~/Applications when /Applications is not writable', () => {
    expect(planMlxNodeInstall({ ...mac, systemAppsWritable: false }))
      .toEqual({ action: 'install', dir: '/Users/luca/Applications', dest: '/Users/luca/Applications/MLX Node.app' })
  })

  it('sends people to the download page when nothing is writable', () => {
    expect(planMlxNodeInstall({ ...mac, systemAppsWritable: false, userAppsWritable: false }))
      .toEqual({ action: 'download', reason: 'notWritable' })
  })

  it('sends people to the download page when this build carries no MLX Node', () => {
    expect(planMlxNodeInstall({ ...mac, bundled: false })).toEqual({ action: 'download', reason: 'notBundled' })
  })

  it('does nothing off macOS', () => {
    expect(planMlxNodeInstall({ ...mac, platform: 'linux' })).toEqual({ action: 'download', reason: 'unsupported' })
  })
})

describe('MLX Node first-run offer', () => {
  const base = { platform: 'darwin', offered: false, installed: false, bundled: true }

  it('asks once, only when a copy is carried and none is installed', () => {
    expect(shouldOfferMlxNode(base)).toBe(true)
    expect(shouldOfferMlxNode({ ...base, offered: true })).toBe(false)
    expect(shouldOfferMlxNode({ ...base, installed: true })).toBe(false)
    expect(shouldOfferMlxNode({ ...base, bundled: false })).toBe(false)
    expect(shouldOfferMlxNode({ ...base, platform: 'linux' })).toBe(false)
  })

  it('remembers the offer when it was made or not needed, not when this build has no copy', () => {
    expect(shouldMarkMlxNodeOffered(base)).toBe(true)
    expect(shouldMarkMlxNodeOffered({ ...base, installed: true, bundled: false })).toBe(true)
    expect(shouldMarkMlxNodeOffered({ ...base, bundled: false })).toBe(false)
    expect(shouldMarkMlxNodeOffered({ ...base, platform: 'linux' })).toBe(false)
  })
})

describe('MLX Node detection', () => {
  it('counts only top-level installs', () => {
    expect(isInstalledLocation('/Applications/MLX Node.app')).toBe(true)
    expect(isInstalledLocation('/Applications/MLX.app')).toBe(true)
    expect(isInstalledLocation('/Users/luca/Applications/MLX Node.app')).toBe(true)
    expect(isInstalledLocation('/Volumes/Data/Applications/MLX Node.app')).toBe(true)
    // nested in MLX Harness (or any bundle), translocated, on a mounted DMG, in the Trash
    expect(isInstalledLocation('/Applications/MLX Harness.app/Contents/Resources/bundled-node/MLX Node.app')).toBe(false)
    expect(isInstalledLocation('/private/var/folders/x/AppTranslocation/ABC/d/MLX Node.app')).toBe(false)
    expect(isInstalledLocation('/Volumes/MLX Node 0.9.0/MLX Node.app')).toBe(false)
    expect(isInstalledLocation('/Users/luca/.Trash/MLX.app')).toBe(false)
    expect(isInstalledLocation('/Applications/MLX Node.app/Contents/Info.plist')).toBe(false)
  })

  it('verifies copies against our team and bundle id', () => {
    expect(MLX_NODE_REQUIREMENT).toContain('anchor apple generic')
    expect(MLX_NODE_REQUIREMENT).toContain('certificate leaf[subject.OU] = "CCKXS9W488"')
    expect(MLX_NODE_REQUIREMENT).toContain('identifier "app.mlx.mac"')
  })
})

describe('MLX Node packaging', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

  it('ships the staged copy in Contents/Resources/bundled-node, outside app.asar', () => {
    const extra = pkg.build.extraResources.find((r: { from: string }) => r.from === `resources/${MLX_NODE_BUNDLED_DIR}`)
    expect(extra).toMatchObject({ to: MLX_NODE_BUNDLED_DIR })
    expect(extra.filter).toContain(MLX_NODE_BUNDLED_ZIP)
    expect(pkg.build.files).toContain(`!resources/${MLX_NODE_BUNDLED_DIR}{,/**/*}`)
  })

  it('never re-signs it, and signs everything else as before', () => {
    const ignore = (pkg.build.mac.signIgnore as string[]).map((s) => new RegExp(s))
    const skipped = (p: string) => ignore.some((re) => re.test(p))
    const res = '/tmp/release/mac-arm64/MLX Harness.app/Contents/Resources'
    expect(skipped(`${res}/bundled-node/MLX Node.zip`)).toBe(true)
    expect(skipped(`${res}/bundled-node/MLX Node.json`)).toBe(true)
    expect(skipped(`${res}/bundled-python/python/bin/python3`)).toBe(false)
    expect(skipped('/tmp/release/mac-arm64/MLX Harness.app/Contents/MacOS/MLX Harness')).toBe(false)
  })

  it('keeps the staged copy out of git and fetches it in CI', () => {
    expect(readFileSync('../.gitignore', 'utf8')).toMatch(/^panel\/resources\/bundled-node\/$/m)
    const ci = readFileSync('../.github/workflows/harness.yml', 'utf8')
    expect(ci).toContain('./scripts/fetch-mlx-node.sh')
    expect(ci).toContain('refs/tags/v*')
    const fetch = readFileSync('scripts/fetch-mlx-node.sh', 'utf8')
    expect(fetch).toContain('https://mlx.app/api/download/mac')
    expect(fetch).toContain('spctl -a -t exec')
    expect(fetch).toContain('codesign --verify --deep --strict')
    expect(fetch).toContain('TeamIdentifier=$TEAM_ID')
  })
})
