import type { Ticket, TrackerConfig } from '../../types.js'
import type { Tracker } from './tracker.js'
import { log } from '../../logger.js'

// Sample tickets for demo mode — a mix of a client question and small changes.
const SAMPLE: Ticket[] = [
  {
    id: 'mock-1',
    identifier: 'DEMO-101',
    title: 'Why does my session expire after 15 minutes?',
    description:
      'Client asks: I keep getting logged out on mobile. Is this expected? ' +
      'Can you explain how the session timeout works?',
    url: 'https://linear.app/demo/issue/DEMO-101',
    state: 'Todo',
    labels: ['simple', 'question'],
    team: 'DEMO',
    projectName: 'demo-app',
    updatedAt: '2026-01-01T00:00:00Z',
    comments: [
      {
        id: 'c1',
        body: 'Also — it seems different when using Google sign-in. Is that related?',
        authorName: 'Client',
        createdAt: '2026-01-01T01:00:00Z',
        isBot: false,
      },
    ],
  },
  {
    id: 'mock-2',
    identifier: 'DEMO-102',
    title: 'Change submit button label to "立即提交"',
    description: 'On the apply page, the submit button should read 立即提交 instead of 提交.',
    url: 'https://linear.app/demo/issue/DEMO-102',
    state: 'Todo',
    labels: ['simple', 'copy'],
    team: 'DEMO',
    projectName: 'demo-app',
    updatedAt: '2026-01-01T00:00:00Z',
    comments: [],
  },
  {
    id: 'mock-3',
    identifier: 'DEMO-103',
    title: 'Increase card padding on dashboard tiles',
    description: 'The dashboard stat cards feel cramped — bump the padding one step.',
    url: 'https://linear.app/demo/issue/DEMO-103',
    state: 'Todo',
    labels: ['simple', 'ui'],
    team: 'DEMO',
    projectName: 'demo-app',
    updatedAt: '2026-01-01T00:00:00Z',
    comments: [],
  },
]

export class MockTracker implements Tracker {
  constructor(private _tc: TrackerConfig) {}
  async listCandidates(): Promise<Ticket[]> {
    return SAMPLE
  }
  async getTicket(id: string): Promise<Ticket | null> {
    return SAMPLE.find((t) => t.id === id || t.identifier === id) || null
  }
  async comment(ticketId: string, body: string, _dedupeKey?: string): Promise<string | null> {
    log.info(`[mock] comment on ${ticketId}:\n${body.slice(0, 400)}`)
    return `https://linear.app/demo/issue/${ticketId}#comment-mock`
  }
}
