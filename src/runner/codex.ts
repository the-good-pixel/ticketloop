import { spawn } from 'node:child_process'
import type { McpServerConfig } from '../types.js'
import { log } from '../logger.js'
import { registerChild, unregisterChild } from './children.js'
import { parseResetHint } from './claude.js'
import type { AgentResult, RunAgentOpts } from './types.js'
import type { ProviderFailure } from '../types.js'
import { createStageWatchdog, stageTimeoutMessage } from './watchdog.js'

export function classifyCodexFailure(message: string): ProviderFailure | undefined {
  const text = message || ''
  if (/usage[_ -]?limit|quota[_ -]?(?:exceeded|reached)|rate[_ -]?limit[_ -]?reached|limit reached|you(?:'ve| have) hit your limit/i.test(text)) {
    return { kind: 'quota-exhausted', provider: 'codex', message: text.slice(0, 500), retryAt: parseResetHint(text) }
  }
  if (/too many requests|(?:status|status_code|http|code)\D{0,12}429\b|rate[_ -]?limited/i.test(text)) {
    return { kind: 'throttled', provider: 'codex', message: text.slice(0, 500), retryAt: parseResetHint(text) }
  }
  if (/unauthorized|forbidden|authentication|invalid.*(?:token|credential)|\b401\b|\b403\b/i.test(text)) {
    return { kind: 'auth', provider: 'codex', message: text.slice(0, 500) }
  }
  return undefined
}

function toml(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return `[${v.map(toml).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.entries(v).map(([k, val]) => `${JSON.stringify(k)}=${toml(val)}`).join(',')}}`
  }
  return '""'
}

function addMcpArgs(args: string[], servers?: Record<string, McpServerConfig>) {
  for (const [name, server] of Object.entries(servers || {})) {
    const base = `mcp_servers.${JSON.stringify(name)}`
    for (const key of ['command', 'args', 'url', 'env'] as const) {
      const value = server[key]
      if (value !== undefined) args.push('-c', `${base}.${key}=${toml(value)}`)
    }
  }
}

export function buildCodexArgs(o: RunAgentOpts): { args: string[]; prompt: string } {
  const provider = o.runner.providers.codex
  const model = o.stage.model || provider.defaultModel
  const effort = o.stage.effort || provider.defaultEffort
  let prompt = o.prompt
  if (o.stage.skill) prompt = `Use the $${o.stage.skill} skill for this step.\n\n${prompt}`
  // ticketloop owns checkpoints and may use a multi-repo container as cwd, so
  // Codex sessions stay ephemeral and its single-repo cwd check is not useful.
  const args = ['exec', '-', '--json', '--ephemeral', '--skip-git-repo-check', '--color', 'never', '--model', model]
  if (effort) args.push('-c', `model_reasoning_effort=${toml(effort)}`)
  const mode = o.stage.permissionMode || o.runner.permissionMode
  if (mode === 'bypass') args.push('--dangerously-bypass-approvals-and-sandbox')
  else {
    args.push('--sandbox', mode === 'acceptEdits' ? 'workspace-write' : 'read-only')
    args.push('-c', 'approval_policy="never"')
  }
  addMcpArgs(args, o.mcp)
  return { args, prompt }
}

