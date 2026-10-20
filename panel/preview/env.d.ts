declare global {
  /** Injected by preview/vite.config.ts (same define as the renderer build). */
  const __VMLINUX_BUILD_SOURCE_COMMIT__: string
  // Mirrors src/renderer/src/main.tsx (runtime provenance read by the release gate).
  var __VMLINUX_SOURCE_COMMIT__: string | undefined
}

export {}
