import { spawn } from 'node:child_process'
import { registerChild, unregisterChild } from './children.js'
import { log } from '../logger.js'
import type { AgentResult, RunAgentOpts } from './types.js'
import { classifyKind } from '../loop/classify.js'

// Claude's real "you've hit your limit" signal — the reliable backstop.
export function isRateLimitText(t: string): boolean {
  return /rate limit|usage limit|hit your (5-hour|weekly|usage|opus).{0,20}limit|limit .{0,10}reset|too many requests|(?:status|status code|http|error|code)\D{0,12}429\b/i.test(
    t || '',
  )
}

// Best-effort: pull a reset time out of a rate-limit message. Handles a unix
// timestamp, "try again in N minutes/hours", and a clock time like "resets 3pm".
export function parseResetHint(t: string, now = Date.now()): number | undefined {
  if (!t) return undefined
  const ts = t.match(/reset[^0-9]{0,25}(\d{10,13})/i)
  if (ts) return Number(ts[1]) < 1e12 ? Number(ts[1]) * 1000 : Number(ts[1])
  const rel = t.match(/(?:try again|retry|reset[a-z]*)\D{0,20}?(\d+)\s*(second|minute|hour)s?/i)
  if (rel) {
    const n = Number(rel[1])
    const mult = /hour/i.test(rel[2]) ? 3600 : /minute/i.test(rel[2]) ? 60 : 1
    return now + n * mult * 1000
  }
  const clock = t.match(/reset[a-z]*\D{0,20}?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i)
  if (clock) {
    let h = Number(clock[1]) % 12
    if (/pm/i.test(clock[3])) h += 12
    const d = new Date(now)
    d.setHours(h, clock[2] ? Number(clock[2]) : 0, 0, 0)
    if (d.getTime() <= now) d.setDate(d.getDate() + 1) // next occurrence
    return d.getTime()
  }
  return undefined
}

/**
 * Guard against the documented subscription->metered footgun:
 *  - `--bare` skips OAuth and REQUIRES ANTHROPIC_API_KEY (metered).
 *  - if ANTHROPIC_API_KEY is set, Claude Code bills the API instead of the sub.
 * In subscription mode we refuse both and scrub the env var for the child.
 */
export function buildClaudeArgs(o: RunAgentOpts): { args: string[]; prompt: string } {
  const { stage, runner } = o
  const provider = runner.providers.claude
  const model = stage.model || provider.defaultModel
  const effort = stage.effort || provider.defaultEffort

  // Model & effort go through real CLI flags (--model / --effort). Do NOT inject
  // "/effort" or "/skill" as slash-prefixes into the prompt: that mechanism is
  // unreliable in -p mode and its error text leaks into the result. A configured
  // skill is requested via a plain instruction line the model acts on.
  let prompt = ''
  if (stage.skill) prompt += `Use the /${stage.skill} skill for this step.\n\n`
  prompt += o.prompt

  const args = [
    '-p',
    prompt,
    '--model',
    model,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
  ]
  if (effort) args.push('--effort', effort)
  // Permission handling. bypass = full autonomy (no prompts); safety is the
  // worktree + exclude guardrail + PR review, not permission prompts.
  const mode = stage.permissionMode || 'bypass'
  if (mode === 'bypass') {
    args.push('--dangerously-skip-permissions')
  } else if (mode === 'acceptEdits') {
    args.push('--permission-mode', 'acceptEdits')
    if (stage.allowedTools) args.push('--allowedTools', stage.allowedTools)
  } else {
    if (stage.allowedTools) args.push('--allowedTools', stage.allowedTools)
  }
  if (stage.instruction) args.push('--append-system-prompt', stage.instruction)
  if (o.mcp && Object.keys(o.mcp).length) {
    args.push('--mcp-config', JSON.stringify({ mcpServers: o.mcp }))
  }
  return { args, prompt }
}

