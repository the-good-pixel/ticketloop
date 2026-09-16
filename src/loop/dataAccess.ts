import { readFileSync } from 'node:fs'
import type { ProjectConfig } from '../types.js'

/** Load only explicitly allowed variables for the export subprocess. */
export function loadDataExportEnv(project: ProjectConfig): Record<string, string> | undefined {
  const cfg = project.dataExport
  if (!cfg) return undefined
  if (!cfg.envFile || !cfg.allowedEnv?.length) throw new Error('data export credentials are not configured')

  let text: string
  try {
    text = readFileSync(cfg.envFile, 'utf8')
  } catch {
    throw new Error(`data export credential file is unavailable: ${cfg.envFile}`)
  }

  const parsed: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!m) continue
    let value = m[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    parsed[m[1]] = value
  }

  const env: Record<string, string> = {}
  for (const key of cfg.allowedEnv) {
    if (parsed[key]) env[key] = parsed[key]
  }
  if (!Object.keys(env).length) throw new Error('data export credential file contains none of the allowed variables')
  return env
}
