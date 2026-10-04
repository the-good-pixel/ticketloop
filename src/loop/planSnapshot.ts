import { createHash } from 'node:crypto'
import type { Config, ProjectConfig } from '../types.js'
import type { ExecutionPlan } from '../catalog/compile.js'
import { validatePlan } from '../catalog/validate.js'
import type { Checkpoint } from './checkpoint.js'

/** JSON-only; never includes tracker keys, MCP environments or data credentials. */
export interface PlanSnapshot {
  schema: 1
  checksum: string
  plan: Omit<ExecutionPlan, 'nodes' | 'produced'> & { produced: string[] }
  context: string
}

function context(cfg: Config, project: ProjectConfig): string {
  // Store hashes, not MCP/data credentials. Changes require review rather than
  // combining cached work with another repository, tool setup or runner.
  const { stages, executionProfiles, permissions, workflow, engine, exclude, maxParallel, ...rest } = project
  const repos = rest.repos?.map(({ exclude, shipDisabled, ...repo }) => repo)
  return hash({ project: { ...rest, repos }, runner: cfg.runner, mcp: project.mcp || cfg.mcp,
    tracker: { ...cfg.tracker, ...project.tracker } })
}
function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function savePlanSnapshot(plan: ExecutionPlan, cfg: Config, project: ProjectConfig): PlanSnapshot {
  const { nodes, produced, ...body } = plan
  const saved = JSON.parse(JSON.stringify({ ...body, produced: [...produced] })) as PlanSnapshot['plan']
  const ctx = context(cfg, project)
  return { schema: 1, plan: saved, context: ctx, checksum: hash({ plan: saved, context: ctx }) }
}

export function restorePlan(snapshot: PlanSnapshot, cfg: Config, project: ProjectConfig): ExecutionPlan {
  if (snapshot.schema !== 1 || snapshot.checksum !== hash({ plan: snapshot.plan, context: snapshot.context }))
    throw new Error('Saved workflow plan is invalid. Preserve the checkpoint and review recovery before starting fresh.')
  if (snapshot.context !== context(cfg, project))
    throw new Error('Repository, runner, tracker or tool configuration changed during this run. Restore the original settings or review recovery before starting fresh.')
  const saved = structuredClone(snapshot.plan)
  if (!Array.isArray(saved.phases) || !Array.isArray(saved.finallyNodes) || !Array.isArray(saved.produced))
    throw new Error('Saved workflow plan has an unsupported format.')
  const nodes: ExecutionPlan['nodes'] = new Map()
  function walk(phases: ExecutionPlan['phases']) {
    for (const node of phases) {
      if (node.kind === 'step') {
        if (nodes.has(node.id)) throw new Error('Duplicate node in saved workflow plan.')
        nodes.set(node.id, node)
      } else if (node.kind === 'loop') walk([node.repair, ...node.gates])
      else if (node.kind === 'branch') {
        for (const list of Object.values(node.cases)) walk(list)
        if (Array.isArray(node.default)) walk(node.default)
      } else if (node.kind !== 'stop') throw new Error('Unknown node in saved workflow plan.')
    }
  }
  walk(saved.phases)
  walk(saved.finallyNodes)
  const permissions = { ...cfg.permissions, ...project.permissions }
  for (const node of nodes.values())
    node.missingPermissions = (node.step.requiresPermissions || []).filter(p => permissions[p] !== true)
  const plan: ExecutionPlan = { ...saved, permissions, nodes, produced: new Set(saved.produced), diagnostics: [] }
  const errors = validatePlan(plan).filter(d => d.level === 'error')
  if (errors.length) throw new Error(`Saved workflow is no longer allowed: ${errors.map(d => d.message).join('; ')}`)
  return plan
}

export function selectPlan(ck: Checkpoint, compile: () => ExecutionPlan, cfg: Config, project: ProjectConfig): ExecutionPlan {
  if (ck.snapshot) {
    const plan = restorePlan(ck.snapshot, cfg, project)
    if (!ck.plan || ck.plan.digest !== plan.digest || ck.plan.workflowId !== plan.workflow.id || ck.plan.version !== plan.workflow.version)
      throw new Error('Checkpoint plan identity does not match its saved snapshot.')
    return plan
  }
  const plan = compile()
  if (ck.plan && (ck.plan.digest !== plan.digest || ck.plan.workflowId !== plan.workflow.id || ck.plan.version !== plan.workflow.version))
    throw new Error('Workflow changed since this run started. Preserve its checkpoint and review recovery before starting fresh.')
  if (!ck.plan && Object.keys(ck.nodeOutputs || {}).length)
    throw new Error('Workflow checkpoint has outputs without a saved plan identity.')
  if (plan.diagnostics.some(d => d.level === 'error'))
    throw new Error(`Workflow is invalid: ${plan.diagnostics.filter(d => d.level === 'error').map(d => d.message).join('; ')}`)
  ck.snapshot = savePlanSnapshot(plan, cfg, project)
  ck.plan = { workflowId: plan.workflow.id, version: plan.workflow.version, digest: plan.digest }
  return plan
}
