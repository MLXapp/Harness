import { describe, expect, it } from 'vitest'
import { launchPlan, shq, LAUNCH_TOOLS } from '../src/main/agentLaunch'

const input = { base: 'http://127.0.0.1:8080', model: "Qwen3.5-9B-4bit", key: 'mlxharness', contextWindow: 32768, root: '/Users/a/Library/Application Support/MLX Harness/connect/x', cwd: '/Users/a' }

describe('Open in Terminal launch plans', () => {
  it('quotes shell words safely', () => {
    expect(shq("it's")).toBe(`'it'\\''s'`)
    expect(shq('$(rm -rf ~)')).toBe(`'$(rm -rf ~)'`)
  })

  it("Claude Code: private config dir and settings; the user's ~/.claude is never named", () => {
    const p = launchPlan('claude-code', input)
    const settings = JSON.parse(p.files[`${input.root}/settings.json`])
    expect(settings.env).toEqual({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8080', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: 'mlxharness', ANTHROPIC_MODEL: 'Qwen3.5-9B-4bit' })
    expect(p.script).toContain(`export CLAUDE_CONFIG_DIR='${input.root}/config'`)
    expect(p.script).toContain(`exec claude --settings '${input.root}/settings.json' --tools Bash,Edit,Read,Write,Glob,Grep`)
    expect(p.script).not.toContain('.claude/')
    expect(p.script.startsWith('#!/bin/zsh -l\n')).toBe(true)
  })

  it('Codex: its own CODEX_HOME with a provider at /v1', () => {
    const p = launchPlan('codex', input)
    const toml = p.files[`${input.root}/config.toml`]
    expect(toml).toContain('model = "Qwen3.5-9B-4bit"')
    expect(toml).toContain('base_url = "http://127.0.0.1:8080/v1"')
    expect(toml).toContain('model_context_window = 32768')
    expect(p.script).toContain(`export CODEX_HOME='${input.root}'`)
    expect(p.script).toContain('exec codex\n')
  })

  it('OpenCode, Aider and Qwen Code: an extra config or environment for this run', () => {
    const oc = launchPlan('opencode', input)
    expect(JSON.parse(oc.files[`${input.root}/opencode.json`]).model).toBe('mlxharness/Qwen3.5-9B-4bit')
    expect(oc.script).toContain('export OPENCODE_CONFIG=')
    const aider = launchPlan('aider', input)
    expect(aider.files).toEqual({})
    expect(aider.script).toContain("export OPENAI_API_BASE='http://127.0.0.1:8080/v1'")
    expect(aider.script).toContain("exec aider --model 'openai/Qwen3.5-9B-4bit'")
    const qwen = launchPlan('qwen-code', input)
    expect(qwen.script).toContain("exec qwen --auth-type openai --model 'Qwen3.5-9B-4bit' --openai-base-url 'http://127.0.0.1:8080/v1'")
  })

  it('Codex: control characters stay escaped in TOML', () => {
    const toml = launchPlan('codex', { ...input, model: 'a\u007fb"c' }).files[`${input.root}/config.toml`]
    expect(toml).toContain('model = "a\\u007Fb\\"c"')
  })

  it('a hostile model name stays one word in every script', () => {
    for (const tool of LAUNCH_TOOLS) {
      const p = launchPlan(tool, { ...input, model: "x'; rm -rf ~; echo '" })
      expect(p.script).not.toMatch(/; rm -rf ~;(?![^']*')/)
    }
  })
})
