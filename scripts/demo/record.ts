import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { BASE_URL, DESKTOP, OUTPUT_DIR } from './config.ts'
import { EventRecorder } from './lib/recorder.ts'
import * as workflowBuilder from './flows/workflow-builder.ts'

const FLOWS: Record<string, { name: string; run: (p: any, r: EventRecorder) => Promise<void> }> = {
	[workflowBuilder.name]: workflowBuilder,
}

async function recordFlow(flow: (typeof FLOWS)[string]) {
	fs.mkdirSync(OUTPUT_DIR, { recursive: true })
	const videoDir = path.join(OUTPUT_DIR, `tmp-${flow.name}`)
	fs.mkdirSync(videoDir, { recursive: true })
	const browser = await chromium.launch({ headless: true })
	const context = await browser.newContext({
		viewport: DESKTOP.viewport,
		baseURL: BASE_URL,
		recordVideo: { dir: videoDir, size: DESKTOP.videoSize },
		deviceScaleFactor: DESKTOP.deviceScaleFactor,
	})
	const page = await context.newPage()
	const rec = new EventRecorder()
	rec.start()
	console.log(`Recording flow: ${flow.name}`)
	await flow.run(page, rec)
	await page.close()
	await context.close()
	await browser.close()

	const produced = fs.readdirSync(videoDir).find((f) => f.endsWith('.webm'))
	if (!produced) throw new Error('No video output produced (a 0-byte webm means a setInterval or hang during recording)')
	fs.renameSync(path.join(videoDir, produced), path.join(OUTPUT_DIR, `${flow.name}.webm`))
	fs.rmSync(videoDir, { recursive: true, force: true })
	rec.save(path.join(OUTPUT_DIR, `${flow.name}.events.json`), { viewport: DESKTOP.viewport })
	console.log(`→ output/${flow.name}.webm + .events.json (${rec.events.length} events)`)
}

async function main() {
	const targets = process.argv.slice(2).filter((a) => !a.startsWith('--'))
	for (const name of targets.length ? targets : Object.keys(FLOWS)) {
		const flow = FLOWS[name]
		if (!flow) {
			console.error(`Unknown flow: ${name}. Available: ${Object.keys(FLOWS).join(', ')}`)
			process.exit(1)
		}
		await recordFlow(flow)
	}
}
main().catch((e) => {
	console.error(e)
	process.exit(1)
})