export async function runCodex(o: RunAgentOpts): Promise<AgentResult> {
  if (o.mock) return mockCodex(o)
  const provider = o.runner.providers.codex
  const model = o.stage.model || provider.defaultModel
  const { args, prompt } = buildCodexArgs(o)
  const env = { ...process.env, ...(o.env || {}) }
  if (o.authMode === 'subscription') {
    delete env.OPENAI_API_KEY
    delete env.CODEX_API_KEY
  }

  return new Promise((resolve) => {
    const child = spawn(provider.bin, args, { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    const pgid = child.pid || 0
    const inflightKey = pgid ? registerChild(pgid, { model, ticketKey: o.ticketKey }) : ''
    const reap = () => { if (pgid) unregisterChild(pgid, inflightKey) }
    let settled = false
    let text = ''
    let stderr = ''
    let raw = ''
    let buf = ''
    let isError = false
    let completed = false
    let failureText = ''
    let input = 0
    let output = 0
    let cacheRead = 0
    const killTree = (sig: NodeJS.Signals) => {
      try { if (child.pid) process.kill(-child.pid, sig) }
      catch { try { child.kill(sig) } catch { /* already gone */ } }
    }
    let forceKillTimer: NodeJS.Timeout | null = null
    const watchdog = createStageWatchdog(
      o.runner.stageTimeoutSec ?? 900,
      o.runner.stageIdleTimeoutSec ?? 1800,
      () => {
        killTree('SIGTERM')
        forceKillTimer = setTimeout(() => killTree('SIGKILL'), 3000)
      },
    )

    const parseLine = (line: string) => {
      if (!line.trim()) return
      try {
        const ev = JSON.parse(line)
        if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') text = ev.item.text
        if (ev.type === 'turn.completed') {
          completed = true
          if (ev.usage) {
            cacheRead = Number(ev.usage.cached_input_tokens || 0)
            input = Math.max(0, Number(ev.usage.input_tokens || 0) - cacheRead)
            output = Number(ev.usage.output_tokens || 0)
          }
        }
        if (ev.type === 'turn.failed' || ev.type === 'error') {
          isError = true
          failureText += `${JSON.stringify(ev)}\n`
        }
      } catch { /* partial or non-JSON line */ }
    }
    child.stdout.on('data', (d) => {
      watchdog.touch()
      const chunk = d.toString()
      raw += chunk
      buf += chunk
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        parseLine(buf.slice(0, idx))
        buf = buf.slice(idx + 1)
      }
    })
    child.stderr.on('data', (d) => {
      watchdog.touch()
      stderr += d.toString()
    })
    child.stdin.end(prompt)
    child.on('error', (err) => {
      if (settled) return
      settled = true
      watchdog.clear()
      if (forceKillTimer) clearTimeout(forceKillTimer)
      reap()
      resolve(errorResult(model, `failed to spawn "${provider.bin}": ${err.message}`))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      watchdog.clear()
      if (forceKillTimer) clearTimeout(forceKillTimer)
      reap()
      parseLine(buf)
      if (stderr.trim()) log.debug(`codex stderr: ${stderr.trim().slice(0, 500)}`)
      const timeoutKind = watchdog.timedOut()
      if (timeoutKind) return resolve(errorResult(model, stageTimeoutMessage(timeoutKind, o.runner)))
      if (code !== 0) isError = true
      if (!text && isError) text = `codex exited ${code}: ${stderr.trim().slice(0, 300)}`
      // Only failure events and a failed process may classify provider errors.
      // Agent messages and successful event streams can mention "429" as task
      // content; scanning them caused the MRM-187 false quota stop.
      const failure = !completed && isError
        ? classifyCodexFailure(`${failureText}\n${stderr}`)
        : undefined
      resolve({
        text,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: 0,
        totalTokens: input + output + cacheRead,
        costUsd: 0,
        provider: 'codex',
        model,
        isError,
        failure,
        raw,
      })
    })
  })
}

function errorResult(model: string, text: string): AgentResult {
  return { text, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, costUsd: 0, provider: 'codex', model, isError: true }
}

async function mockCodex(o: RunAgentOpts): Promise<AgentResult> {
  // The shared mock output lives in the Claude adapter for compatibility. The
  // router changes only the provider label so mixed-provider mock runs work.
  const { runClaude } = await import('./claude.js')
  const result = await runClaude({ ...o, stage: { ...o.stage, provider: 'claude' } })
  return { ...result, provider: 'codex', model: o.stage.model || o.runner.providers.codex.defaultModel }
}
