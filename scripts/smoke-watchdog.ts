import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createStageWatchdog, stageTimeoutMessage } from '../src/runner/watchdog.js'

const events: string[] = []
const idle = createStageWatchdog(0, 0.08, (kind) => events.push(kind))
await delay(50)
idle.touch()
await delay(50)
assert.deepEqual(events, [])
await delay(50)
assert.deepEqual(events, ['idle'])
assert.match(stageTimeoutMessage('idle', { stageIdleTimeoutSec: 30 }), /saved checkpoint/)

const wall = createStageWatchdog(0.05, 1, (kind) => events.push(kind))
await delay(80)
assert.deepEqual(events, ['idle', 'wall-clock'])
wall.clear()

const cleared = createStageWatchdog(0, 0.04, (kind) => events.push(kind))
cleared.clear()
await delay(70)
assert.deepEqual(events, ['idle', 'wall-clock'])

console.log('stage watchdog smoke passed')
