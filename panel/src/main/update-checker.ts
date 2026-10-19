import { BrowserWindow } from 'electron'
import { net } from 'electron'
import {
  decideUpdate,
  LATEST_MANIFEST_URL,
  parseLatestRelease,
  selectHighestRelease,
  type LatestRelease,
} from './update-manifest'

// MLX Studio's update feed: latest.json at the root of MLXapp/studio (main).
// Releases are published at https://github.com/MLXapp/studio/releases.
// Upstream vMLX's feeds are intentionally not queried.
const LATEST_URLS = [LATEST_MANIFEST_URL]
const CHECK_DELAY_MS = 5000 // Wait 5s after startup before checking

export function checkForUpdates(getWindow: () => BrowserWindow | null, currentVersion: string): void {
  if (process.env.VMLX_SKIP_UPDATE_CHECK === '1' || process.env.MLX_STUDIO_SKIP_UPDATE_CHECK === '1') {
    console.log('[UPDATE] Skipping update check (MLX_STUDIO_SKIP_UPDATE_CHECK / VMLX_SKIP_UPDATE_CHECK)')
    return
  }

  setTimeout(async () => {
    const fetches = LATEST_URLS.map(async (url) => {
      try {
        const response = await net.fetch(url, { method: 'GET', cache: 'no-store' })
        if (!response.ok) {
          console.log(`[UPDATE] ${url}: HTTP ${response.status}`)
          return null
        }
        const parsed = parseLatestRelease(await response.json())
        if (parsed) console.log(`[UPDATE] Fetched manifest from ${url}: v${parsed.version}`)
        return parsed
      } catch (err) {
        console.log(`[UPDATE] ${url}: ${(err as Error).message}`)
      }
      return null
    })

    const results = (await Promise.all(fetches)).filter((r): r is LatestRelease => r != null)
    const data = selectHighestRelease(results)
    if (!data) {
      console.log('[UPDATE] No update manifest available')
      return
    }

    const decision = decideUpdate(data, currentVersion)
    switch (decision.kind) {
      case 'current':
        console.log(`[UPDATE] Up to date (${currentVersion}; latest ${data.version})`)
        return
      case 'no-download':
        console.log(`[UPDATE] v${decision.version} is announced but has no download yet`)
        return
      case 'untrusted':
        console.log(`[UPDATE] Ignoring v${decision.version}: untrusted download URL ${decision.url}`)
        return
      case 'available': {
        const release = decision.release
        console.log(`[UPDATE] New version available: ${currentVersion} → ${release.version}`)
        const win = getWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send('app:updateAvailable', {
            currentVersion,
            latestVersion: release.version,
            url: release.url,
            notes: release.notes,
          })
        }
      }
    }
  }, CHECK_DELAY_MS)
}
