// `ticketloop catalog …` and `ticketloop workflow …` — browse the step catalog,
// inspect the compiled execution plan, and validate a workflow against a
// project's real policy BEFORE it ever runs against a repo.

import { readFileSync, writeFileSync } from 'node:fs'
import type { Config, ProjectConfig } from '../types.js'
import { log } from '../logger.js'
import { saveConfig } from '../config.js'
import {
  exportBundle,
  importBundle,
  inspectBundle,
  parseBundle,
  serializeBundle,
} from '../catalog/bundle.js'
import {
  compileWorkflow,
  hasErrors,
  type CompiledPhase,
  type ExecutionPlan,
} from '../catalog/compile.js'
import {
  cloneStep,
  cloneWorkflow,
  formatRef,
  getWorkflow,
  loadCatalog,
  saveStep,
  saveWorkflow,
  type Catalog,
} from '../catalog/store.js'

export const DEFAULT_WORKFLOW_REF = 'standard@2'

/** The workflow a project runs, and the legacy stage blocks layered on it. */
export function planForProject(cfg: Config, project: ProjectConfig, cat = loadCatalog()): ExecutionPlan {
  const wf = getWorkflow(cat, project.workflow || DEFAULT_WORKFLOW_REF)
  return compileWorkflow(cat, wf, {
    config: cfg,
    project,
    legacyStages: [cfg.stages, project.stages || {}],
  })
}

// ---- printing --------------------------------------------------------------

function printPhases(phases: CompiledPhase[], indent = '  ') {
  for (const p of phases) {
    if (p.kind === 'step') {
      const s = p.settings
      const off = s.enabled ? '' : ' [disabled]'
      const how = [s.profile, s.effort, s.provider, s.model, s.skill ? `+skill:${s.skill}` : '']
        .filter(Boolean)
        .join('/')
      const on = Object.entries(p.transitions)
        .map(([r, t]) => `${r}→${t}`)
        .join(' ')
      console.log(`${indent}${p.id}  (${p.ref}, ${how})${off}`)
      console.log(`${indent}   ${p.step.contract} · ${on}`)
    } else if (p.kind === 'stop') {
      console.log(`${indent}⏹ ${p.id}  → ${p.terminal}${p.outcome ? ` (${p.outcome})` : ''}${p.reported ? ' · already reported' : ''}`)
    } else if (p.kind === 'branch') {
      console.log(`${indent}⑂ ${p.id}  on ${p.on.nodeId}.${p.on.field}`)
      for (const [name, list] of Object.entries(p.cases)) {
        console.log(`${indent}  case ${name}:`)
        printPhases(list, indent + '    ')
      }
      console.log(`${indent}  default: ${Array.isArray(p.default) ? '' : p.default}`)
      if (Array.isArray(p.default)) printPhases(p.default, indent + '    ')
    } else {
      console.log(`${indent}↻ loop ${p.id}  (max ${p.maxIterations}, no-progress: ${p.noProgress})`)
      printPhases([p.repair, ...p.gates], indent + '    ')
    }
  }
}

function printDiagnostics(plan: ExecutionPlan): void {
  const errors = plan.diagnostics.filter((d) => d.level === 'error')
  const warnings = plan.diagnostics.filter((d) => d.level === 'warning')
  for (const e of errors) log.error(`  ✗ [${e.code}] ${e.message}`)
  for (const wn of warnings) log.warn(`  ! [${wn.code}] ${wn.message}`)
  if (!errors.length && !warnings.length) log.info('  ✓ no problems found')
}

// ---- commands --------------------------------------------------------------

export function stepsCmd(cat: Catalog, ref?: string): void {
  if (ref) {
    const entry = [...cat.steps.entries()].find(([k]) => k === ref || k.startsWith(ref + '@'))
    if (!entry) {
      log.error(`unknown step "${ref}"`)
      process.exit(1)
    }
    const s = entry[1].item
    console.log(`${formatRef(s)} — ${s.name}  (${entry[1].scope})`)
    console.log(`  ${s.description}`)
    console.log(`  contract: ${s.contract}${s.routeFields ? ` (${s.routeFields.join(', ')})` : ''}`)
    console.log(`  workspace: ${s.capabilities.workspace}, mutates: ${s.capabilities.mutatesRepo}, per-repo: ${s.capabilities.perRepo}${s.capabilities.devOnly ? ', DEV-only' : ''}`)
    if (s.capabilities.externalEffects.length) console.log(`  external effects: ${s.capabilities.externalEffects.join(', ')}`)
    if (s.requiresPermissions?.length) console.log(`  requires permissions: ${s.requiresPermissions.join(', ')}`)
    console.log(`  resume: ${s.resumePolicy} · produces: ${s.produces.key} (${s.produces.type})`)
    if (s.consumes?.length) console.log(`  consumes: ${s.consumes.join(', ')}`)
    console.log(`\n  instruction:\n${s.instruction.split('\n').map((l) => '    ' + l).join('\n')}`)
    return
  }
  console.log('Step catalog:\n')
  for (const [key, e] of [...cat.steps.entries()].sort()) {
    const s = e.item
    const marks = [
      s.contract,
      s.capabilities.devOnly ? 'DEV-only' : '',
      s.defaults.enabled === false ? 'opt-in' : '',
      s.capabilities.externalEffects.length ? `effects: ${s.capabilities.externalEffects.join('+')}` : '',
    ].filter(Boolean)
    console.log(`  ${key.padEnd(16)} ${s.name.padEnd(20)} ${e.scope.padEnd(9)} ${marks.join(' · ')}`)
  }
  console.log('\nShow one with: ticketloop steps <id>@<version>')
}