export async function runClaude(o: RunAgentOpts): Promise<AgentResult> {
  if (o.mock) return mockRun(o)

  const { args } = buildClaudeArgs(o)
  const provider = o.runner.providers.claude
  const model = o.stage.model || provider.defaultModel

  // Never use --bare in subscription mode; scrub API key so we don't get billed.
  const env = { ...process.env, ...(o.env || {}) }
  if (o.authMode === 'subscription') delete env.ANTHROPIC_API_KEY

  return new Promise((resolve) => {
    // detached: own process group so a timeout can kill the whole subtree
    // (claude + any tools it spawned), leaving no orphans.
    const child = spawn(provider.bin, args, {
      cwd: o.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })

    // Track this child's process group so it can be killed on shutdown / reaped
    // on the next startup if the daemon dies.
    const pgid = child.pid || 0
    const inflightKey = pgid ? registerChild(pgid, { model }) : ''
    const reap = () => {
      if (pgid) unregisterChild(pgid, inflightKey)
    }

    let settled = false
    let timedOut = false
    // stageTimeoutSec <= 0 (or null) = NO wall-clock timeout — coding tasks can
    // legitimately run for hours. A hung stage then blocks until the daemon is
    // restarted (which kills the child via the process-group handler).
    const timeoutMs = (o.runner.stageTimeoutSec ?? 900) * 1000
    const killTree = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig)
      } catch {
        try { child.kill(sig) } catch { /* already gone */ }
      }
    }
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            killTree('SIGTERM')
            setTimeout(() => killTree('SIGKILL'), 3000)
          }, timeoutMs)
        : null

    let text = ''
    let usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreate: 0,
      cost: 0,
    }
    let isError = false
    let rateLimited = false
    let resetHint: number | undefined
    let buf = ''
    let stderr = ''

    child.stdout.on('data', (d) => {
      buf += d.toString()
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        try {
          const ev = JSON.parse(line)
          if (ev.type === 'system' && ev.subtype === 'api_retry' && ev.error === 'rate_limit') {
            rateLimited = true
            const ra = ev.retry_after ?? ev.reset_at ?? ev.resets_at
            if (typeof ra === 'number') resetHint = ra > 1e9 ? (ra > 1e12 ? ra : ra * 1000) : Date.now() + ra * 1000
          }
          if (ev.type === 'result') {
            if (typeof ev.result === 'string') text = ev.result
            if (ev.is_error) isError = true
            const u = ev.usage || {}
            usage.input = u.input_tokens || 0
            usage.output = u.output_tokens || 0
            usage.cacheRead = u.cache_read_input_tokens || 0
            usage.cacheCreate = u.cache_creation_input_tokens || 0
            usage.cost = ev.total_cost_usd || 0
          }
        } catch {
          /* partial or non-JSON line */
        }
      }
    })
    child.stderr.on('data', (d) => (stderr += d.toString()))

    child.on('error', (err) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      reap()
      resolve(errorResult(model, `failed to spawn "${provider.bin}": ${err.message}`))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      reap()
      if (stderr.trim()) log.debug(`claude stderr: ${stderr.trim().slice(0, 500)}`)
      if (timedOut) {
        resolve(errorResult(model, `stage timed out after ${o.runner.stageTimeoutSec ?? 900}s and was killed`))
        return
      }
      // A retry event followed by a successful result is not an exhausted
      // subscription. Classify only when the final CLI result failed.
      if (code !== 0) isError = true
      const failed = isError
      const limited = failed && (rateLimited || isRateLimitText(text) || isRateLimitText(stderr))
      const resetAt = limited ? resetHint ?? parseResetHint(`${text}\n${stderr}`) : undefined
      if (code !== 0 && !text) {
        const r = errorResult(model, `claude exited ${code}: ${stderr.trim().slice(0, 300)}`)
        if (limited) r.failure = { kind: 'quota-exhausted', provider: 'claude', message: r.text, retryAt: resetAt }
        resolve(r)
        return
      }
      const total =
        usage.input + usage.output + usage.cacheRead + usage.cacheCreate
      resolve({
        text,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheCreationTokens: usage.cacheCreate,
        totalTokens: total,
        costUsd: usage.cost,
        provider: 'claude',
        model,
        isError,
        failure: limited
          ? { kind: 'quota-exhausted', provider: 'claude', message: `${text}\n${stderr}`.trim().slice(0, 500), retryAt: resetAt }
          : undefined,
      })
    })
  })
}

function errorResult(model: string, msg: string): AgentResult {
  return {
    text: msg,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    provider: 'claude',
    model,
    isError: true,
  }
}

// ---- Mock (demo mode) ------------------------------------------------------

