import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ticket } from '../types.js'

// ---- re-processing signal --------------------------------------------------

/**
 * The timestamp of the newest NON-bot comment (ISO string, or '' if none).
 * Re-processing triggers only when this advances — i.e. a genuinely NEW human
 * comment was added. Editing/typo-fixing an existing comment or the description
 * does NOT change it, so it won't wrongly re-run a ticket (or a shipped PR).
 * Bot comments are excluded so the loop's own replies never re-trigger it.
 */
export function latestHumanActivity(t: Ticket): string {
  let latest = ''
  for (const c of t.comments || []) {
    if (c.isBot) continue
    if (c.createdAt > latest) latest = c.createdAt
  }
  return latest
}

// ---- images ----------------------------------------------------------------

const IMG_RE = /https?:\/\/[^\s)"']+\.(?:png|jpe?g|gif|webp)(?:\?[^\s)"']*)?/gi
const LINEAR_UPLOAD_RE = /https?:\/\/uploads\.linear\.app\/[^\s)"']+/gi

export function extractImageUrls(t: Ticket): string[] {
  const texts = [t.description, ...(t.comments || []).map((c) => c.body)]
  const urls = new Set<string>()
  for (const text of texts) {
    for (const m of text.matchAll(IMG_RE)) urls.add(m[0])
    for (const m of text.matchAll(LINEAR_UPLOAD_RE)) urls.add(m[0])
  }
  return [...urls]
}

/**
 * Download ticket images to a local dir (auth via the tracker key for private
 * Linear uploads) so the model can read them with its file tools. Returns the
 * local file paths; failures are skipped, not fatal.
 */
export async function downloadImages(
  urls: string[],
  key: string,
  destDir: string,
): Promise<string[]> {
  if (!urls.length) return []
  mkdirSync(destDir, { recursive: true })
  const paths: string[] = []
  let i = 0
  for (const url of urls) {
    i++
    try {
      const res = await fetch(url, { headers: key ? { Authorization: key } : {} })
      if (!res.ok) continue
      const buf = Buffer.from(await res.arrayBuffer())
      const ct = res.headers.get('content-type') || ''
      const isImg = /^image\//.test(ct) || /\.(png|jpe?g|gif|webp)(?:\?|$)/i.test(url)
      // Non-image uploads (e.g. a .env of DB creds, a CSV) keep a readable name +
      // extension so the model treats them as files, not images.
      const ext = isImg ? extFor(url, ct) : /(text|json|csv|xml|yaml|octet-stream)/.test(ct) ? '.txt' : '.dat'
      const p = join(destDir, `${isImg ? 'image' : 'attachment'}-${i}${ext}`)
      writeFileSync(p, buf)
      paths.push(p)
    } catch {
      /* skip unreachable image */
    }
  }
  return paths
}

function extFor(url: string, contentType: string | null): string {
  const m = url.match(/\.(png|jpe?g|gif|webp)(?:\?|$)/i)
  if (m) return '.' + m[1].toLowerCase().replace('jpeg', 'jpg')
  if (contentType?.includes('png')) return '.png'
  if (contentType?.includes('gif')) return '.gif'
  if (contentType?.includes('webp')) return '.webp'
  return '.jpg'
}