export function workflowsCmd(cat: Catalog, cfg: Config): void {
  console.log('Workflows:\n')
  for (const [key, e] of [...cat.workflows.entries()].sort()) {
    const users = cfg.projects.filter((p) => (p.workflow || DEFAULT_WORKFLOW_REF) === key).map((p) => p.name)
    console.log(`  ${key.padEnd(16)} ${e.item.name.padEnd(24)} ${e.scope.padEnd(9)} ${users.length ? `used by: ${users.join(', ')}` : ''}`)
  }
  console.log(`\nProjects with no "workflow" run ${DEFAULT_WORKFLOW_REF}.`)
  console.log('Inspect the compiled plan with: ticketloop workflow show [<ref>] [--project <name>]')
}

export function workflowShowCmd(cat: Catalog, cfg: Config, ref?: string, projectName?: string): void {
  const project = projectName ? cfg.projects.find((p) => p.name === projectName) : undefined
  if (projectName && !project) {
    log.error(`unknown project "${projectName}"`)
    process.exit(1)
  }
  const wfRef = ref || project?.workflow || DEFAULT_WORKFLOW_REF
  const wf = getWorkflow(cat, wfRef)
  const plan = project
    ? planForProject(cfg, project, cat)
    : compileWorkflow(cat, wf, { config: cfg, legacyStages: [cfg.stages] })

  console.log(`${formatRef(plan.workflow)} — ${plan.workflow.name}  (digest ${plan.digest})`)
  if (project) console.log(`compiled for project "${project.name}"`)
  if (wf.description) console.log(`${wf.description}\n`)
  printPhases(plan.phases)
  if (plan.finallyNodes.length) {
    console.log('\n  finally:')
    for (const f of plan.finallyNodes) {
      console.log(`    ${f.id}  (${f.ref}) runs on: ${f.runOn.join(', ')}`)
    }
  }
  console.log('\n  outcomes:')
  for (const [cls, m] of Object.entries(plan.outcomes)) {
    const extra = m?.whenArtifact
      ? ` (${Object.entries(m.whenArtifact).map(([k, v]) => `${v} when ${k} exists`).join(', ')})`
      : ''
    console.log(`    ${cls.padEnd(9)} → ${m?.default}${extra}`)
  }
  const granted = Object.entries(plan.permissions).filter(([, v]) => v).map(([k]) => k)
  console.log(`\n  permissions granted: ${granted.length ? granted.join(', ') : '(none)'}`)
  console.log('\n  validation:')
  printDiagnostics(plan)
}

export function workflowValidateCmd(cat: Catalog, cfg: Config, ref?: string): void {
  let failed = false
  // Validate against every project that would actually run it — a workflow is
  // only valid relative to the policy of the project it is assigned to.
  const targets: { label: string; plan: ExecutionPlan }[] = []
  if (ref) {
    const wf = getWorkflow(cat, ref)
    targets.push({ label: formatRef(wf), plan: compileWorkflow(cat, wf, { config: cfg, legacyStages: [cfg.stages] }) })
  } else if (cfg.projects.length) {
    for (const p of cfg.projects)
      targets.push({ label: `${p.workflow || DEFAULT_WORKFLOW_REF} @ project "${p.name}"`, plan: planForProject(cfg, p, cat) })
  } else {
    for (const [key, e] of cat.workflows)
      targets.push({ label: key, plan: compileWorkflow(cat, e.item, { config: cfg, legacyStages: [cfg.stages] }) })
  }
  for (const t of targets) {
    console.log(`\n${t.label}`)
    printDiagnostics(t.plan)
    if (hasErrors(t.plan)) failed = true
  }
  console.log('')
  if (failed) {
    log.error('validation failed — a workflow with errors cannot be assigned')
    process.exit(1)
  }
  log.info('all workflows valid')
}

/** Copy a built-in into the user catalog so it can be edited. */
export function cloneCmd(cat: Catalog, kind: string, ref: string, newId?: string): void {
  if (kind === 'step') {
    const copy = cloneStep(cat, ref, newId)
    log.info(`wrote ${saveStep(copy)}  (${formatRef(copy)}) — edit it, then validate`)
  } else if (kind === 'workflow') {
    const copy = cloneWorkflow(cat, ref, newId)
    log.info(`wrote ${saveWorkflow(copy)}  (${formatRef(copy)}) — edit it, then validate`)
  } else {
    log.error('usage: ticketloop catalog clone step|workflow <id>@<version> [new-id]')
    process.exit(1)
  }
}

