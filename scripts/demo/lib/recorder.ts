import fs from 'node:fs'

export type CursorEvent =
	| { t: number; type: 'move'; x: number; y: number }
	| { t: number; type: 'click'; x: number; y: number }
	| {
			t: number
			type: 'spotlight'
			x: number
			y: number
			w: number
			h: number
			duration: number
			label?: string
	  }

export class EventRecorder {
	private t0 = 0
	private started = false
	events: CursorEvent[] = []

	start() {
		this.t0 = Date.now()
		this.started = true
	}

	private now() {
		if (!this.started) throw new Error('EventRecorder.start() not called')
		return Date.now() - this.t0
	}

	move(x: number, y: number) {
		this.events.push({ t: this.now(), type: 'move', x, y })
	}

	click(x: number, y: number) {
		this.events.push({ t: this.now(), type: 'click', x, y })
	}

	spotlight(
		region: { x: number; y: number; w: number; h: number },
		opts: { duration?: number; label?: string } = {},
	) {
		this.events.push({
			t: this.now(),
			type: 'spotlight',
			x: region.x,
			y: region.y,
			w: region.w,
			h: region.h,
			duration: opts.duration ?? 1600,
			label: opts.label,
		})
	}

	save(path: string, meta: { viewport: { width: number; height: number } }) {
		fs.writeFileSync(path, JSON.stringify({ ...meta, events: this.events }, null, 2))
	}
}
