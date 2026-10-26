import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { execFileSync } from 'child_process'
// The renderer's policy lives with the main process (src/main/csp.ts, type-checked there).
// @ts-ignore TS6307: that file belongs to the main tsconfig, not this one.
import { buildContentSecurityPolicy } from './src/main/csp'

function rendererSourceCommit(): string {
  const commit = execFileSync(
    'git',
    ['-C', __dirname, 'rev-parse', 'HEAD'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim()
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`Cannot attest renderer source commit: ${commit || 'empty'}`)
  }
  return commit
}

const sourceCommit = rendererSourceCommit()

/**
 * Production builds carry the renderer's content security policy in
 * index.html itself, so it holds for the packaged file:// page too. Dev
 * (vite serve, HMR) is left alone: there the policy comes as a header.
 */
function rendererCspMeta() {
  return {
    name: 'mlx-renderer-csp-meta',
    apply: 'build' as const,
    transformIndexHtml: {
      order: 'post' as const,
      handler(html: string): string {
        const policy = buildContentSecurityPolicy({ meta: true })
        const tag = `<meta http-equiv="Content-Security-Policy" content="${policy}" />`
        const charset = /<meta charset="UTF-8"\s*\/?>/i
        if (!charset.test(html)) throw new Error('renderer index.html: no charset meta to place the CSP after')
        return html.replace(charset, m => `${m}\n    ${tag}`)
      },
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['uuid'] })],
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        },
        output: {
          format: 'es'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          // The install window shown when MLX Harness is opened from its disk image.
          installer: resolve(__dirname, 'src/preload/installer.ts')
        }
      }
    }
  },
  renderer: {
    define: {
      // Derived directly from this checkout. Release proof independently
      // requires a clean tree and compares this value to the frozen HEAD.
      __VMLINUX_BUILD_SOURCE_COMMIT__: JSON.stringify(sourceCommit)
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer')
      }
    },
    plugins: [react(), rendererCspMeta()]
  }
})
