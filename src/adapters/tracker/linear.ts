import type { Ticket, TicketComment, TrackerConfig } from '../../types.js'
import type { Tracker } from './tracker.js'
import { log } from '../../logger.js'

const LINEAR_API = 'https://api.linear.app/graphql'

// Footer appended to every comment ticketloop posts, so its own comments can be
// told apart from human ones (the loop posts as the user's account). Human
// activity re-triggers a ticket; bot comments must not.
export const BOT_MARKER = '\n\n— 🤖 via ticketloop'
export function isBotComment(body: string): boolean {
  return body.includes('via ticketloop')
}

const COMMENT_FIELDS = `comments(first: 100) { nodes { id body createdAt user { name } } }`

/** Minimal Linear GraphQL client — no SDK dependency. One client per workspace. */
export class LinearTracker implements Tracker {
  constructor(
    private tc: TrackerConfig,
    private key: string,
  ) {
    if (!this.key) {
      log.warn(
        `Linear tracker: no API key resolved — run \`ticketloop set-key <project>\` ` +
          `or set env ${tc.apiKeyEnv}.`,
      )
    }
  }

  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetch(LINEAR_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: this.key },
      body: JSON.stringify({ query, variables }),
    })
    if (!res.ok) throw new Error(`Linear API ${res.status}: ${await res.text()}`)
    const json = (await res.json()) as { data?: T; errors?: unknown }
    if (json.errors) throw new Error(`Linear GraphQL: ${JSON.stringify(json.errors)}`)
    return json.data as T
  }

  async listCandidates(): Promise<Ticket[]> {
    const q = `
      query Candidates($filter: IssueFilter) {
        issues(filter: $filter, first: 50, orderBy: updatedAt) {
          nodes {
            id identifier title description url updatedAt
            state { name }
            team { key }
            project { name }
            labels { nodes { name } }
            ${COMMENT_FIELDS}
          }
        }
      }`
    const filter: Record<string, unknown> = {
      state: { name: { in: this.tc.states } },
    }
    // Label is the opt-in switch. Only filter by it when one is set; a blank
    // label means "no label filter" (ALL eligible tickets).
    if (this.tc.simpleLabel) {
      filter.labels = { some: { name: { eq: this.tc.simpleLabel } } }
    }
    if (this.tc.team) {
      filter.team = { key: { eq: this.tc.team } }
    }
    const data = await this.gql<{ issues: { nodes: any[] } }>(q, { filter })
    return data.issues.nodes.map(mapIssue)
  }

  async getTicket(id: string): Promise<Ticket | null> {
    const q = `
      query Issue($id: String!) {
        issue(id: $id) {
          id identifier title description url updatedAt
          state { name } team { key } project { name }
          labels { nodes { name } }
          ${COMMENT_FIELDS}
        }
      }`
    const data = await this.gql<{ issue: any }>(q, { id })
    return data.issue ? mapIssue(data.issue) : null
  }

  async comment(ticketId: string, body: string, dedupeKey?: string): Promise<string | null> {
    if (dedupeKey) {
      // Skip if a bot comment carrying this key already exists (crash-retry).
      try {
        const q = `query($id:String!){ issue(id:$id){ comments(first:50){ nodes{ body url } } } }`
        const ex = await this.gql<{ issue: { comments: { nodes: { body: string; url: string }[] } } }>(q, { id: ticketId })
        const hit = (ex.issue?.comments?.nodes || []).find((c) => (c.body || '').includes(`tlk:${dedupeKey}`))
        if (hit) {
          log.info(`skipping duplicate comment (already posted, key ${dedupeKey})`)
          return hit.url
        }
      } catch {
        /* if the check fails, fall through and post */
      }
    }
    const footer = BOT_MARKER + (dedupeKey ? `\n<!-- tlk:${dedupeKey} -->` : '')
    const m = `
      mutation Comment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success comment { url }
        }
      }`
    const data = await this.gql<{ commentCreate: { comment: { url: string } } }>(m, {
      issueId: ticketId,
      body: body + footer,
    })
    return data.commentCreate?.comment?.url ?? null
  }
}

function mapIssue(n: any): Ticket {
  const comments: TicketComment[] = (n.comments?.nodes || []).map((c: any) => ({
    id: c.id,
    body: c.body || '',
    authorName: c.user?.name || 'Unknown',
    createdAt: c.createdAt || '',
    isBot: isBotComment(c.body || ''),
  }))
  comments.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
  return {
    id: n.id,
    identifier: n.identifier,
    title: n.title,
    description: n.description || '',
    url: n.url,
    state: n.state?.name || '',
    team: n.team?.key,
    projectName: n.project?.name,
    labels: (n.labels?.nodes || []).map((l: any) => l.name),
    updatedAt: n.updatedAt,
    comments,
  }
}
