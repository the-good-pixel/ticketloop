import { loadConfig, resolveTracker } from './config.js'
import { log } from './logger.js'
import { initCmd } from './commands/init.js'
import { doctorCmd } from './commands/doctor.js'
import { statusCmd } from './commands/status.js'
import { setKeyCmd } from './commands/setkey.js'
import { watch } from './daemon/watch.js'
import { makeEngineCtx, processTicket } from './loop/engine.js'
import { makeTracker } from './adapters/tracker/tracker.js'
import { resolveTrackerKey } from './credentials.js'

interface Flags {
  config?: string
  mock: boolean
  ticket?: string
  port?: number
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
    else if (a === '--debug') log.setLevel('debug')
    else if (!a.startsWith('--')) flags.positional.push(a)
  }
  return { cmd, flags }
}

const HELP = `ticketloop — local, subscription-powered ticket-servicing agent

Usage:
  ticketloop init                 Scaffold ticketloop.config.yml
  ticketloop set-key <project>    Store a project's Linear API key in the daemon (prompts)
  ticketloop doctor               Check auth, credentials, and tooling
  ticketloop demo                 Run the loop on built-in demo tickets + dashboard (no creds)
  ticketloop watch                Start the daemon: poll tracker + run loop + dashboard
  ticketloop run [--ticket ID]    Scan once (or one ticket) then exit
  ticketloop status               Print quota meters + recent runs

Flags:
  --config <path>   Use a specific config file
  --mock / --demo   Use built-in demo tickets and a simulated agent (no quota spent)
  --ticket <ID>     (with run) process a single ticket by identifier/id
  --port <n>        Override dashboard port
  --debug           Verbose logging
`

async function main() {
  const { cmd, flags } = parse(process.argv.slice(2))

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP)
    return
  }
  if (cmd === 'init') return initCmd()

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
    case 'doctor':
      return doctorCmd(config, path)
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
