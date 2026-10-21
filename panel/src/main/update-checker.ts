import type { BrowserWindow } from 'electron'
import { startAppUpdater } from './app-updater'

// MLX Harness's update feed: latest.json at the root of MLXapp/harness (main),
// read by the in-app updater (./app-updater.ts) 5 s after launch, every 6 hours
// and from "Check for Updates…". Releases are published at
// https://github.com/MLXapp/harness/releases. Upstream vMLX's feeds are
// intentionally not queried.
export function checkForUpdates(getWindow: () => BrowserWindow | null, currentVersion: string): void {
  // MLX_STUDIO_SKIP_UPDATE_CHECK is the 0.1.x/0.2.x spelling, still honoured (legacy).
  const skip = process.env.VMLX_SKIP_UPDATE_CHECK === '1' || process.env.MLX_HARNESS_SKIP_UPDATE_CHECK === '1' || process.env.MLX_STUDIO_SKIP_UPDATE_CHECK === '1'
  if (skip) console.log('[UPDATE] Skipping automatic update checks (MLX_HARNESS_SKIP_UPDATE_CHECK / VMLX_SKIP_UPDATE_CHECK)')
  // The IPC and "Check for Updates…" stay available either way.
  startAppUpdater({ getWindow, currentVersion, autoCheck: !skip })
}
