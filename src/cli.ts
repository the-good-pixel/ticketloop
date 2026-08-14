import { loadConfig, resolveTracker } from './config.js'
import { log } from './logger.js'
import { initCmd } from './commands/init.js'
import { doctorCmd } from './commands/doctor.js'
import { statusCmd } from './commands/status.js'
import { supportBundleCmd } from './commands/support.js'
import { setKeyCmd } from './commands/setkey.js'
import { watch } from './daemon/watch.js'
import { makeEngineCtx, processTicket } from './loop/engine.js'
import { makeTracker } from './adapters/tracker/tracker.js'
import { resolveTrackerKey } from './credentials.js'
import { isPaused, setPaused, setTicketPaused } from './daemon/control.js'
import { readJson } from './store.js'
import { loadCatalog } from './catalog/store.js'
import {
  cloneCmd,
  stepsCmd,
  workflowAssignCmd,
  workflowShowCmd,
  workflowValidateCmd,
  workflowsCmd,
} from './commands/catalog.js'
import { DAEMON_STATE } from './paths.js'
import { ticketloopVersion } from './version.js'

interface Flags {
  config?: string
  mock: boolean
  ticket?: string
  port?: number
  project?: string
  engine?: string
  out?: string
  positional: string[]
}

function parse(argv: string[]): { cmd: string; flags: Flags } {
  const [cmd = 'help', ...rest] = argv
  const flags: Flags = { mock: false, positional: [] }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--mock' || a === '--demo') flags.mock = true
    else if (a === '--config') flags.config = rest[++i]
    else if (a === '--ticket') flags.ticket = rest[++i]
    else if (a === '--port') flags.port = Number(rest[++i])
    else if (a === '--project') flags.project = rest[++i]
    else if (a === '--engine') flags.engine = rest[++i]
    else if (a === '--out' || a === '-o') flags.out = rest[++i]
    else if (a === '--debug') log.setLevel('debug')
    else if (!a.startsWith('--')) flags.positional.push(a)
  }
  return { cmd, flags }
}

const HELP = `ticketloop — local, subscription-powered ticket-servicing agent

Usage:
  ticketloop --version            Print the installed version
  ticketloop init                 Scaffold ticketloop.config.yml
  ticketloop set-key <project>    Store a project's Linear API key in the daemon (prompts)
  ticketloop doctor               Check auth, credentials, and tooling
  ticketloop support-bundle       Write redacted diagnostics safe for a public issue
  ticketloop demo                 Run the loop on built-in demo tickets + dashboard (no creds)
  ticketloop watch                Start the daemon: poll tracker + run loop + dashboard
  ticketloop run [--ticket ID]    Scan once (or one ticket) then exit
  ticketloop pause [ticket]       Pause the whole loop, or one ticket, at the next stage boundary
  ticketloop resume [ticket]      Resume the loop (or one ticket) from where it stopped
  ticketloop status               Print quota meters + recent runs
  ticketloop steps [<id>@<v>]     List the step catalog, or show one step
  ticketloop workflows            List workflows and which projects use them
  ticketloop workflow show [ref]  Print the compiled execution plan (--project <name>)
  ticketloop workflow validate    Validate every project's workflow against its policy
  ticketloop workflow assign <id>@<v> --project <name>
  ticketloop catalog clone step|workflow <id>@<v> [new-id]

Flags:
  --config <path>   Use a specific config file
  --mock / --demo   Use built-in demo tickets and a simulated agent (no quota spent)
  --ticket <ID>     (with run) process a single ticket by identifier/id
  --port <n>        Override dashboard port
  --project <name>  (with workflow show) compile against that project's policy
  --debug           Verbose logging
`

interface DaemonState {
  tickets: Record<string, { marker: string; attempts: number; lastOutcome: string }>
}

// Map a user-typed "<project>:<ID>" or bare "<ID>" to a live daemon state key.
function resolveTicketKey(arg: string): string | null {
  let state: DaemonState | null = null
  try {
    state = readJson<DaemonState>(DAEMON_STATE)
  } catch {
    state = null
  }
  if (arg.includes(':')) return arg // explicit "<project>:<ID>" — trust it
  const keys = Object.keys(state?.tickets || {})
  const hit = keys.find((k) => k.slice(k.indexOf(':') + 1).toLowerCase() === arg.toLowerCase())
  return hit || null
}

// If another ticket in this ticket's project is mid-run, return its identifier.
function projectBusyWith(sKey: string): string | null {
  let state: DaemonState | null = null
  try {
    state = readJson<DaemonState>(DAEMON_STATE)
  } catch {
    return null
  }
  const proj = sKey.slice(0, sKey.indexOf(':'))
  for (const [k, v] of Object.entries(state?.tickets || {})) {
    if (k === sKey) continue
    if (k.startsWith(proj + ':') && v.lastOutcome === 'running') return k.slice(k.indexOf(':') + 1)
  }
  return null
}

