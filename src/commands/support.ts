import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Config, RunRecord } from '../types.js'
import { resolveStage, resolveTracker } from '../config.js'
import { hasCredential, resolveTrackerKey } from '../credentials.js'
import { isPaused } from '../daemon/control.js'
import { loadCatalog } from '../catalog/store.js'
import { planForProject } from './catalog.js'
import { DAEMON_STATE } from '../paths.js'
import { atomicWrite, readJson, readRuns } from '../store.js'
import { ticketloopVersion } from '../version.js'

interface DaemonState {
  tickets?: Record<string, { attempts?: number; lastOutcome?: string }>
}

function toolVersion(bin: string, args: string[] = ['--version']): string | null {
  try {
    const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 5000 })
    if ((result.status ?? 1) !== 0) return null
    return String(result.stdout || result.stderr || '').trim().split('\n')[0] || null
  } catch {
    return null
  }
}

function outcomeCounts(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of values) counts[value || 'unknown'] = (counts[value || 'unknown'] || 0) + 1
  return counts
}

function errorKind(run: RunRecord): string | null {
  const text = String(run.error || '').toLowerCase()
  if (!text) return null
  if (text.includes('rate') && text.includes('limit')) return 'rate-limit'
  if (text.includes('timeout') || text.includes('timed out')) return 'timeout'
  if (text.includes('permission') || text.includes('denied')) return 'permission'
  if (text.includes('git') || text.includes('worktree') || text.includes('branch')) return 'git'
  if (text.includes('linear') || text.includes('tracker')) return 'tracker'
  if (text.includes('verdict') || text.includes('verify') || text.includes('review')) return 'workflow-gate'
  return 'other'
}

/**
 * Write a diagnostics report that is safe to attach to a public issue. It
 * intentionally contains no paths, project names, ticket data, prompt output,
 * instructions, URLs, environment values, or credential values.
 */
export function supportBundleCmd(cfg: Config, configPath: string | null, output?: string): string {
  const catalog = loadCatalog()
  let daemonState: DaemonState | null = null
  let daemonStateError = false
  try {
    daemonState = readJson<DaemonState>(DAEMON_STATE)
  } catch {
    daemonStateError = true
  }

  const projectAliases = new Map(cfg.projects.map((project, index) => [project.name, `project-${index + 1}`]))
  const projects = cfg.projects.map((project, index) => {
    const tracker = resolveTracker(cfg, project)
    const workflowRef = project.workflow || 'standard@3'
    const workflowEntry = catalog.workflows.get(workflowRef)
    const workflowVersion = Number(workflowRef.slice(workflowRef.lastIndexOf('@') + 1)) || null
    let diagnostics: { errors: string[]; warnings: string[] }
    try {
      const plan = planForProject(cfg, project, catalog)
      diagnostics = {
        errors: plan.diagnostics.filter((item) => item.level === 'error').map((item) => item.code),
        warnings: plan.diagnostics.filter((item) => item.level === 'warning').map((item) => item.code),
      }
    } catch {
      diagnostics = { errors: ['compile-failed'], warnings: [] }
    }
    return {
      alias: `project-${index + 1}`,
      repositoryExists: existsSync(project.repoPath),
      repositoryMode: project.repos?.length ? 'multi-repo' : 'single-repo',
      repositoryCount: project.repos?.length || 1,
      autonomy: project.autonomy,
      worktree: project.useWorktree !== false,
      engine: project.engine || 'legacy',
      workflow: {
        source: workflowEntry?.scope === 'builtin' ? 'built-in' : 'custom',
        version: workflowVersion,
      },
      tracker: {
        type: tracker.type,
        credentialConfigured: !!resolveTrackerKey(project, tracker),
        storedCredential: hasCredential(project.name),
        teamRestricted: !!tracker.team,
        optInLabelConfigured: !!tracker.simpleLabel,
        eligibleStateCount: tracker.states.length,
      },
      excludeRuleCount: project.exclude?.length || 0,
      workflowDiagnostics: diagnostics,
    }
  })

  const ticketStates = Object.values(daemonState?.tickets || {})
  const recentRuns = readRuns(12).map((run) => ({
    project: projectAliases.get(run.project) || 'unknown-project',
    outcome: run.outcome,
    durationMs: run.endedAt ? Math.max(0, run.endedAt - run.startedAt) : null,
    resumes: run.resumes || 0,
    errorKind: errorKind(run),
    stages: run.stages.map((stage) => ({
      name: stage.stage,
      status: stage.status,
      provider: stage.provider || null,
      model: stage.model || null,
      durationMs: stage.endedAt ? Math.max(0, stage.endedAt - stage.startedAt) : null,
    })),
  }))

  const providers = Object.fromEntries(
    (['claude', 'codex'] as const).map((provider) => {
      const item = cfg.runner.providers[provider]
      return [provider, {
        configured: cfg.runner.defaultProvider === provider || Object.values(cfg.stages).some((stage) => stage.provider === provider),
        authMode: item.authMode,
        cli: toolVersion(item.bin),
      }]
    }),
  )

  const report = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    redaction: {
      safeToAttachPublicly: true,
      omitted: [
        'credentials and environment values',
        'project and repository names and paths',
        'ticket identifiers, titles, descriptions, comments, and URLs',
        'step instructions, prompts, agent output, and error text',
        'pull request and deployment URLs',
      ],
    },
    runtime: {
      ticketloop: ticketloopVersion(),
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
    tools: {
      git: toolVersion('git'),
      githubCli: toolVersion('gh'),
      providers,
    },
    config: {
      source: configPath ? basename(configPath) : 'defaults',
      version: cfg.version,
      projectCount: projects.length,
      defaultProvider: cfg.runner.defaultProvider,
      permissionMode: cfg.runner.permissionMode,
      permissions: cfg.permissions || {},
      projects,
    },
    daemon: {
      paused: isPaused(),
      statePresent: !!daemonState,
      stateReadable: !daemonStateError,
      trackedTicketCount: ticketStates.length,
      outcomes: outcomeCounts(ticketStates.map((item) => item.lastOutcome || 'unknown')),
    },
    recentRuns,
  }

  const dest = output || join(process.cwd(), `ticketloop-support-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  atomicWrite(dest, JSON.stringify(report, null, 2) + '\n')
  console.log(`Created redacted support bundle: ${dest}`)
  console.log('The file contains no keys, project paths, ticket content, prompts, agent output, or raw errors.')
  return dest
}
