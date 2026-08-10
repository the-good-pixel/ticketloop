// Minimal leveled logger with timestamps. No deps.
type Level = 'debug' | 'info' | 'warn' | 'error'

const COLORS: Record<Level, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
}
const RESET = '\x1b[0m'

const order: Level[] = ['debug', 'info', 'warn', 'error']
let threshold: Level = (process.env.TICKETLOOP_LOG as Level) || 'info'

function should(l: Level): boolean {
  return order.indexOf(l) >= order.indexOf(threshold)
}

function ts(): string {
  return new Date().toISOString().slice(11, 19)
}

function emit(l: Level, msg: string, ...rest: unknown[]) {
  if (!should(l)) return
  const color = COLORS[l]
  const line = `${color}${ts()} ${l.toUpperCase().padEnd(5)}${RESET} ${msg}`
  const out = l === 'error' || l === 'warn' ? console.error : console.log
  out(line, ...rest)
}

export const log = {
  setLevel(l: Level) {
    threshold = l
  },
  debug: (m: string, ...r: unknown[]) => emit('debug', m, ...r),
  info: (m: string, ...r: unknown[]) => emit('info', m, ...r),
  warn: (m: string, ...r: unknown[]) => emit('warn', m, ...r),
  error: (m: string, ...r: unknown[]) => emit('error', m, ...r),
}