const MOCK_TEXTS: Record<string, string> = {
  // Overwritten below with a KIND derived from the ticket in the prompt.
  triage: 'DECISION: eligible\nREASON: mock triage.',
  answer:
    'The 15-minute expiry comes from the access-JWT TTL in auth/session; the ' +
    'rolling refresh cookie keeps you signed in past it. See auth/session.go.\n' +
    '— 🤖 via ticketloop\nCOMMENT_URL: https://linear.app/demo/issue/DEMO/#comment-mockanswer',
  export:
    'Connected read-only with the credentials from the ticket. Wrote ./member-export.csv ' +
    '(1,234 rows · columns: email, marketing_opt_in · opt-out rows filtered out).',
  locate: 'Searched gh for an open PR on this ticket; none found.\nREUSE: none',
  reproduce:
    'Reproduced the bug: the submit button throws on click because the handler reads an undefined ' +
    'field. Root cause: missing null-guard in apply/submit.ts. Repro: open the apply page, click 提交.',
  plan: '1. Update the button label string in the zh-HK locale file.\n2. No logic changes.\n3. Verify with `deno task check`.',
  prepare: 'Created branch feature/demo-102-submit-label off main. Located src/lib/i18n/zh-HK.ts.',
  diff: 'Edited src/lib/i18n/zh-HK.ts: "提交" → "立即提交". 1 file, +1/-1.',
  verify: 'Ran `deno task check` → passed. Rendered the apply page; button now reads 立即提交.\nVERDICT: pass',
  review: 'Pure copy change, scoped, no off-limits paths.\nVERDICT: pass',
  ship: 'Committed, pushed feature/demo-102-submit-label, opened https://github.com/demo/demo-app/pull/142',
  'deploy-dev': 'Pushed the branch to deployment/web/dev; the dev pipeline finished green; change is live on dev.\nVERDICT: pass',
  'verify-dev': 'Browser-tested the apply page on the dev URL; the submit button now reads 立即提交. Works in dev.\nVERDICT: pass',
  // Aliases so a caller can key mock text by the STEP ID as well as the legacy
  // MOCK_KIND name (the workflow interpreter passes the step id directly).
  clarify: '',
  fix: '',
  comment:
    'Updated the submit button label to 立即提交. PR: https://github.com/demo/demo-app/pull/142 — please review.\n' +
    '— 🤖 via ticketloop\nCOMMENT_URL: https://linear.app/demo/issue/DEMO/#comment-mockcomment',
}

MOCK_TEXTS.clarify = MOCK_TEXTS.answer
MOCK_TEXTS.fix = MOCK_TEXTS.diff

// The mock triage classifies from the ticket text in the prompt, using the same
// heuristic the engine falls back to. Both engines then see a real KIND line, so
// the demo exercises routing instead of always landing on the change path.
function mockTriageKind(prompt: string): string {
  const title = (prompt.match(/^Ticket \S+: (.*)$/m) || [])[1] || ''
  const desc = (prompt.match(/Description:\n([\s\S]*?)\nLink:/) || [])[1] || ''
  return classifyKind({ title, description: desc, labels: [] } as never)
}

let mockVerifyFailsLeft = Number(process.env.TICKETLOOP_MOCK_FAIL_VERIFIES) || 0
let mockReviewFailsLeft = Number(process.env.TICKETLOOP_MOCK_FAIL_REVIEWS) || 0
let mockShipFailsLeft = Number(process.env.TICKETLOOP_MOCK_FAIL_SHIPS) || 0
let mockDeployFailsLeft = Number(process.env.TICKETLOOP_MOCK_FAIL_DEPLOYS) || 0
let mockDeployWaitsLeft = Number(process.env.TICKETLOOP_MOCK_WAIT_DEPLOYS) || 0
let mockVerifyDevFailsLeft = Number(process.env.TICKETLOOP_MOCK_FAIL_VERIFYDEV) || 0
// TICKETLOOP_MOCK_ERROR_SHIP=N: the first N ship calls THROW (isError) like a
// dropped connection — used to test resume-after-crash (the run fails, then a
// later attempt resumes from the checkpoint and re-runs only ship).
let mockShipErrorsLeft = Number(process.env.TICKETLOOP_MOCK_ERROR_SHIP) || 0

