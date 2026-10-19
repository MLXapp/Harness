export function buildContentSecurityPolicy(options: { devRenderer?: boolean } = {}): string {
  const scriptSrc = options.devRenderer
    ? " script-src 'self' 'unsafe-inline';"
    : " script-src 'self';"

  return (
    "default-src 'self';" +
    scriptSrc +
    // MLX Studio uses the system fonts (SF Pro / SF Mono): no web fonts.
    " style-src 'self' 'unsafe-inline';" +
    " font-src 'self' data:;" +
    // ms#75: allow hf-mirror.com and modelscope.cn so users in mainland
    // China can load README images and previews when the hf_endpoint setting
    // points at a mirror.
    " img-src 'self' data: blob: http://127.0.0.1:* http://localhost:* https://huggingface.co https://*.huggingface.co https://raw.githubusercontent.com https://hf-mirror.com https://*.hf-mirror.com https://modelscope.cn https://*.modelscope.cn;" +
    " connect-src 'self' http://127.0.0.1:* http://localhost:* https://huggingface.co https://*.huggingface.co https://hf-mirror.com https://*.hf-mirror.com https://modelscope.cn https://*.modelscope.cn;" +
    // Chat audio/video attachments are persisted and rendered as local data
    // URLs. Keep remote media blocked while allowing those local payloads and
    // object URLs created by the renderer.
    " media-src 'self' data: blob:;"
  )
}
