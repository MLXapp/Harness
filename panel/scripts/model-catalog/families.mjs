/**
 * The models on the Models page (Download), by family. Each entry is one
 * model; its builds are found on Hugging Face by build.mjs, which records
 * each one's real download size. Standard builds are `<base>-<quant>`;
 * abliterated builds (refusals removed by abliteration, incl. Heretic and
 * "OBLITERATED") are listed by hand and only when they are the same model.
 *
 * category: general | coding | small | vision | large
 */
export const QUANTS = ['4bit', '5bit', '6bit', '8bit', 'bf16']

export const FAMILIES = [
  { id: 'qwen3.8-27b', name: 'Qwen3.8 27B', maker: 'Qwen', category: 'general', vision: true,
    base: 'mlx-community/Qwen3.8-27B', abliterated: ['mlx-community/Qwen3.8-27B-OBLITERATED-OptiQ-4bit'] },
  { id: 'qwen3.8-flash-next', name: 'Qwen3.8 Flash Next', maker: 'Qwen', category: 'general', vision: true,
    base: 'mlx-community/Qwen3.8-Flash-Next' },
  { id: 'qwen3.6-35b-a3b', name: 'Qwen3.6 35B-A3B', maker: 'Qwen', category: 'general', vision: true,
    base: 'mlx-community/Qwen3.6-35B-A3B', abliterated: ['mlx-community/Huihui-Qwen3.6-35B-A3B-abliterated-4.4bit-msq'] },
  { id: 'qwen3.6-27b', name: 'Qwen3.6 27B', maker: 'Qwen', category: 'general', vision: true,
    base: 'mlx-community/Qwen3.6-27B', abliterated: ['mlx-community/Qwen3.6-27B-OBLITERATED-MLX-4bit', 'mlx-community/Huihui-Qwen3.6-27B-abliterated-4.5bit-msq'] },
  { id: 'gemma-4-31b', name: 'Gemma 4 31B', maker: 'Google', category: 'general', vision: true,
    base: 'mlx-community/gemma-4-31b-it', abliterated: ['mlx-community/gemma-4-31B-it-uncensored-heretic-4bit'] },
  { id: 'gemma-4-26b-a4b', name: 'Gemma 4 26B-A4B', maker: 'Google', category: 'general', vision: true,
    base: 'mlx-community/gemma-4-26b-a4b-it', abliterated: ['mlx-community/gemma-4-26B-A4B-it-heretic-4bit'] },
  { id: 'gemma-4-12b', name: 'Gemma 4 12B', maker: 'Google', category: 'general', vision: true,
    base: 'mlx-community/gemma-4-12B-it' },
  { id: 'gpt-oss-20b', name: 'gpt-oss 20B', maker: 'OpenAI', category: 'general',
    builds: [
      ['mlx-community/gpt-oss-20b-MXFP4-Q8', 'MXFP4 · 8-bit'],
      ['mlx-community/gpt-oss-20b-MXFP4-Q4', 'MXFP4 · 4-bit'],
      ['mlx-community/gpt-oss-20b-mxfp4-bf16', 'MXFP4 · 16-bit'],
    ] },
  { id: 'nemotron-3.5-lightning', name: 'Nemotron 3.5 Lightning 30B-A3B', maker: 'NVIDIA', category: 'general',
    base: 'mlx-community/NVIDIA-Nemotron-3.5-Lightning-30B-A3B' },
  { id: 'mistral-small-3.2', name: 'Mistral Small 3.2 24B', maker: 'Mistral AI', category: 'general',
    base: 'mlx-community/Mistral-Small-3.2-24B-Instruct-2506' },
  { id: 'llama-3.3-70b', name: 'Llama 3.3 70B', maker: 'Meta', category: 'large',
    base: 'mlx-community/Llama-3.3-70B-Instruct' },

  { id: 'qwen3-coder-next', name: 'Qwen3 Coder Next', maker: 'Qwen', category: 'coding',
    base: 'mlx-community/Qwen3-Coder-Next' },
  { id: 'qwen3-coder-30b-a3b', name: 'Qwen3 Coder 30B-A3B', maker: 'Qwen', category: 'coding',
    base: 'mlx-community/Qwen3-Coder-30B-A3B-Instruct' },
  { id: 'devstral-small-2', name: 'Devstral Small 2 24B', maker: 'Mistral AI', category: 'coding', vision: true,
    base: 'mlx-community/Devstral-Small-2-24B-Instruct-2512' },

  { id: 'qwen3.5-9b', name: 'Qwen3.5 9B', maker: 'Qwen', category: 'small', vision: true,
    base: 'mlx-community/Qwen3.5-9B' },
  { id: 'qwen3.5-4b', name: 'Qwen3.5 4B', maker: 'Qwen', category: 'small',
    base: 'mlx-community/Qwen3.5-4B' },
  { id: 'qwen3.5-2b', name: 'Qwen3.5 2B', maker: 'Qwen', category: 'small', vision: true,
    base: 'mlx-community/Qwen3.5-2B' },
  { id: 'qwen3.5-0.8b', name: 'Qwen3.5 0.8B', maker: 'Qwen', category: 'small', vision: true,
    base: 'mlx-community/Qwen3.5-0.8B' },
  { id: 'gemma-4-e4b', name: 'Gemma 4 E4B', maker: 'Google', category: 'small', vision: true,
    base: 'mlx-community/gemma-4-e4b-it', abliterated: ['mlx-community/gemma-4-E4B-it-OBLITERATED-mlx-8Bit', 'mlx-community/gemma-4-E4B-it-OBLITERATED-mlx-fp16'] },
  { id: 'gemma-4-e2b', name: 'Gemma 4 E2B', maker: 'Google', category: 'small', vision: true,
    base: 'mlx-community/gemma-4-e2b-it' },
  { id: 'llama-3.2-3b', name: 'Llama 3.2 3B', maker: 'Meta', category: 'small',
    base: 'mlx-community/Llama-3.2-3B-Instruct', abliterated: ['mlx-community/Llama-3.2-3B-Instruct-abliterated-6bit'] },
  { id: 'phi-4-mini', name: 'Phi-4 mini', maker: 'Microsoft', category: 'small',
    base: 'mlx-community/Phi-4-mini-instruct' },
  { id: 'lfm2.5-1.2b', name: 'LFM2.5 1.2B', maker: 'Liquid AI', category: 'small',
    base: 'mlx-community/LFM2.5-1.2B-Instruct' },

  { id: 'olmocr-2-7b', name: 'olmOCR 2 7B', maker: 'Ai2', category: 'vision', vision: true,
    base: 'mlx-community/olmOCR-2-7B-1025' },
  { id: 'glm-ocr', name: 'GLM-OCR', maker: 'Z.ai', category: 'vision', vision: true,
    base: 'mlx-community/GLM-OCR' },

  { id: 'qwen3.5-122b-a10b', name: 'Qwen3.5 122B-A10B', maker: 'Qwen', category: 'large', vision: true,
    base: 'mlx-community/Qwen3.5-122B-A10B', abliterated: ['mlx-community/Qwen3.5-122B-A10B-heretic-v2-2.34bit-msq'] },
  { id: 'gpt-oss-120b', name: 'gpt-oss 120B', maker: 'OpenAI', category: 'large',
    builds: [
      ['mlx-community/gpt-oss-120b-MXFP4-Q8', 'MXFP4 · 8-bit'],
      ['mlx-community/gpt-oss-120b-MXFP4-Q4', 'MXFP4 · 4-bit'],
      ['mlx-community/gpt-oss-120b-4bit', '4-bit'],
    ] },
]
