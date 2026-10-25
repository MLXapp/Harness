export function buildContentSecurityPolicy(options: { devRenderer?: boolean; previewOrigin?: string | null } = {}): string {
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
    ` frame-src 'self'${options.previewOrigin && /^http:\/\/127\.0\.0\.1:\d+$/.test(options.previewOrigin) ? ` ${options.previewOrigin}` : ''};`
  )
}
