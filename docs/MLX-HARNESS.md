# MLX Harness vs upstream vMLX

MLX Harness is a fork of [vMLX](https://github.com/jjang-ai/vmlx) by JANGQ AI
(Apache-2.0). The first commit in this repository is the unmodified import of
vMLX 1.6.80 (`jjang-ai/vmlx@aa098f6`); everything after it is ours.

## The name

MLX Harness was formerly **MLX Studio** (up to 0.1.x) and was renamed in 0.2.0
(20 Oct 2026): JANGQ AI's own vMLX app is called MLX Studio, so ours must never
be called that anywhere a person sees it. On 21 Oct 2026 the repository moved
from `MLXapp/studio` to `MLXapp/harness` and our own internal "studio" names
went with it (workflow `harness.yml`, `build-harness-dmg.sh`, npm package
`mlx-harness`, `HARNESS_*` constants, `MLX_HARNESS_*` env vars, settings keys).
The credit "Built on vMLX by JANGQ AI" stays.

**Renamed, with compatibility:**

| Now | Before | Compatibility |
|---|---|---|
| Feed `raw.githubusercontent.com/MLXapp/harness/main/latest.json` | `…/MLXapp/studio/main/latest.json` | `LATEST_MANIFEST_URLS` (update-manifest.ts) tries the new feed, then the old path. Installed 0.1.x/0.2.0 copies read the old path, which GitHub redirects; never create a new repo named `MLXapp/studio` (it would break that redirect) |
| Release URLs `github.com/MLXapp/harness/releases/download/…` | `github.com/MLXapp/studio/…` | Every version's `isValidUpdateUrl` checks the host only (`github.com` or `*.mlx.app`), so 0.1.x and 0.2.0 accept the new URLs |
| Env vars `MLX_HARNESS_SKIP_UPDATE_CHECK`, `MLX_HARNESS_FLAVOR`, `MLX_HARNESS_REUSE_PYTHON` | `MLX_STUDIO_*` | The old names are still read when the new ones are unset |
| Settings key `harness_update_notified_version` | `studio_update_notified_version` | Read once, written under the new key, old key deleted (`app-updater.ts` `readNotifiedVersion`) |
| localStorage `mlx-harness-theme` | `mlx-studio-theme` | Read once, moved to the new key (`ThemeProvider.tsx`) |
| Ids in other tools' configs: tag `_mlxharness`, provider keys / API-key placeholder `mlxharness`, Codex `MLXHARNESS_*`, Codex block `MLX Harness managed Codex defaults` | `_mlxstudio`, `mlxstudio`, `MLXSTUDIO_*`, `MLX Studio managed Codex defaults` | Both recognised (`coding-tools.ts` `isOurs`): legacy entries are listed, taken over on the next add (Claude Code's parked values, OpenClaw/Hermes models and allowlist move across) and removed by remove (tests `coding-tools-legacy-ids.test.ts`) |

**Kept on purpose** (each explained where it lives):

