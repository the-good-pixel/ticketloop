import { useCurrentFrame } from 'remotion'
import { COLORS } from '../theme'

type Event =
	| { t: number; type: 'move'; x: number; y: number }
	| { t: number; type: 'click'; x: number; y: number }

type Props = {
	events: Event[]
	fps: number
	skipMs?: number
	easeMs?: number
	start?: { x: number; y: number }
}

function easeInOutCubic(t: number) {
	return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

export const Cursor = ({ events, fps, skipMs = 0, easeMs = 600, start = { x: 960, y: 900 } }: Props) => {
	const frame = useCurrentFrame()
	const nowMs = (frame / fps) * 1000 + skipMs

	const moves = events.filter((e) => e.type === 'move') as Array<Extract<Event, { type: 'move' }>>
	if (moves.length === 0) return null

	let prev = { x: start.x, y: start.y, t: -Infinity }
	let next = moves[0]
	for (let i = 0; i < moves.length; i++) {
		if (moves[i].t <= nowMs) {
			prev = moves[i]
			next = moves[i + 1] ?? moves[i]
		}
	}

	let x = prev.x
	let y = prev.y
	if (next && next.t > prev.t) {
		const segStart = next.t - easeMs
		const progress = (nowMs - segStart) / easeMs
		if (progress > 0 && progress <= 1) {
			const eased = easeInOutCubic(progress)
			x = prev.x + (next.x - prev.x) * eased
			y = prev.y + (next.y - prev.y) * eased
		} else if (progress > 1) {
			x = next.x
			y = next.y
		}
	}

	const firstEventT = moves[0].t - easeMs
	if (nowMs < firstEventT) return null

	return (
		<>
			{events
				.filter((e) => e.type === 'click')
				.map((e, i) => {
					const elapsed = nowMs - e.t
					if (elapsed < 0 || elapsed > 700) return null
					const progress = elapsed / 700
					const scale = 0.4 + progress * 2.6
					const opacity = 1 - progress
					return (
						<div
							key={`ripple-${i}`}
							style={{
								position: 'absolute',
								left: e.x,
								top: e.y,
								width: 48,
								height: 48,
								marginLeft: -24,
								marginTop: -24,
								borderRadius: '50%',
								border: `3px solid ${COLORS.tealDeep}`,
								transform: `scale(${scale})`,
								opacity,
								pointerEvents: 'none',
							}}
						/>
					)
				})}

			<svg
				width="28"
				height="36"
				viewBox="0 0 28 36"
				style={{
					position: 'absolute',
					left: x - 2,
					top: y - 2,
					pointerEvents: 'none',
					filter: 'drop-shadow(0 2px 4px rgba(20,20,20,0.35))',
				}}
			>
				<path
					d="M 2 2 L 2 24 L 8 19 L 12 28 L 16 26 L 12 17 L 20 17 Z"
					fill="white"
					stroke={COLORS.ink}
					strokeWidth={1.5}
					strokeLinejoin="round"
				/>
			</svg>
		</>
	)
}