async function main() {
  const { cmd, flags } = parse(process.argv.slice(2))

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP)
    return
  }
  if (cmd === 'init') return initCmd()
  // Pause/resume just flip the cross-process control file — no config needed.
  // The running daemon reads it before its next scan / stage boundary.
  // With no arg → system-level; with a ticket id/key → that ticket only.
  if (cmd === 'pause' || cmd === 'resume') {
    const paused = cmd === 'pause'
    const arg = flags.positional[0]
    if (arg) {
      const sKey = resolveTicketKey(arg)
      if (!sKey) {
        log.error(`no known ticket "${arg}" in daemon state. Use "<project>:<ID>" or a live ticket id.`)
        process.exit(1)
      }
      setTicketPaused(sKey, paused)
      if (paused) {
        log.info(`⏸ paused ticket ${sKey} — it stops at its next stage boundary (checkpointed). Resume with \`ticketloop resume ${arg}\`.`)
      } else {
        const warn = projectBusyWith(sKey)
        log.info(`▶ resumed ticket ${sKey} — continues from its checkpoint on the next scan.`)
        if (warn) log.warn(`…but project "${sKey.split(':')[0]}" is busy with ${warn} — it will only resume once that finishes (one run per project).`)
      }
      return
    }
    setPaused(paused)
    log.info(paused
      ? '⏸ paused — the daemon stops at the next stage boundary (in-flight work is checkpointed). Run `ticketloop resume` to continue.'
      : '▶ resumed — paused runs continue from their checkpoint on the next scan.')
    return
  }

  const { config, path } = loadConfig(flags.config)
  if (cmd === 'set-key')
    return setKeyCmd(config, flags.positional[0], flags.positional[1])
  if (flags.port) config.server.port = flags.port
  // demo command forces mock tracker + mock runner
  const mock = flags.mock || cmd === 'demo'
  if (mock) {
    config.tracker.type = 'mock'
    // Inject a demo project so the built-in tickets route through the full loop.
    if (!config.projects.length) {
      config.projects.push({
        name: 'demo-app',
        repoPath: process.cwd(),
        devUrl: 'http://localhost:5173',
        autonomy: 'propose',
        match: { projectName: 'demo-app' },
        exclude: ['**/migrations/**', '**/*auth*', '**/*timezone*'],
      })
    }
  }

  switch (cmd) {
    case 'steps':
      return stepsCmd(loadCatalog(), flags.positional[0])
    case 'workflows':
      return workflowsCmd(loadCatalog(), config)
    case 'workflow': {
      const sub = flags.positional[0] || 'show'
      const cat = loadCatalog()
      if (sub === 'validate') return workflowValidateCmd(cat, config, flags.positional[1])
      if (sub === 'show') return workflowShowCmd(cat, config, flags.positional[1], flags.project)
      if (sub === 'assign') {
        if (!flags.positional[1] || !flags.project) {
          log.error('usage: ticketloop workflow assign <id>@<version> --project <name> [--engine workflow]')
          process.exit(1)
        }
        return workflowAssignCmd(cat, config, path, flags.positional[1], flags.project, flags.engine)
      }
      log.error('usage: ticketloop workflow show|validate|assign [<id>@<version>]')
      process.exit(1)
      return
    }
    case 'catalog': {
      const sub = flags.positional[0]
      const cat = loadCatalog()
      if (sub === 'clone')
        return cloneCmd(cat, flags.positional[1], flags.positional[2], flags.positional[3])
      log.error('usage: ticketloop catalog clone step|workflow <id>@<version> [new-id]')
      process.exit(1)
      return
    }
    case 'doctor':
      return doctorCmd(config, path)
    case '--version':
    case '-v':
    case 'version':
      console.log(ticketloopVersion())
      return
    case 'support-bundle':
      return supportBundleCmd(config, path, flags.out)
    case 'status':
      return statusCmd(config)
    case 'demo':
    case 'watch':
      return watch(config, { mock, configPath: path })
    case 'run': {
      const ctx = makeEngineCtx(config, mock)
      if (flags.ticket) {
        // Search each project's own tracker for the ticket.
        for (const project of config.projects) {
          const tc = resolveTracker(config, project)
          const key = resolveTrackerKey(project, tc)
          const tracker = makeTracker(tc, key)
          const t = await tracker.getTicket(flags.ticket).catch(() => null)
          if (t) {
            const rec = await processTicket(ctx, t, project, tracker, { trackerKey: key })
            log.info(`done: ${rec.outcome}`)
            return
          }
        }
        log.error(`ticket ${flags.ticket} not found in any configured project`)
        process.exit(1)
      }
      return watch(config, { mock, once: true, configPath: path })
    }
    default:
      console.log(HELP)
      process.exit(1)
  }
}

main().catch((e) => {
  log.error(String(e?.stack || e))
  process.exit(1)
})