| Kept | Why |
|---|---|
| Bundle id `app.mlx.studio`, team `CCKXS9W488`, the updater's designated requirement (`HARNESS_BUNDLE_ID`, `HARNESS_REQUIREMENT` in `shared/appUpdate.ts`; `appId` in `panel/package.json`; `setAppUserModelId` in `main/index.ts`) | The app's identity: macOS Keychain item access, TCC permissions and every installed copy's updater codesign check key on it; changing it would break updates for every installed copy and orphan saved keys |
| Legacy names used only to migrate 0.1.x users: bundle name `MLX Studio.app` (`LEGACY_APP_NAMES`, renamed after quit), userData `~/Library/Application Support/MLX Studio` and Keychain item `MLX Studio Safe Storage` (`LEGACY_APP_NAME` in `shared/appIdentity.ts`, `main/app-identity.ts`, `main/secretStorage.ts`), leftovers `.MLX Studio.update.app` / `.MLX Studio.old-*` | Chats, settings, local storage and every saved API key live there. Fresh installs use `MLX Harness` for both (tests `app-identity.test.ts`, `app-update-rules.test.ts`, `app-updater-flow.test.ts`) |
| The legacy ids above in other tools' configs, the legacy settings/theme keys, the `MLX_STUDIO_*` env fallbacks and the old feed URL | Read only, for the migrations listed in the first table |
| Upstream JANGQ AI references: `mlxstudio#NN` issue numbers, `jjang-ai/mlxstudio`, `mlx.studio`, `~/.mlxstudio/models` (upstream's model folder, still where the app looks), `data-mlx-studio` in `App.tsx`, upstream docs (`docs/mlxstudio-releases-readme.md`, `docs/guides/*`, `docs/development/release-automation.md`, `CHANGELOG.md`), the engine (`vmlx_engine/`), Python tests and benches | They name JANGQ AI's own product MLX Studio, not ours; left as imported so upstream merges stay easy |
| Third-party names: LM Studio (`lmstudio`, `lm-studio`), Google AI Studio, Mac Studio hosts (`macstudio`, `mac-studio.local`), the "dots" model family comment | Not ours |

**Keychain detail.** Electron 44 names the safeStorage item `"<app.name> Safe
Storage"` once, in `ElectronBrowserMainParts::PostCreateMainMessageLoop`, which
runs after the main script's top-level code and before `will-finish-launching`.
On a Mac with a 0.1.x folder, `app-identity.ts` sets `app.name = "MLX Studio"` at
startup and back to `"MLX Harness"` in a `will-finish-launching` listener
prepended ahead of Electron's default-menu listener. Visible names never depend
on it: CFBundleName/CFBundleDisplayName come from `productName` ("MLX Harness"),
and the app menu uses explicit labels (`About/Hide/Quit MLX Harness`).

**App bundle.** 0.1.1's updater installs 0.2.0 into the old path
(`/Applications/MLX Studio.app`; it finds the new `MLX Harness.app` in the DMG by
bundle id). 0.2.0 renames itself to `MLX Harness.app` in the same folder after it
quits (`RENAME_SCRIPT`: waits for the PID and for nothing to run from inside the
bundle, one `mv` on the same volume, never over an existing `MLX Harness.app`, log
`userData/updates/rename.log`); if an update is staged, the swap puts the new copy
under `MLX Harness.app` directly. If either can't happen, the app keeps working
under the old name and tries again at the next quit. A running bundle is never
renamed (Electron's helpers and the bundled engine are spawned from its path).

## What changed

Most changes are in the desktop app (`panel/`). The Python engine
(`vmlx_engine/`, PyPI `vmlx`, CLI `vmlx`) is unchanged so upstream merges stay easy.

| Area | Change | Files |
|---|---|---|
| Identity | Product "MLX Harness" (see [The name](#the-name)), appId `app.mlx.studio` (kept), package `mlx-harness`, version from 0.1.0 (0.2.0: the rename), homepage harness.mlx.app, notarisation team CCKXS9W488, DMG `MLX-Harness-<version>-arm64.dmg` | `panel/package.json`, `panel/package-lock.json` (name/version only) |
| Build | `npm run dist` → `panel/scripts/build-harness-dmg.sh` (bundled Python, unsigned or Developer ID-signed DMG). Upstream's attested driver stays as `npm run dist:upstream` | `panel/scripts/build-harness-dmg.sh` |
| Strings | "vMLX" → "MLX Harness" in user-facing text in all five locales, tray, dialogs, window title; credit "Built on vMLX by JANGQ AI"; wire identifiers kept (`X-vMLX-*` headers, gateway liveness text, `vmlx-worker`) | `panel/src/renderer/src/i18n/locales/*.json`, `panel/src/main/{tray,sessions,memory-enforcer,engine-manager,index}.ts`, `panel/src/renderer/index.html` |
| Credits | About panel and Preferences credit vMLX and show "Powered by MTPLX" (required by MTPLX's NOTICE); root `NOTICE` | `panel/src/main/index.ts`, `panel/src/renderer/src/App.tsx`, `NOTICE` |
| Updates | Feed is `raw.githubusercontent.com/MLXapp/harness/main/latest.json` (then the pre-rename path as a fallback); a version without a download is ignored quietly; downloads must be HTTPS on github.com or *.mlx.app. Upstream's "open the DMG in the browser" banner is replaced by an in-app updater (see [Updates](#updates)) | `panel/src/main/app-updater.ts`, `panel/src/shared/appUpdate.ts`, `panel/src/main/update-checker.ts`, `panel/src/main/update-manifest.ts`, `UpdateBanner.tsx`, `latest.json` |
| Promos | Ko-fi, jangq.ai and upstream release links removed from the UI | `App.tsx`, `UpdateBanner.tsx`, `ApiDashboard.tsx`, `ImageGallery.tsx` |
| Look | MLX tokens (mlx.app palette, light + dark following the system, Preferences → Appearance), SF Pro / SF Mono, rounded corners, orange primary buttons, liquid-glass cards; IBM Plex Mono and Google Fonts CSP entries removed | `panel/src/renderer/src/styles/console-tokens.css` (rewritten, same variable names), `index.css`, `tailwind.config.js`, `providers/ThemeProvider.tsx`, `main/csp.ts` |
| Motion | Sidebar width animates and labels fade, selection slides, section tabs are a sliding segmented control, page changes fade in | `components/layout/{ConsoleSidebar,ConsoleSubnavigation,TitleBar}.tsx`, `App.tsx` |
| Brand | MLX emblem components, new app icon and DMG background | `components/brand/Logo.tsx`, `panel/resources/{logo.svg,icon.png}`, `panel/build/dmg-background*`, `panel/src/renderer/public/*.png` |
| Network page | New sidebar page: MLX Network totals, MLX Node status/install/open, wallet live mining, risk explainer | `components/network/NetworkView.tsx`, `main/ipc/network.ts`, `shared/mlxNetwork.ts`, `preload/index.ts`, `env.d.ts`, `types/app-state.ts`, `lib/consoleNavigation.ts`, `shared/nativeNavigation.ts`, `main/application-menu.ts` |
| MLX Node | MLX Harness carries MLX Node (`app.mlx.mac`) and offers it once on first run; Network page and Preferences install or open it. See "MLX Node inside MLX Harness" below | `main/mlx-node.ts`, `shared/mlxNode.ts`, `components/network/{useMlxNode.ts,MlxNodePreference.tsx}`, `main/index.ts`, `scripts/fetch-mlx-node.sh`, `scripts/build-harness-dmg.sh`, `package.json` (`build`), `.github/workflows/harness.yml` |
| CI | `.github/workflows/harness.yml` (workflow "MLX Harness") on macos-26: typecheck and vitest (`panel/scripts/vitest-ci.mjs` tolerates only `panel/tests/known-upstream-failures.json`), DMG on `v*` tags or manual runs, optional Developer ID signing and notarisation from `MAC_CERT_P12`, `MAC_CERT_PASSWORD`, `APPLE_ID`, `APPLE_APP_PASSWORD`, `APPLE_TEAM_ID`. Upstream's dev-build, release-candidate and publish-release workflows (jjang-ai repos, self-hosted runners) are removed; their contract tests in `tests/test_release_automation.py` skip when those files are absent | `.github/workflows/`, `panel/scripts/vitest-ci.mjs`, `tests/test_release_automation.py` |
| Model providers | Chats can use cloud models (15-provider catalog), any OpenAI- or Anthropic-compatible endpoint, and Ollama / LM Studio, next to MLX sessions. See "Model providers" below | `main/providers/*`, `main/ipc/providers.ts`, `main/ipc/chat.ts`, `shared/providers/*`, `components/settings/*`, `components/layout/ChatModeToolbar.tsx`, `App.tsx` |
| Docs | README rewritten; this file | `README.md`, `docs/MLX-HARNESS.md`, `panel/LOGO-README.md` |

Tests that pinned upstream branding or the old theme were updated next to the
change (`panel/tests/*`); new tests cover the update feed and the Network page.

## Model providers

Preferences → Models lists Ollama (127.0.0.1:11434) and LM Studio
(127.0.0.1:1234) while they run, and the providers the user adds: a catalog
entry (`shared/providers/catalog.ts`, endpoints checked against DeepSeek
Harness's provider data; deviations carry a `note`) or a custom endpoint (id,
endpoint, protocol: OpenAI Chat Completions, OpenAI Responses or Anthropic
Messages). Rows live in the `providers` table; API keys only as safeStorage
ciphertext in `credentials` under `provider/<id>` (the table refuses anything
but `enc:` values, and saving refuses when Keychain encryption is unavailable).
The renderer never receives a key: views say `configured: true/false`.
"Fetch available models" lists `GET {base}/models` (bearer) or Anthropic's
`/v1/models` (`x-api-key`); a stored key is only sent to its own endpoint.

The chat model picker groups On this Mac → Local servers → Cloud providers. A
provider pick is stored per chat (`chat_model_bindings`) and wins over the
chat's session; `main/providers/transport.ts` turns it into a remote-shaped
session for the existing remote path plus a fetch that maps `/v1/<route>` onto
the provider base and adds the credential. Anthropic Messages goes through
`main/providers/anthropic.ts` (request and SSE translation, signed thinking
replayed on tool follow-ups), so tools, compaction and approvals run unchanged.

Not done: subscription sign-in (OAuth for consumer plans) needs a terms review;
the seam is `authHeadersFor` in `transport.ts`. A per-chat "continue with a
local model when the cloud model hits its limit" toggle is a follow-up: today
429/quota errors say so and suggest switching the chat to a model on this Mac.

## MLX Node inside MLX Harness

MLX Node is the Mac menu bar app that runs AI jobs for MLX Network and mines MLX
Tokens (formerly "MLX for macOS"; bundle id `app.mlx.mac`, team `CCKXS9W488`). It
is its own signed, notarized, self-updating app; MLX Harness only carries a copy and
installs it.

**Build.** The `dmg` job runs `panel/scripts/fetch-mlx-node.sh` before building:
it downloads `https://mlx.app/api/download/mac` (the public notarized DMG, which
holds `MLX.app` before 0.9.0 and `MLX Node.app` from 0.9.0), mounts it read-only,
checks the app (bundle id, `codesign --verify --deep --strict`, our Developer ID
requirement, `TeamIdentifier`, hardened runtime, `spctl -a -t exec`), copies it
with `ditto` as `MLX Node.app` and stages `panel/resources/bundled-node/MLX
Node.zip` (`ditto -c -k --keepParent`, re-verified after unzipping) plus `MLX
Node.json` (version, build, sha256). The folder is git-ignored. On `v*` tags a
failure fails the build; manual runs warn and build without it.
electron-builder ships the folder via `extraResources` to
`Contents/Resources/bundled-node/` (excluded from `app.asar` in `files`), and
`mac.signIgnore` (`/Contents/Resources/bundled-node/`, matched against absolute
paths by @electron/osx-sign) keeps it from being re-signed. `build-harness-dmg.sh`
checks that the packaged zip matches the staged one and isn't signed; the CI step
"Check MLX Node in the DMG" unzips it from the final DMG and verifies it again.

**Why a zip, not `MLX Node.app` in Resources.** macOS registers apps it finds
inside other bundles with Launch Services and Spotlight. A live copy inside MLX
Harness could answer `mlx://` links or `open -b app.mlx.mac`, run from inside our
bundle, and MLX Node's self-updater would then swap files inside MLX Harness and
break its signature. A zip is never launched; `ditto` restores the app with its
own signature, entitlements and provisioning profile.

**First run** (`main/mlx-node.ts`, decisions in `shared/mlxNode.ts`): after the
window shows, if the settings flag `mlx_node_first_run_offer_v1` isn't set, the app
carries MLX Node and none is installed, it asks "Also install MLX Node?" (Install
MLX Node / Not now). The flag is stored before asking (and when MLX Node is
already installed), so the question never comes back; a build without the copy
doesn't set it. Install: unzip with `ditto` into a hidden folder next to the
destination, check the bundle id, remove `com.apple.quarantine` from that copy
only, verify the signature against our requirement, then rename it to
`/Applications/MLX Node.app` (`~/Applications` when `/Applications` isn't
writable) and open it by path. An existing install (either name, found in the
usual folders or by Spotlight, top-level apps only) is opened, never overwritten;
a different app with the same name is left alone. Failures show a friendly
message and "Get MLX Node" (mlx.app/download).

**Network page and Preferences.** "MLX Node" everywhere (all five languages).
Not installed but carried: "Install MLX Node" (same flow); not carried: "Get MLX
Node". Installed: "Open MLX Node" sends `mlx://open` to the copy we found.
Preferences has an MLX Node row (Installed / Not installed, Open / Install).

## Updates

MLX Harness updates itself, Sparkle-style, like MLX Node. Main process:
`panel/src/main/app-updater.ts` (started by `update-checker.ts`); every rule is a
pure function in `panel/src/shared/appUpdate.ts` (tests:
`panel/tests/app-update-rules.test.ts`, `app-updater-flow.test.ts`,
`update-banner-behavior.test.ts`).

**Checking.** `latest.json` is fetched 5 s after launch, every 6 hours, and from
**MLX Harness → Check for Updates…** (under About; answers "You're up to date",
"MLX Harness x is available" with Update / Later, or "Couldn't check for updates").
`decideUpdate` (update-manifest.ts) only announces a newer version with a trusted
HTTPS download. The state goes to the window over IPC (`app:updateState`; the
renderer asks for it on mount, so a reload or the setup screen loses nothing). If
no MLX Harness window has focus, a macOS notification "MLX Harness x is available"
(first line of `notes`; click brings the window forward) is shown once per
version; the version is remembered in the settings store
(`harness_update_notified_version`). `MLX_HARNESS_SKIP_UPDATE_CHECK=1` turns the
automatic checks off (the menu item still works).

**Installing** (Update in the banner):
1. Download the DMG with `net.fetch` into `userData/updates/` (`.part` until
   complete), with progress to the banner. At the same time the running app is
   checked: bundle id `app.mlx.studio` and `codesign --verify --strict -R=<req>`.
   A copy that isn't our signed app is never replaced (error `currentApp`).
2. Size (when the manifest has one) and SHA-256 must match `latest.json`.
3. `hdiutil attach -readonly -nobrowse -noautoopen -mountpoint <tmp>`; take
   `MLX Harness.app` (or `MLX Studio.app`, or any top-level app with our bundle id;
   a real folder, not a link); bundle id must be
   `app.mlx.studio`, `CFBundleShortVersionString` newer than the running one.
4. `codesign --verify --deep --strict -R='=anchor apple generic and certificate
   1[field.1.2.840.113635.100.6.2.6] exists and certificate
   leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] =
   "CCKXS9W488" and identifier "app.mlx.studio"'` (the two OIDs pin Developer ID,
   as for MLX Node), and `spctl -a -t exec -vv` must say `accepted` with
   `source=Notarized Developer ID`.
5. `ditto` it to `<folder of the running app>/.MLX Harness.update.app` (same folder,
   so the swap is a rename on one volume; also next to a copy still called
   `MLX Studio.app`), verify the copy again, detach the DMG and delete it.
   Banner: **Restart to update**.

Every failure shows a reason and "Download manually" (the latest release page);
the DMG, the mount and any staged copy are removed on every path, and leftovers
of an interrupted attempt (`.MLX Harness.update.app`, `.MLX Harness.old-*.app`, and
the same with `MLX Studio`,
`updates/*.dmg|*.part`) are removed at the next check. All commands run with
`execFile` and argument arrays.

**When it falls back to the DMG** (banner says why, Download opens the DMG URL):
development builds (`!app.isPackaged`, report only), running from a mounted DMG
(`/Volumes/…` other than an Applications folder on another disk), App
Translocation, the app or its folder not writable, or a manifest without SHA-256.

**Swap.** Restart to update calls `app.quit()`; the normal quit runs (engines
stop, the database closes) and, as its last step before `app.exit`,
`runPendingUpdateSwap()` spawns a detached `/bin/sh` script (`SWAP_SCRIPT`; every
path is a positional argument used only in double quotes). It waits for our PID to
exit (up to 5 min), renames the current app to `.<its name>.old-<pid>.app`, renames
the staged copy to the original path, or to `MLX Harness.app` when the app was
still called `MLX Studio.app` and nothing is at that name (if that fails, the old
one is renamed back and reopened), removes `com.apple.quarantine` from the new app only if present,
opens it with `open`, then deletes the old copy. Log: `userData/updates/swap.log`.
A plain quit with an update staged installs it without relaunching; a quit that was
cancelled (an engine wouldn't stop) doesn't relaunch later.

**Shipping a version.** Bump `version` in `panel/package.json` (it must be newer
than the one in `latest.json`), commit to `main`, run the **MLX Harness** workflow
with `release` checked (or push a `v<version>` tag). The `dmg` job signs and
notarizes; the `release` job publishes the GitHub release and commits the new
`latest.json` (`version`, `url`, `sha256`, `size`, `notes`). Running copies see it
within 6 hours or at once with Check for Updates…. The banner and notification
show `notes`; to say more than the default line, edit `notes` in `latest.json` on
`main` after the release (the DMG fields must stay as written). A release whose
DMG isn't signed and notarized by team CCKXS9W488 is refused by every running copy
(they offer the manual download instead).

## Installing from the DMG (0.5.5)

The DMG holds just `MLX Harness.app` at its root (no Applications link; the
background says "Open MLX Harness to install"). The in-app updater still finds the
app there by name and bundle id (`findHarnessApp`), and CI fails a DMG without it
or with an Applications link.

Opened from a mounted disk image (or App-Translocated by macOS), the app shows a
small install window instead of starting (`panel/src/main/app-installer.ts`, page
`app-installer-page.ts`, preload `src/preload/installer.ts`; rules in
`shared/appInstall.ts`, tests `tests/app-install-rules.test.ts`). It runs right after
app ready, before the engine check, the preview server, the menu or any window;
the single-instance lock may be held by an installed copy (then the installer
still opens and offers to quit and replace it).

- **Never a downgrade.** The same or a newer MLX Harness (bundle id
  `app.mlx.studio`) in `/Applications` or `~/Applications` (either name), or
  running anywhere, gets "Open MLX Harness" instead of Install. A version that
  can't be read counts as not older.
- **Install.** Older copies that are running are asked to quit (SIGTERM: their
  own clean shutdown; up to 90 s, then their engines up to 30 s), the plan is
  made again (a quitting copy may have swapped in a staged update), then `ditto`
  copies the app to `.MLX Harness.install.app` next to the destination in a child
  process (the bar follows `du` of the copy; free space is checked first), the
  copy must carry our bundle id and this version and pass `codesign --verify
  --strict` against `HARNESS_REQUIREMENT` (an unsigned build passes only when the
  original fails too), loses its quarantine flag, and replaces the older copy with
  two renames (the old one is deleted). Other older copies in the Applications
  folders go to the Trash. `/Applications` is used when writable, else
  `~/Applications`; an app with our name that isn't ours is never touched.
- **After.** The window fades out, the app exits, and a detached script
  (`RELAUNCH_SCRIPT`, positional arguments only) waits for the PID, opens the
  installed copy and ejects the disk image without force (retrying up to 20 s,
  left mounted if busy). Log: `userData/updates/install.log`.
- **Why not `app.moveToApplicationsFolder()`:** Electron's mover copies the
  bundle (about 1.5 GB) with NSFileManager on the main thread, so the window would
  freeze with no progress; on the password path it never calls its
  `conflictHandler` (it `rm -rf`s the destination), and it can't eject a disk
  image the app was translocated from.
- **Opting out:** `--mlx-no-install` or `MLX_HARNESS_NO_INSTALLER=1` starts the app
  from the DMG as before (the updater then offers the manual download). CI's
  self-test (`--mlx-self-test`) never shows the installer; it draws the install
  window hidden and runs a real copy of the app through the same copy and
  signature checks into a temporary folder.

## Merging upstream updates

```bash
git remote add upstream https://github.com/jjang-ai/vmlx.git   # once
git fetch upstream
git log --oneline main..upstream/main                          # what's new

# Usually: merge, then resolve conflicts in the files listed above
git checkout -b merge-upstream
git merge upstream/main
# or pick specific fixes
git cherry-pick <sha>...
```

When resolving conflicts:

- **Locales** (`panel/src/renderer/src/i18n/locales/*.json`): take upstream's new
  keys, keep ours. New upstream strings that say "vMLX" in user-facing text should
  say "MLX Harness" (keep the credit lines). Run `npx vitest run tests/i18n-*.test.ts`.
- **package.json**: keep our name, productName, version, appId, team, artifact
  name and `dist` script; take upstream's dependency bumps (then `npm install`
  to refresh the lock file and re-apply our name/version in it).
- **console-tokens.css / index.css**: keep ours; if upstream adds a new token,
  add it with MLX values for both themes.
- **update-checker.ts / app-updater.ts / UpdateBanner.tsx**: keep ours (feed and
  in-app updater); take upstream fixes to manifest parsing.
- **App.tsx / ConsoleSidebar.tsx**: keep the Network entry, Appearance control,
  credits and MTPLX attribution.
- Engine (`vmlx_engine/`, `tests/`, `pyproject.toml`): take upstream as is.

Then run `cd panel && npx tsc --noEmit && npx vitest run`, build a DMG on a Mac
and check the Network page, light and dark.

## Known pre-existing test failures (upstream, Linux)

On Linux these panel tests fail before and after our changes (they need macOS
tools, upstream's release environment or have stale fixtures):
`download-system` (2), `image-autodetect-paths` (1),
`live-real-ui-model-proof-harness` (1), `release-packaging` (5, upstream release
driver), `settings-flow` "cache panels surface native cache…" (1),
`tool-executor-security` AppleScript (1, needs `osascript`).
On macOS CI, `release-packaging` "preserves the macOS standalone-Python loader…" also
fails (needs upstream's repo `.venv`). The list CI tolerates is
`panel/tests/known-upstream-failures.json`.
