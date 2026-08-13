// Workflow validation — the gate between "someone wrote a workflow" and
// "ticketloop will run it against a real repo with real credentials".
//
// Every check here exists because the failure it prevents is expensive: a
// side-effecting step inside a repair loop opens duplicate PRs, an ungranted
// permission means a step tries to deploy a project that never allowed it, a
// terminal without a report means a ticket goes silent. Errors block
// assignment; warnings are shown and allowed.

import type {
  CompiledLoopNode,
  CompiledPhase,
  CompiledStepNode,
  CompiledStopNode,
  ExecutionPlan,
} from './compile.js'
import { HARNESS_KEYS } from './compile.js'
import { SIMPLE_TRANSITIONS, STEP_RESULTS } from './types.js'
import type { StepResult } from './types.js'

export interface Diagnostic {
  level: 'error' | 'warning'
  code: string
  message: string
  nodeId?: string
}

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const PROVIDERS = new Set(['claude', 'codex'])

interface Walked {
  steps: CompiledStepNode[]
  stops: CompiledStopNode[]
  loops: CompiledLoopNode[]
  branches: { id: string; on: { nodeId: string; field: string }; caseNames: string[]; hasDefault: boolean }[]
}

function walk(phases: CompiledPhase[], acc: Walked): Walked {
  for (const p of phases) {
    if (p.kind === 'step') acc.steps.push(p)
    else if (p.kind === 'stop') acc.stops.push(p)
    else if (p.kind === 'loop') {
      acc.loops.push(p)
      acc.steps.push(p.repair, ...p.gates)
    } else if (p.kind === 'branch') {
      acc.branches.push({
        id: p.id,
        on: p.on,
        caseNames: Object.keys(p.cases),
        hasDefault: p.default !== undefined && p.default !== null,
      })
      for (const list of Object.values(p.cases)) walk(list, acc)
      if (Array.isArray(p.default)) walk(p.default, acc)
    }
  }
  return acc
}

/** True when two nodes can run in the same execution — i.e. neither sits in a
 *  branch case the other's path excludes. */
function sharePath(a: string[], b: string[]): boolean {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false
  return true
}

