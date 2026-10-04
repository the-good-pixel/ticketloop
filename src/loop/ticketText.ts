import type { Ticket } from '../types.js'

export function ticketBlock(t: Ticket): string {
  return `Ticket ${t.identifier}: ${t.title}\n\nDescription:\n${t.description || '(none)'}\nLink: ${t.url}`
}

export function commentThread(t: Ticket): string {
  const cs = t.comments || []
  if (!cs.length) return ''
  const lines = cs.map((c) => {
    const who = c.isBot ? `${c.authorName} (ticketloop)` : c.authorName
    return `- ${who}: ${c.body}`
  })
  return `Comment thread (oldest first):\n${lines.join('\n')}`
}