// ---- assignment -------------------------------------------------------------

/**
 * Point a project at a workflow. Refuses unless the workflow compiles cleanly
 * against THAT project's policy — assigning a plan that cannot run is the same
 * mistake as running it.
 */
export function workflowAssignCmd(
  cat: Catalog,
  cfg: Config,
  configPath: string | null,
  ref: string,
  projectName: string,
  engine?: string,
): void {
  const project = cfg.projects.find((p) => p.name === projectName)
  if (!project) {
    log.error(`unknown project "${projectName}"`)
    process.exit(1)
  }
  const wf = getWorkflow(cat, ref)
  const pinned = formatRef(wf)
  const candidate = { ...project, workflow: pinned }
  const plan = planForProject({ ...cfg, projects: [candidate] }, candidate, cat)
  const errors = plan.diagnostics.filter((d) => d.level === 'error')
  if (errors.length) {
    log.error(`${pinned} cannot run on project "${projectName}":`)
    for (const e of errors) log.error(`  ✗ [${e.code}] ${e.message}`)
    process.exit(1)
  }
  for (const wn of plan.diagnostics) log.warn(`  ! [${wn.code}] ${wn.message}`)
  project.workflow = pinned
  if (engine) project.engine = engine as ProjectConfig['engine']
  const written = saveConfig(cfg, configPath)
  log.info(`project "${projectName}" now runs ${pinned}${engine ? ` on the ${engine} engine` : ''} (saved to ${written})`)
  if ((project.engine || 'legacy') === 'legacy')
    log.warn(`  …but project "${projectName}" still uses engine: legacy, so the workflow is not what actually runs. Set engine: workflow to switch it.`)
}

// ---- sharing ----------------------------------------------------------------

export function catalogExportCmd(
  cat: Catalog,
  bundleId: string,
  refs: { steps: string[]; workflows: string[] },
  outFile?: string,
): void {
  const bundle = exportBundle(cat, { id: bundleId, stepRefs: refs.steps, workflowRefs: refs.workflows })
  const yaml = serializeBundle(bundle)
  if (outFile) {
    writeFileSync(outFile, yaml)
    log.info(`wrote ${outFile} — ${bundle.manifest.steps.length} step(s), ${bundle.manifest.workflows.length} workflow(s)`)
  } else {
    console.log(yaml)
  }
}

/** Print what a bundle would bring in. Nothing is written without --yes. */
export function catalogImportCmd(cat: Catalog, file: string, accept: boolean, force: boolean): void {
  const bundle = parseBundle(readFileSync(file, 'utf8'))
  const trust = inspectBundle(cat, bundle)
  console.log(`Bundle "${bundle.manifest.name}" (${bundle.manifest.id}) — created ${bundle.manifest.createdAt}`)
  if (bundle.manifest.description) console.log(`  ${bundle.manifest.description}`)
  console.log(`  steps:     ${bundle.manifest.steps.join(', ') || '(none)'}`)
  console.log(`  workflows: ${bundle.manifest.workflows.join(', ') || '(none)'}`)
  console.log(`  checksum:  ${trust.checksumOk ? 'verified' : 'DOES NOT MATCH'}`)

  // The whole point of a trust report: these are the things an imported step can
  // do on your machine, stated before you accept it.
  console.log('\nWhat this bundle can do:')
  if (trust.mutating.length) console.log(`  · modifies repositories: ${trust.mutating.join(', ')}`)
  for (const e of trust.externalEffects) console.log(`  · ${e.ref} reaches outside the worktree: ${e.effects.join(', ')}`)
  for (const s of trust.skills) console.log(`  · ${s.ref} invokes skill(s): ${s.skills.join(', ')}`)
  for (const t of trust.tools) console.log(`  · ${t.ref} requests tools: ${t.allowedTools}`)
  for (const r of trust.requestedPermissions)
    console.log(`  · ${r.ref} REQUESTS permissions: ${r.permissions.join(', ')} (importing does NOT grant these)`)
  if (!trust.mutating.length && !trust.externalEffects.length && !trust.skills.length)
    console.log('  · nothing beyond reading and reporting')
  if (trust.conflicts.length) console.log(`\nAlready installed (will be left alone): ${trust.conflicts.join(', ')}`)
  for (const e of trust.errors) log.error(`  ✗ ${e}`)

  console.log('\nRead the instruction text before accepting — it is handed to a coding agent')
  console.log('running with permissions skipped.')
  if (!accept) {
    log.info('\nNothing was written. Re-run with --yes to import.')
    return
  }
  const result = importBundle(cat, bundle, { acceptChecksumMismatch: force })
  log.info(`imported: ${result.written.join(', ') || '(nothing new)'}`)
  if (result.skipped.length) log.info(`already present: ${result.skipped.join(', ')}`)
}
