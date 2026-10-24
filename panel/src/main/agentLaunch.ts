/**
 * "Open in Terminal": run a coding agent against MLX Harness for one Terminal
 * window, without changing the agent's own settings. Each plan writes a small
 * private profile under MLX Harness's own folder and a launcher script that
 * points the agent at it through the agent's documented overrides:
 *
 *  - Claude Code: CLAUDE_CONFIG_DIR (private) + --settings, core tools only
 *    (each tool's schema goes into the local model's first prompt).
 *  - Codex CLI: CODEX_HOME (private) with its own config.toml.
 *  - OpenCode: OPENCODE_CONFIG (an extra config file, merged over the user's).
 *  - Aider and Qwen Code: environment variables and flags for this run.
 *
 * The approach follows Rapid-MLX's isolated agent profiles (Apache-2.0); this
 * is our own implementation. Pure: no file system here (tests/agent-launch.test.ts).
 */

export type LaunchToolId = 'claude-code' | 'codex' | 'opencode' | 'aider' | 'qwen-code'

export const LAUNCH_TOOLS: readonly LaunchToolId[] = ['claude-code', 'codex', 'opencode', 'aider', 'qwen-code']

export const LAUNCH_TOOL_NAMES: Record<LaunchToolId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex CLI',
  opencode: 'OpenCode',
  aider: 'Aider',
  'qwen-code': 'Qwen Code',
}

export interface LaunchInput {
  /** http://127.0.0.1:<port> (no /v1). */
  base: string
  model: string
  /** Key the local API accepts (a placeholder when it needs none). */
  key: string
  contextWindow: number
  /** This tool's private profile folder. */
  root: string
  /** Folder to start in. */
  cwd: string
}

export interface LaunchPlan {
  /** Private files to write (absolute path → content), mode 0600. */
  files: Record<string, string>
  /** The launcher script (zsh), mode 0700. */
  script: string
}

/** A single-quoted shell word ('it'\''s'). */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function tomlString(value: string): string {
  // JSON escapes are TOML escapes, except DEL, which TOML wants escaped too.
  return JSON.stringify(value).replace(/\u007f/g, '\\u007F')
}

export function launchPlan(tool: LaunchToolId, input: LaunchInput): LaunchPlan {
  const { base, model, key, contextWindow, root, cwd } = input
  const v1 = `${base}/v1`
  const files: Record<string, string> = {}
  const env: Array<[string, string]> = []
  let command: string

  switch (tool) {
    case 'claude-code': {
      const settings = `${root}/settings.json`
      files[settings] = JSON.stringify({
        env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_MODEL: model },
      }, null, 2) + '\n'
      env.push(['CLAUDE_CONFIG_DIR', `${root}/config`])
      command = `claude --settings ${shq(settings)} --tools Bash,Edit,Read,Write,Glob,Grep`
      break
    }
    case 'codex': {
      files[`${root}/config.toml`] = [
        `model = ${tomlString(model)}`,
        'model_provider = "mlxharness"',
        `model_context_window = ${Math.max(1, Math.round(contextWindow))}`,
        '',
        '[model_providers.mlxharness]',
        'name = "MLX Harness (this Mac)"',
        `base_url = ${tomlString(v1)}`,
        'wire_api = "responses"',
        'env_key = "MLX_HARNESS_API_KEY"',
        '',
      ].join('\n')
      env.push(['CODEX_HOME', root], ['MLX_HARNESS_API_KEY', key])
      command = 'codex'
      break
    }
    case 'opencode': {
      const config = `${root}/opencode.json`
      files[config] = JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        provider: {
          mlxharness: {
            npm: '@ai-sdk/openai-compatible',
            name: 'MLX Harness (this Mac)',
            options: { baseURL: v1, apiKey: key },
            models: { [model]: { name: model, limit: { context: contextWindow, output: 8192 } } },
          },
        },
        model: `mlxharness/${model}`,
      }, null, 2) + '\n'
      env.push(['OPENCODE_CONFIG', config])
      command = 'opencode'
      break
    }
    case 'aider': {
      env.push(['OPENAI_API_BASE', v1], ['AIDER_OPENAI_API_BASE', v1], ['OPENAI_API_KEY', key], ['AIDER_OPENAI_API_KEY', key])
      command = `aider --model ${shq(`openai/${model}`)}`
      break
    }
    case 'qwen-code': {
      env.push(['OPENAI_BASE_URL', v1], ['OPENAI_API_KEY', key], ['OPENAI_MODEL', model])
      command = `qwen --auth-type openai --model ${shq(model)} --openai-base-url ${shq(v1)}`
      break
    }
  }

  const name = LAUNCH_TOOL_NAMES[tool]
  const script = [
    '#!/bin/zsh -l',
    `# MLX Harness: ${name} with ${model.replace(/[\r\n]/g, ' ')} on this Mac.`,
    '# This window only; your own settings for it stay as they are.',
    `cd ${shq(cwd)} 2>/dev/null || cd "$HOME"`,
    ...env.map(([k, val]) => `export ${k}=${shq(val)}`),
    `printf '\\033[2mMLX Harness · %s · %s\\033[0m\\n\\n' ${shq(name)} ${shq(model)}`,
    `exec ${command}`,
    '',
  ].join('\n')
  return { files, script }
}
