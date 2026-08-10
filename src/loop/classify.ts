import type { Config, ProjectConfig, Ticket } from '../types.js'

// Kind/eligibility are decided by the MODEL in triage. `classifyKind` is only a
// FALLBACK used when triage doesn't emit a parseable KIND line.
const QUESTION_WORDS =
  /\b(why|how|what|when|where|which|does|is it|can (i|we|you)|possible|expected|explain)\b/i

export function classifyKind(t: Ticket): 'question' | 'change' {
  const hay = `${t.title}\n${t.description}`
  if (t.labels.map((l) => l.toLowerCase()).includes('question')) return 'question'
  if (t.title.trim().endsWith('?')) return 'question'
  if (QUESTION_WORDS.test(hay) && !/\b(change|update|fix|add|remove|set|make)\b/i.test(t.title))
    return 'question'
  return 'change'
}

/** Match a ticket to a configured project. First match wins. */
export function matchProject(cfg: Config, t: Ticket): ProjectConfig | null {
  for (const p of cfg.projects) {
    const m = p.match || {}
    if (m.linearTeam && t.team && m.linearTeam === t.team) return p
    if (m.projectName && t.projectName && m.projectName === t.projectName) return p
    if (m.label && t.labels.includes(m.label)) return p
  }
  // Fallback: if exactly one project is configured, use it.
  return cfg.projects.length === 1 ? cfg.projects[0] : null
}
