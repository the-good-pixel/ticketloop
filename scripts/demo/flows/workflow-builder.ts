import type { Locator, Page } from 'playwright'
import type { EventRecorder } from '../lib/recorder.ts'
import { hideDevChrome, killOverlays, scrollAndSpotlight } from '../lib/spotlight.ts'

export const name = 'workflow-builder'

async function clickWithCursor(page: Page, rec: EventRecorder, target: Locator) {
	const box = await target.boundingBox()
	if (!box) throw new Error('Demo target is not visible')
	const x = box.x + box.width / 2
	const y = box.y + box.height / 2
	rec.move(x, y)
	await page.mouse.move(x, y)
	await page.waitForTimeout(320)
	rec.click(x, y)
	await target.click({ timeout: 3000 })
}

export async function run(page: Page, rec: EventRecorder) {
	await hideDevChrome(page)
	await page.goto('/#activity', { waitUntil: 'domcontentloaded' })
	await page.getByRole('heading', { name: 'Activity' }).waitFor({ timeout: 8000 })
	await page.locator('#feed .ticket').first().waitFor({ timeout: 8000 })
	await killOverlays(page)
	await page.waitForTimeout(700)

	await scrollAndSpotlight(page, rec, page.locator('#feed .ticket').first(), {
		label: 'activity',
		wide: true,
		wideX: 115,
		wideW: 1690,
		hold: 2300,
	})

	const projects = page.getByRole('tab', { name: 'Projects' })
	await clickWithCursor(page, rec, projects)
	await page.getByRole('heading', { name: 'Projects' }).waitFor({ timeout: 4000 })
	await page.locator('.project-workflow-row').first().waitFor({ timeout: 4000 })
	await page.waitForTimeout(500)
	await scrollAndSpotlight(page, rec, page.locator('.project-card').first(), {
		label: 'project',
		wide: true,
		wideX: 115,
		wideW: 1690,
		hold: 2300,
	})

	const workflows = page.getByRole('tab', { name: 'Workflows' })
	await clickWithCursor(page, rec, workflows)
	await page.getByRole('heading', { name: 'Workflow builder' }).waitFor({ timeout: 5000 })
	await page.locator('.wf-canvas svg').waitFor({ timeout: 8000 })
	await page.waitForTimeout(900)
	await page.locator('.wf-canvas').evaluate((element) => {
		const rect = element.getBoundingClientRect()
		window.scrollBy({ top: rect.top - 185, left: 0, behavior: 'instant' })
	})
	await page.waitForTimeout(420)
	const canvas = await page.locator('.wf-canvas').boundingBox()
	if (!canvas) throw new Error('Workflow canvas is not visible')
	rec.spotlight({
		x: Math.max(70, canvas.x - 8),
		y: Math.max(170, canvas.y - 8),
		w: Math.min(1780, canvas.width + 16),
		h: Math.min(535, canvas.height + 16),
	}, { duration: 2600, label: 'workflow' })
	await page.waitForTimeout(2600)
	await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }))
	await page.waitForTimeout(420)

	const edit = page.getByRole('button', { name: /Edit for|Edit workflow/ }).first()
	await clickWithCursor(page, rec, edit)
	await page.locator('#viewWorkflows.is-editing').waitFor({ timeout: 5000 })
	await page.locator('[data-node="triage"]').first().waitFor({ timeout: 5000 })
	await clickWithCursor(page, rec, page.locator('[data-node="triage"]').first())
	await page.locator('#nodeOverlay:not([hidden])').waitFor({ timeout: 5000 })
	await page.waitForTimeout(600)
	const drawer = await page.locator('.wf-node-drawer').boundingBox()
	if (!drawer) throw new Error('Step editor is not visible')
	rec.spotlight({
		x: drawer.x - 10,
		y: Math.max(55, drawer.y - 10),
		w: drawer.width + 20,
		h: Math.min(680, drawer.height + 20),
	}, { duration: 2500, label: 'step-editor' })
	await page.waitForTimeout(2500)
}
