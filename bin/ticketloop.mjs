#!/usr/bin/env node
// Thin launcher so `ticketloop` works as a global bin without a build step.
// Uses tsx to run the TypeScript entrypoint.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const entry = resolve(here, '../src/cli.ts')
const tsx = resolve(here, '../node_modules/.bin/tsx')

const r = spawnSync(tsx, [entry, ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(r.status ?? 1)
