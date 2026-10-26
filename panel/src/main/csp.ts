/**
 * The renderer's policy. Sent as a response header for loads that go through
 * the session's webRequest (the dev server), and written into index.html as a
 * <meta http-equiv> at build time (`meta: true`), because the packaged
 * window loads a file:// page that may get no headers. Both apply where both
 * exist, so the meta copy allows any 127.0.0.1 port for the preview frame and
 * the header narrows it to the preview server's port.
 * frame-ancestors is ignored in a <meta> policy, so only the header sends it.
 */
export function buildContentSecurityPolicy(options: { devRenderer?: boolean; previewOrigin?: string | null; meta?: boolean } = {}): string {
  const scriptSrc = options.devRenderer
    ? " script-src 'self' 'unsafe-inline';"
    : " script-src 'self';"

  return (
    "default-src 'self';" +
    scriptSrc +
    // MLX Harness uses the system fonts (SF Pro / SF Mono): no web fonts.
    " style-src 'self' 'unsafe-inline';" +
    " font-src 'self' data:;" +
    // ms#75: allow hf-mirror.com and modelscope.cn so users in mainland
    // China can load README images and previews when the hf_endpoint setting
    // points at a mirror.
    " img-src 'self' data: blob: mlx-media: http://127.0.0.1:* http://localhost:* https://huggingface.co https://*.huggingface.co https://raw.githubusercontent.com https://hf-mirror.com https://*.hf-mirror.com https://modelscope.cn https://*.modelscope.cn;" +
    // mlx-media: lets the Audio and Music tabs read a result they made to draw
    // its waveform (the scheme serves only MLX Harness's own media folder).
    " connect-src 'self' blob: mlx-media: http://127.0.0.1:* http://localhost:* https://huggingface.co https://*.huggingface.co https://hf-mirror.com https://*.hf-mirror.com https://modelscope.cn https://*.modelscope.cn;" +
    // Chat audio/video attachments are persisted and rendered as local data
    // URLs. Keep remote media blocked while allowing those local payloads,
    // object URLs created by the renderer, and generated media from MLX
    // Harness's own folder (mlx-media://, main/media/protocol.ts).
    " media-src 'self' data: blob: mlx-media:;" +
    // The workspace panel shows a reply's website from MLX Harness's own
    // preview server (main/workspace/previewServer.ts, 127.0.0.1 only).
    (options.meta
      ? " frame-src 'self' http://127.0.0.1:*;"
      : ` frame-src 'self'${options.previewOrigin && /^http:\/\/127\.0\.0\.1:\d+$/.test(options.previewOrigin) ? ` ${options.previewOrigin}` : ''};`) +
    // No plugins, no <base> rewriting relative URLs, no form posting the page away.
    " object-src 'none'; base-uri 'none'; form-action 'none';" +
    (options.meta ? '' : " frame-ancestors 'none';")
  )
}
