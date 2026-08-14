import type { Locator, Page } from 'playwright'
import type { EventRecorder } from './recorder.ts'

// ── Hide local dev overlays (build-time clocks, devtools widgets, etc.) ──────
// CRITICAL recording rules baked in here:
//  • NO *named* nested functions inside evaluate/addInitScript — esbuild's
//    keep-names injects __name(...) which is undefined in the page (ReferenceError).
//    Only anonymous arrows and `const` non-function vars are safe.
//  • NO setInterval in addInitScript/evaluate — a persistent timer blocks
//    Playwright's video finalisation and produces a 0-byte webm. Use a
//    MutationObserver instead.
//  • A persistent <style>{display:none} survives re-renders better than removing
//    the node (which some components re-mount). The observer re-appends the style.
const KILL_SEL =
	'.version-indicator,[class*="devtools"],[id*="devtools"],[data-v-inspector-container]'

export async function hideDevChrome(page: Page, extraSelector = '') {
	const sel = extraSelector ? `${KILL_SEL},${extraSelector}` : KILL_SEL
	await page.addInitScript((s) => {
		const style = document.createElement('style')
		style.id = '__demo_hide'
		style.textContent = s + '{display:none !important;visibility:hidden !important;opacity:0 !important}'
		;(document.head || document.documentElement).appendChild(style)
		new MutationObserver(() => {
			if (!style.isConnected) (document.head || document.documentElement).appendChild(style)
			document.querySelectorAll(s).forEach((el) => el.remove())
		}).observe(document.documentElement, { childList: true, subtree: true })
	}, sel)
}

// Call AFTER the target content has rendered and again right before an on-camera
// interaction — page hydration can flicker overlays back in for a few frames.
export async function killOverlays(page: Page, extraSelector = '') {
	const sel = extraSelector ? `${KILL_SEL},${extraSelector}` : KILL_SEL
	await page.evaluate((s) => {
		if (!document.getElementById('__demo_hide')) {
			const style = document.createElement('style')
			style.id = '__demo_hide'
			style.textContent = s + '{display:none !important;visibility:hidden !important;opacity:0 !important}'
			;(document.head || document.documentElement).appendChild(style)
		}
		document.querySelectorAll(s).forEach((el) => el.remove())
	}, sel)
}

// ── Accurate spotlight ring ─────────────────────────────────────────────────
// Scroll *instantly* (never 'smooth') so the page is static both when the bbox
// is captured AND while the ring is shown — this is THE fix for rings that drift
// off their element. The element is placed at `ratio` of viewport height
// (default 0.42) to stay clear of the bottom chyron band (~760-1080 at 1080h).
//   wide      → ring spans the centred content column (wideX/wideW), not the
//               element's own narrow width.
//   extraTop  → grow the ring UP (e.g. to wrap a number circle above a label).
//   extraH    → grow the ring DOWN (e.g. to cover a paragraph below a heading).
//   noScroll  → for fixed/modal elements; don't window-scroll.
export async function scrollAndSpotlight(
	page: Page,
	rec: EventRecorder,
	locator: Locator,
	opts: {
		duration?: number
		label?: string
		pad?: number
		hold?: number
		settle?: number
		wide?: boolean
		ratio?: number
		noScroll?: boolean
		extraH?: number
		extraTop?: number
		wideX?: number
		wideW?: number
	} = {},
) {
	const pad = opts.pad ?? 10
	const hold = opts.hold ?? 2200
	const ratio = opts.ratio ?? 0.42

	if (!opts.noScroll) {
		await locator
			.evaluate((el, r) => {
				const rect = el.getBoundingClientRect()
				const target = window.innerHeight * (r as number)
				window.scrollBy({ top: rect.top + rect.height / 2 - target, left: 0, behavior: 'instant' as ScrollBehavior })
			}, ratio)
			.catch(() => {})
	}
	await page.waitForTimeout(opts.settle ?? 420)

	const box = await locator.boundingBox()
	if (box) {
		const top = opts.extraTop ?? 0
		const h = box.height + pad * 2 + top + (opts.extraH ?? 0)
		const region = opts.wide
			? { x: opts.wideX ?? 360, y: box.y - pad - top, w: opts.wideW ?? 1200, h }
			: { x: box.x - pad, y: box.y - pad - top, w: box.width + pad * 2, h }
		rec.spotlight(region, { duration: opts.duration ?? hold, label: opts.label })
	}
	await page.waitForTimeout(hold)
}

// Caption-only beat: drives a chyron with NO visible ring (emit the spotlight
// off-screen). Use for "walk-through" steps where a circle would be noise.
export function captionOnly(rec: EventRecorder, hold = 1800, label = '') {
	rec.spotlight({ x: -20000, y: 0, w: 10, h: 10 }, { duration: hold, label })
}
