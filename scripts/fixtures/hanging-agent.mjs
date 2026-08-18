#!/usr/bin/env node

// A provider fixture that stays alive without producing output. The runner's
// idle watchdog must terminate its process group and return an error result.
process.stdin.resume()
setInterval(() => {}, 60_000)