export function validatePlan(plan: ExecutionPlan): Diagnostic[] {
  const d: Diagnostic[] = []
  const err = (code: string, message: string, nodeId?: string) => d.push({ level: 'error', code, message, nodeId })
  const warn = (code: string, message: string, nodeId?: string) => d.push({ level: 'warning', code, message, nodeId })

  const w = walk(plan.phases, { steps: [], stops: [], loops: [], branches: [] })
  const allSteps = [...w.steps, ...plan.finallyNodes]
  const loopIds = new Set(w.loops.map((l) => l.id))

  for (const n of allSteps) {
    const s = n.step

    // --- Reference integrity ------------------------------------------------
    if (!n.ref.includes('@'))
      err('unpinned-step', `node "${n.id}" references step "${n.ref}" without a version — a run must pin an immutable version`, n.id)
    if (s.version === 0) continue // unknown step; compile already reported it

    // --- Execution settings -------------------------------------------------
    if (n.settings.effort && !EFFORTS.has(n.settings.effort))
      err('invalid-effort', `node "${n.id}" has effort "${n.settings.effort}"`, n.id)
    if (n.settings.provider && !PROVIDERS.has(n.settings.provider))
      err('invalid-provider', `node "${n.id}" has provider "${n.settings.provider}"`, n.id)

    // --- Transitions --------------------------------------------------------
    for (const [result, target] of Object.entries(n.transitions)) {
      if (!STEP_RESULTS.includes(result as StepResult))
        err('unknown-result', `node "${n.id}" maps unknown result "${result}"`, n.id)
      if (SIMPLE_TRANSITIONS.includes(target)) {
        if (target === 'repair' && !n.loopId)
          err('repair-outside-loop', `node "${n.id}" transitions to "repair" but is not inside a loop`, n.id)
        if (target === 'exit-loop' && !n.loopId && n.role !== 'finally')
          err('exit-outside-loop', `node "${n.id}" transitions to "exit-loop" but is not inside a loop`, n.id)
        continue
      }
      const m = target.match(/^(.+)\.repair$/)
      if (!m) {
        err('unknown-transition', `node "${n.id}" has undefined transition "${target}" for result "${result}"`, n.id)
      } else if (!loopIds.has(m[1])) {
        err('unknown-loop-target', `node "${n.id}" repairs into unknown loop "${m[1]}"`, n.id)
      }
    }
    // A verdict step that can fail must say what a failure means.
    if (s.contract === 'verdict' && !n.transitions.fail)
      err('unhandled-fail', `gate "${n.id}" does not say what a fail means (repair, stop, or continue)`, n.id)

    // --- Capabilities -------------------------------------------------------
    if (s.capabilities.mutatesRepo && s.capabilities.workspace === 'read-only')
      err('workspace-conflict', `step "${s.id}" claims a read-only workspace but also mutates the repo`, n.id)
    if (s.capabilities.mutatesRepo && s.capabilities.workspace === 'checkout')
      err('workspace-conflict', `step "${s.id}" would mutate the project's real checkout — it needs an isolated "change" workspace`, n.id)
    if (s.capabilities.devOnly && s.capabilities.externalEffects.some((e) => e !== 'deploy-dev'))
      err('dev-only-effect', `step "${s.id}" is DEV-only but declares a non-DEV effect`, n.id)

    // --- Authority ----------------------------------------------------------
    if (n.settings.enabled && n.missingPermissions.length)
      err('permission-denied', `node "${n.id}" requires ${n.missingPermissions.join(', ')} — the project has not granted ${n.missingPermissions.length > 1 ? 'them' : 'it'}`, n.id)
    if (s.capabilities.externalEffects.includes('merge-pr') && plan.permissions.mergeFeaturePr !== true)
      err('merge-not-granted', `node "${n.id}" merges a PR, which this project does not allow`, n.id)
    if (s.capabilities.externalEffects.includes('deploy-dev') && plan.permissions.deployProduction === true)
      warn('prod-permission', `this project grants deployProduction; ticketloop never deploys production — the grant does nothing`, n.id)

    // --- Side effects inside a repair loop ----------------------------------
    if (n.loopId && s.capabilities.externalEffects.length)
      err('effect-in-loop', `node "${n.id}" has external effects (${s.capabilities.externalEffects.join(', ')}) inside repair loop "${n.loopId}" — it would repeat them on every iteration`, n.id)

    // --- Data dependencies --------------------------------------------------
    // `requires` is a hard dependency; `consumes` is context the step is happy
    // to do without, so an absent producer there is not worth a diagnostic.
    if (n.settings.enabled) {
      for (const key of s.requires || []) {
        if (!plan.produced.has(key) && !HARNESS_KEYS.has(key))
          err('missing-producer', `node "${n.id}" requires "${key}", which no enabled step produces`, n.id)
      }
    }

    // --- Post steps ---------------------------------------------------------
    if (s.contract === 'post' && !s.capabilities.externalEffects.includes('tracker-comment'))
      warn('post-without-effect', `step "${s.id}" posts to the tracker but does not declare the tracker-comment effect`, n.id)
  }

  // --- Loops ----------------------------------------------------------------
  for (const l of w.loops) {
    if (!Number.isInteger(l.maxIterations) || l.maxIterations < 1)
      err('unbounded-loop', `loop "${l.id}" needs a maxIterations of at least 1`, l.id)
    if (l.maxIterations > 10)
      warn('expensive-loop', `loop "${l.id}" allows ${l.maxIterations} iterations — each one is a full round of model calls`, l.id)
    if (!l.gates.length)
      err('loop-without-gate', `loop "${l.id}" has no gate, so nothing can ever end it`, l.id)
    for (const g of l.gates) {
      if (g.step.version && g.step.contract !== 'verdict')
        err('non-verdict-gate', `gate "${g.id}" uses step "${g.step.id}", which does not return a verdict`, g.id)
    }
    if (!l.gates.some((g) => Object.values(g.transitions).includes('exit-loop')))
      err('inescapable-loop', `loop "${l.id}" has no gate that can exit it`, l.id)
  }

  // --- Branches -------------------------------------------------------------
  for (const b of w.branches) {
    if (!b.hasDefault)
      err('branch-without-default', `branch "${b.id}" has no default for an unmatched value`, b.id)
    if (!b.caseNames.length)
      warn('empty-branch', `branch "${b.id}" has no cases`, b.id)
    const source = plan.nodes.get(b.on.nodeId)
    if (!source) {
      err('unknown-branch-source', `branch "${b.id}" reads "${b.on.nodeId}.${b.on.field}" but there is no node "${b.on.nodeId}"`, b.id)
    } else if (source.step.version) {
      if (source.step.contract !== 'route')
        err('branch-source-not-route', `branch "${b.id}" reads node "${b.on.nodeId}", which does not produce routing fields`, b.id)
      else if (b.on.field && !(source.step.routeFields || []).includes(b.on.field))
        err('unknown-route-field', `branch "${b.id}" reads field "${b.on.field}", which step "${source.step.id}" does not emit`, b.id)
    }
  }

  // --- Deployment verification ---------------------------------------------
  // A DEV-only gate that can never see a deployment is a broken plan. Steps that
  // merely mention the deployment as context (the report) are not affected.
  const deploysDev = allSteps.some((n) => n.settings.enabled && n.step.capabilities.externalEffects.includes('deploy-dev'))
  if (!deploysDev) {
    for (const n of allSteps) {
      if (n.settings.enabled && n.step.capabilities.devOnly && (n.step.requires || []).includes('devDeployment'))
        err('verify-dev-without-deploy', `node "${n.id}" verifies a DEV deployment, but no enabled step deploys to DEV`, n.id)
    }
  }

  // --- Duplicate side effects ----------------------------------------------
  // Only nodes that can BOTH run in the same run count: two ship nodes in
  // different branch cases are mutually exclusive, not a duplicate.
  const withEffects = allSteps.filter((n) => n.settings.enabled && n.step.capabilities.externalEffects.length)
  for (let i = 0; i < withEffects.length; i++) {
    for (let j = i + 1; j < withEffects.length; j++) {
      const a = withEffects[i]
      const b = withEffects[j]
      if (!sharePath(a.path, b.path)) continue
      for (const e of a.step.capabilities.externalEffects) {
        if (e === 'tracker-comment') continue // reporting twice is a design choice
        if (b.step.capabilities.externalEffects.includes(e))
          warn('duplicate-effect', `nodes "${a.id}" and "${b.id}" both perform "${e}" on the same path — make sure that is intended`, b.id)
      }
    }
  }

  // --- Side effects with nothing checking them first ------------------------
  // Opening a PR or deploying before any gate has run means shipping code that
  // nothing verified. Legal, occasionally deliberate, usually a mistake — so a
  // warning rather than an error. `w.steps` is in execution order per path.
  for (let i = 0; i < w.steps.length; i++) {
    const n = w.steps[i]
    if (!n.settings.enabled) continue
    const effects = n.step.capabilities.externalEffects.filter((e) => e !== 'tracker-comment')
    if (!effects.length) continue
    const gatedBefore = w.steps
      .slice(0, i)
      .some((prev) => prev.settings.enabled && prev.step.contract === 'verdict' && sharePath(prev.path, n.path))
    if (!gatedBefore)
      warn('ungated-effect', `node "${n.id}" performs ${effects.join(', ')} before any gate has checked the work`, n.id)
  }

  // --- Terminals and reporting ---------------------------------------------
  if (!w.stops.length) err('no-terminal', 'the workflow has no terminal node — no path can end')
  const finallyClasses = new Set(plan.finallyNodes.flatMap((f) => f.runOn || []))
  for (const s of w.stops) {
    if (!s.outcome && !plan.outcomes[s.terminal])
      err('unmapped-outcome', `terminal "${s.id}" ends as "${s.terminal}", which the workflow does not map to an outcome`, s.id)
    if (!s.reported && !finallyClasses.has(s.terminal))
      warn('silent-terminal', `terminal "${s.id}" ends as "${s.terminal}" with no final report — the ticket gets no reply`, s.id)
  }

  return d
}