async function mockRun(o: RunAgentOpts): Promise<AgentResult> {
  // Per-stage delay; override with TICKETLOOP_MOCK_DELAY_MS to slow the demo down
  // (useful for watching the live monitor).
  const base = Number(process.env.TICKETLOOP_MOCK_DELAY_MS) || 300 + Math.random() * 500
  await new Promise((r) => setTimeout(r, base))
  const kind = o.mockKind || 'answer'
  const inp = 1500 + Math.floor(Math.random() * 6000)
  const out = 200 + Math.floor(Math.random() * 1200)
  const cacheRead = Math.floor(Math.random() * 8000)
  const total = inp + out + cacheRead
  const model = o.stage.model || o.runner.providers.claude.defaultModel
  // rough Sonnet-ish blended price for demo realism only
  const cost = (inp * 3 + out * 15 + cacheRead * 0.3) / 1_000_000
  // Ship text carries a per-repo PR URL (workdir basename) so multi-repo demos
  // produce distinct PRs the engine can parse into rec.prs.
  let text = MOCK_TEXTS[kind] || 'ok'
  // Test hook: make triage classify the ticket as "no action needed".
  if (kind === 'triage') {
    const k = mockTriageKind(o.prompt)
    text = `DECISION: eligible\nKIND: ${k}\nREASON: latest comment asks for ${k} work on this ticket.`
  }
  // Test hooks: exercise both triage early-exits, each WITH a reason so the
  // run record's summary can be asserted on.
  if (kind === 'triage' && process.env.TICKETLOOP_MOCK_TRIAGE_NOACTION)
    text = 'DECISION: no-action\nREASON: latest comment "UAT passed, ready for PROD" is a sign-off with no new ask.'
  if (kind === 'triage' && process.env.TICKETLOOP_MOCK_TRIAGE_INELIGIBLE)
    text = 'DECISION: ineligible\nREASON: the fix requires a DB migration under db/migrations, which is off-limits.'
  if (kind === 'ship') {
    const repo = o.cwd.split('/').pop() || 'demo-app'
    const n = 100 + (repo.length % 90)
    const url = `https://github.com/demo/${repo}/pull/${n}`
    // Hard crash (connection drop) — thrown, never cached, so resume re-runs it.
    if (mockShipErrorsLeft > 0) {
      mockShipErrorsLeft--
      return {
        text: 'API Error: Unable to connect to API (ENOTFOUND)',
        inputTokens: inp, outputTokens: 0, cacheReadTokens: cacheRead, cacheCreationTokens: 0,
        totalTokens: inp + cacheRead, costUsd: 0, provider: 'claude', model, isError: true,
      }
    }
    // TICKETLOOP_MOCK_FAIL_SHIPS=N: first N ships open the PR but report red CI,
    // so you can watch ship route back to fix.
    if (mockShipFailsLeft > 0) {
      mockShipFailsLeft--
      text = `Pushed, opened ${url}\nCI: the build check is RED.\nVERDICT: fail — CI build failing on the PR`
    } else {
      text = `Committed, pushed ticketloop/demo, opened ${url}\nCI checks all green.\nVERDICT: pass`
    }
  }
  // Demo/testing: TICKETLOOP_MOCK_FAIL_REVIEWS=N makes the first N review checks
  // return VERDICT: fail so you can watch the fix→review loop actually loop.
  // TICKETLOOP_MOCK_REUSE_BRANCH=<branch> makes locate report an open PR to refresh.
  if (kind === 'locate' && process.env.TICKETLOOP_MOCK_REUSE_BRANCH) {
    text = `Found an open PR on this ticket.\nREUSE: ${process.env.TICKETLOOP_MOCK_REUSE_BRANCH}`
  }
  if (kind === 'verify' && mockVerifyFailsLeft > 0) {
    mockVerifyFailsLeft--
    text = 'Mock verify: the app does not build.\nVERDICT: fail — injected mock verify failure'
  }
  if (kind === 'review' && mockReviewFailsLeft > 0) {
    mockReviewFailsLeft--
    text = 'Mock review: found a problem to force another fix pass.\nVERDICT: fail — injected mock failure'
  }
  // TICKETLOOP_MOCK_WAIT_DEPLOYS=N: the first N deploys report WAIT (queued for a
  // human approval) rather than fail — the case the workflow design exists to
  // separate, since nothing is wrong with the code.
  if (kind === 'deploy-dev' && mockDeployWaitsLeft > 0) {
    mockDeployWaitsLeft--
    text = 'Mock deploy-dev: the dev deployment is queued for manual approval.\nVERDICT: wait — awaiting approval'
  } else if (kind === 'deploy-dev' && mockDeployFailsLeft > 0) {
    mockDeployFailsLeft--
    text = 'Mock deploy-dev: the dev pipeline failed to go green.\nVERDICT: fail — injected mock deploy failure'
  }
  if (kind === 'verify-dev' && mockVerifyDevFailsLeft > 0) {
    mockVerifyDevFailsLeft--
    text = 'Mock verify-dev: the change does not work in dev.\nVERDICT: fail — injected mock dev-verify failure'
  }
  return {
    text,
    inputTokens: inp,
    outputTokens: out,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: 0,
    totalTokens: total,
    costUsd: Number(cost.toFixed(4)),
    provider: 'claude',
    model,
    isError: false,
  }
}
