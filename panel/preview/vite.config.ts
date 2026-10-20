/**
 * Browser preview of the renderer (no Electron). Same React plugin, alias and
 * define as the renderer section of electron.vite.config.ts; Tailwind and
 * PostCSS use the panel's own configs. Output goes to preview/dist (ignored),
 * never into the Electron app's dist/ or out/.
 *
 *   npm run preview:ui      dev server on http://127.0.0.1:5199
 *   npm run preview:build   static build in preview/dist
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'

const panel = resolve(__dirname, '..')
const requireCjs = createRequire(import.meta.url)

function sourceCommit(): string {
  try {
    const commit = execFileSync('git', ['-C', panel, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return /^[0-9a-f]{40}$/.test(commit) ? commit : 'preview'
  } catch {
    return 'preview'
  }
}

export default defineConfig({
  root: __dirname,
  base: './',
  // The renderer's favicons and app icon.
  publicDir: resolve(panel, 'src/renderer/public'),
  define: {
    __VMLINUX_BUILD_SOURCE_COMMIT__: JSON.stringify(sourceCommit()),
  },
  resolve: {
    alias: {
      '@': resolve(panel, 'src/renderer'),
    },
  },
  plugins: [react()],
  css: {
    postcss: {
      plugins: [
        tailwindcss({
          // tailwind.config.js lists content paths relative to the panel; the
          // preview runs from preview/, so anchor them here.
          ...requireCjs(resolve(panel, 'tailwind.config.js')),
          content: [
            resolve(panel, 'src/renderer/index.html'),
            resolve(panel, 'src/renderer/**/*.{ts,tsx}'),
            resolve(__dirname, '*.{html,ts,tsx}'),
          ],
        }),
        autoprefixer(),
      ],
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5199,
    strictPort: false,
    fs: { allow: [panel] },
  },
  preview: {
    host: '127.0.0.1',
    port: 5199,
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 8000,
  },
  esbuild: {
    target: 'es2022',
  },
})
